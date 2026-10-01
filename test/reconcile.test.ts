import { afterEach, describe, expect, test } from "bun:test";
import { CpaClient } from "../src/cpa-client";
import { ompEstimate, PENDING_GIVE_UP_MS, parseTraceId, Reconciler, TRACE_ENTRY_TYPE } from "../src/reconcile";
import { type CpaMock, startCpaMock } from "./fixtures/cpa-mock";
import { TOKEN } from "./helpers";

const DONE = "01a0f377-da29-7269-bbc8-f6c7ce1ca506";
const LATER = "01a0f377-0000-7000-8000-000000000000";

describe("parseTraceId", () => {
	test("takes the uuid from the full X-Cpa-Trace-Id value, passes bare ids through", () => {
		expect(parseTraceId(`20260930175833-c0ffee00c0ffee00-${DONE}`)).toBe(DONE);
		expect(parseTraceId(DONE)).toBe(DONE);
		expect(parseTraceId("  ")).toBeUndefined();
		expect(parseTraceId(undefined)).toBeUndefined();
	});
});

describe("Reconciler", () => {
	let mock: CpaMock | undefined;
	afterEach(async () => {
		await mock?.stop();
		mock = undefined;
	});

	const traceDone = {
		trace_id: DONE,
		status: "complete",
		cost_usd: 0.00264,
		attempts: [{ request_id: "r1", model: "priced-fixture", tokens: {}, cost: { total: 0.00264, input: 0, cache_read: 0, cache_write: 0, output: 0 } }],
	};

	test("complete traces are summed; pending ones are retried, never counted as zero, and give up after the window", async () => {
		mock = startCpaMock({ token: TOKEN, traces: { [DONE]: traceDone } });
		const client = new CpaClient({ baseUrl: mock.url, token: () => TOKEN });
		let now = 1_000_000;
		const r = new Reconciler(() => now);
		expect(r.add(DONE)).toBe(true);
		expect(r.add(DONE)).toBe(false);
		r.add(LATER);

		await r.lookup(client);
		expect(r.totals()).toMatchObject({ traces: 2, complete: 1, pending: 1, missing: 0, cpaUsd: 0.00264 });
		expect(r.totals().byModel.get("priced-fixture")).toBe(0.00264);
		// Only the still-pending id is asked again.
		await r.lookup(client);
		expect(mock.seen.at(-1)).toBe(`requests?trace_id=${LATER}`);

		mock.options.traces = {
			[DONE]: traceDone,
			[LATER]: { trace_id: LATER, status: "complete", cost_usd: 0.001, attempts: [] },
		};
		await r.lookup(client);
		expect(r.totals()).toMatchObject({ complete: 2, pending: 0, cpaUsd: 0.00364 });

		const late = new Reconciler(() => now);
		late.add("never-arrives");
		now += PENDING_GIVE_UP_MS + 1;
		await late.lookup(client);
		expect(late.totals()).toMatchObject({ pending: 0, missing: 1, cpaUsd: 0 });
	});

	test("lookup errors keep traces pending and surface a redacted error", async () => {
		mock = startCpaMock({ token: TOKEN });
		const r = new Reconciler();
		r.add(DONE);
		await r.lookup(new CpaClient({ baseUrl: mock.url, token: () => "wrong-token-value-wrong-token-value" }));
		expect(r.totals().pending).toBe(1);
		expect(r.lastError).toContain("401");
		expect(r.lastError).not.toContain("wrong-token-value");
	});

	test("batches more than 100 pending traces into several requests", async () => {
		mock = startCpaMock({ token: TOKEN, traces: {} });
		const r = new Reconciler();
		for (let i = 0; i < 205; i++) r.add(`t-${i}`);
		await r.lookup(new CpaClient({ baseUrl: mock.url, token: () => TOKEN }));
		expect(mock.seen.map(s => s.split("%2C").length)).toEqual([100, 100, 5]);
	});

	test("drift is reported once per session, only after every trace settled and beyond the threshold", async () => {
		mock = startCpaMock({ token: TOKEN, traces: { [DONE]: traceDone } });
		const client = new CpaClient({ baseUrl: mock.url, token: () => TOKEN });
		const r = new Reconciler();
		r.add(DONE);
		r.add(LATER);
		await r.lookup(client);
		const omp = { usd: 0.002, byModel: new Map() };
		expect(r.checkDrift(omp, 10)).toBeUndefined(); // LATER still pending
		mock.options.traces = { [DONE]: traceDone, [LATER]: { trace_id: LATER, status: "complete", cost_usd: 0, attempts: [] } };
		await r.lookup(client);
		expect(r.checkDrift({ usd: 0.0026, byModel: new Map() }, 10)).toBeUndefined(); // within 10 %
		expect(r.checkDrift(omp, 10)).toBeCloseTo(32, 5);
		expect(r.checkDrift(omp, 10)).toBeUndefined(); // once
		r.reset();
		expect(r.totals().traces).toBe(0);
	});

	// CPA contributes nothing for a missing or unpriced trace while omp still
	// counts it; a drift warning then would be false and use up the session's
	// single warning before a real one.
	test("no drift is reported while a trace is missing or unpriced, and a later real drift still is", async () => {
		const unpriced = { trace_id: LATER, status: "complete", cost_usd: null, attempts: [{ request_id: "r2", model: "free", tokens: {}, cost: null }] };
		mock = startCpaMock({ token: TOKEN, traces: { [DONE]: traceDone, [LATER]: unpriced } });
		const client = new CpaClient({ baseUrl: mock.url, token: () => TOKEN });
		const omp = { usd: 0.002, byModel: new Map() };

		const withUnpriced = new Reconciler();
		withUnpriced.add(DONE);
		withUnpriced.add(LATER);
		await withUnpriced.lookup(client);
		expect(withUnpriced.checkDrift(omp, 10)).toBeUndefined();

		let now = 1_000_000;
		const withMissing = new Reconciler(() => now);
		withMissing.add(DONE);
		withMissing.add("01a0f377-0000-7000-8000-00000000dead");
		now += PENDING_GIVE_UP_MS + 1;
		await withMissing.lookup(client);
		expect(withMissing.totals().missing).toBe(1);
		expect(withMissing.checkDrift(omp, 10)).toBeUndefined();

		// Once everything is found and priced, the warning still fires.
		const clean = new Reconciler();
		clean.add(DONE);
		await clean.lookup(client);
		expect(clean.checkDrift(omp, 10)).toBeCloseTo(32, 5);
	});

	test("restore rebuilds traces from session entries and ignores foreign ones", () => {
		const r = new Reconciler();
		r.restore([
			{ type: "custom", customType: TRACE_ENTRY_TYPE, data: { trace: DONE }, timestamp: "2026-09-30T17:58:33.000Z" },
			{ type: "custom", customType: TRACE_ENTRY_TYPE, data: { trace: DONE }, timestamp: "2026-09-30T17:59:00.000Z" },
			{ type: "custom", customType: "other/type", data: { trace: LATER } },
			{ type: "custom", customType: TRACE_ENTRY_TYPE, data: { nope: 1 } },
		]);
		expect(r.pendingIds).toEqual([DONE]);
		expect(r.since).toBe(Date.parse("2026-09-30T17:58:33.000Z"));
	});
});

describe("ompEstimate", () => {
	test("sums assistant costs on the provider from the first trace on", () => {
		const since = Date.parse("2026-09-30T18:00:00.000Z");
		const msg = (provider: string, model: string, total: number, ts: string) => ({
			type: "message",
			timestamp: ts,
			message: { role: "assistant", provider, model, usage: { cost: { total } } },
		});
		const est = ompEstimate(
			[
				msg("px", "a", 1, "2026-09-30T17:59:59.000Z"), // before the first trace
				msg("px", "a", 0.5, "2026-09-30T18:00:00.000Z"),
				msg("px", "b", 0.25, "2026-09-30T18:01:00.000Z"),
				msg("other", "a", 9, "2026-09-30T18:01:00.000Z"),
				{ type: "custom", timestamp: "2026-09-30T18:02:00.000Z" },
			],
			"px",
			since,
		);
		expect(est.usd).toBe(0.75);
		expect([...est.byModel]).toEqual([
			["a", 0.5],
			["b", 0.25],
		]);
		expect(ompEstimate([msg("px", "a", 1, "2026-09-30T18:00:00.000Z")], "px", undefined).usd).toBe(0);
	});
});
