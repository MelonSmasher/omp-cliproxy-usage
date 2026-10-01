import { afterEach, describe, expect, test } from "bun:test";
import type { QuotaResponse } from "../src/contract";
import { CpaClient } from "../src/cpa-client";
import { CACHED_NOTE, createQuotaProvider, PASSIVE_NOTE, quotaToReport } from "../src/quota";
import quotaFixture from "./fixtures/contract/quota.json";
import { type CpaMock, startCpaMock } from "./fixtures/cpa-mock";
import { closedUrl, KEY } from "./helpers";

const quota = quotaFixture as QuotaResponse;
const OBSERVED = Date.parse("2026-09-30T17:56:39.386Z");
const STALE_AFTER = 30 * 60_000;

const twoCredentials: QuotaResponse = {
	...quota,
	credentials: [
		...quota.credentials,
		{
			credential: "aa00bb11cc22dd33",
			provider: "claude",
			label: "claude aa00bb",
			observed_at: "2026-09-30T17:00:00.000Z",
			stale: false,
			windows: [
				{ id: "claude:5h:300", label: "5 Hour", duration_ms: 18_000_000, used_percent: 81.5, used_fraction: 0.815, resets_at: "2026-09-30T19:00:00.000Z", status: "warning" },
			],
		},
	],
};

describe("quotaToReport", () => {
	test("maps every credential × window with unique ids, scope object, usedFraction and reset time", () => {
		const report = quotaToReport(twoCredentials, { provider: "px", staleAfterMs: STALE_AFTER, now: OBSERVED + 60_000 });
		expect(report.limits.map(l => l.id)).toEqual([
			"c0ffee00c0ffee00:codex:primary:300",
			"c0ffee00c0ffee00:codex:secondary:10080",
			"aa00bb11cc22dd33:claude:5h:300",
		]);
		const [five, seven] = report.limits;
		expect(five).toMatchObject({
			label: "codex c0ffee — 5 Hour",
			scope: { provider: "px", accountId: "c0ffee00c0ffee00", windowId: "codex:primary:300", tier: "codex" },
			window: { id: "codex:primary:300", label: "5 Hour", durationMs: 18_000_000, resetsAt: Date.parse("2026-09-30T18:56:39.000Z") },
			amount: { used: 42, limit: 100, unit: "percent", usedFraction: 0.42 },
			status: "ok",
			notes: ["Observed 2026-09-30T17:56:39.386Z"],
		});
		expect(seven?.window?.durationMs).toBe(604_800_000);
		expect(seven?.amount.usedFraction).toBe(0.17);
		expect(report.notes).toEqual([PASSIVE_NOTE]);
		expect(report.metadata).toEqual({
			source: "cliproxy-costs",
			observedAt: { "c0ffee00c0ffee00": "2026-09-30T17:56:39.386Z", aa00bb11cc22dd33: "2026-09-30T17:00:00.000Z" },
		});
	});

	test("observations older than staleAfter become unknown with a Stale note; fresh ones keep their status", () => {
		// 17:56 is fresh at 18:10, 17:00 is not.
		const report = quotaToReport(twoCredentials, { provider: "px", staleAfterMs: STALE_AFTER, now: Date.parse("2026-09-30T18:10:00.000Z") });
		const claude = report.limits.find(l => l.scope.accountId === "aa00bb11cc22dd33");
		expect(claude?.status).toBe("unknown");
		expect(claude?.notes).toContain("Stale");
		expect(report.limits[0]?.status).toBe("ok");
	});

	test("CPA's own stale flag wins even when observed_at is recent", () => {
		const flagged = { ...quota, credentials: [{ ...quota.credentials[0]!, stale: true }] };
		expect(quotaToReport(flagged, { provider: "px", staleAfterMs: STALE_AFTER, now: OBSERVED }).limits[0]?.status).toBe("unknown");
	});

	test("usedFraction falls back to used_percent/100 when the payload omits it", () => {
		const cred = quota.credentials[0]!;
		const w = { ...cred.windows[0]!, used_fraction: undefined as unknown as number };
		const report = quotaToReport({ ...quota, credentials: [{ ...cred, windows: [w] }] }, { provider: "px", staleAfterMs: STALE_AFTER, now: OBSERVED });
		expect(report.limits[0]?.amount.usedFraction).toBe(0.42);
	});
});

describe("createQuotaProvider", () => {
	let mock: CpaMock | undefined;
	afterEach(async () => {
		await mock?.stop();
		mock = undefined;
	});

	const params = { provider: "px", credential: { type: "api_key" as const, apiKey: "inference-key-must-not-leak" } };
	const ctx = { fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init) };

	test("declares last-good retention and a failure backoff", () => {
		const p = createQuotaProvider({ provider: "px", client: new CpaClient({ baseUrl: "http://127.0.0.1:1", managementKey: () => KEY }), staleAfterMs: STALE_AFTER });
		expect(p.retainLastGoodOnFailure).toBe(true);
		expect(p.failureBackoffMs).toBeGreaterThan(0);
	});

	test("fetches quota with the management key, never the inference credential", async () => {
		mock = startCpaMock({ managementKey: KEY });
		let seen: QuotaResponse | undefined;
		const p = createQuotaProvider({
			provider: "px",
			client: new CpaClient({ baseUrl: mock.url, managementKey: () => KEY }),
			staleAfterMs: STALE_AFTER,
			onQuota: q => {
				seen = q;
			},
			now: () => OBSERVED,
		});
		const report = await p.fetchUsage(params, ctx);
		expect(report?.limits).toHaveLength(2);
		expect(seen?.credentials).toHaveLength(1);
		expect(JSON.stringify(report)).not.toContain("inference-key-must-not-leak");
	});

	test("missing key → null (no request); unreachable CPA → cached payload marked stale", async () => {
		mock = startCpaMock({ managementKey: KEY });
		const errors: string[] = [];
		const noToken = createQuotaProvider({
			provider: "px",
			client: new CpaClient({ baseUrl: mock.url, managementKey: () => undefined }),
			staleAfterMs: STALE_AFTER,
			onError: e => errors.push(e),
		});
		expect(await noToken.fetchUsage(params, ctx)).toBeNull();
		expect(mock.seen).toEqual([]);
		expect(errors[0]).toContain("management key not set");

		const down = createQuotaProvider({
			provider: "px",
			client: new CpaClient({ baseUrl: await closedUrl(), managementKey: () => KEY }),
			staleAfterMs: STALE_AFTER,
			fallback: async () => quota,
			now: () => OBSERVED,
		});
		const report = await down.fetchUsage(params, ctx);
		expect(report?.limits.every(l => l.status === "unknown" && l.notes?.includes("Stale"))).toBe(true);
		expect(report?.notes).toContain(CACHED_NOTE);
	});
});
