// Drives the real extension factory against omp's real ModelRegistry (pinned
// devDependency, throwaway agent dir from test/preload.ts) and the CPA mock.
// The `pi` object records registrations, hooks, entries and UI calls.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageProvider } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import extension from "../src/extension";
import type { RegisteredModel } from "../src/roster";
import { type CpaMock, startCpaMock } from "./fixtures/cpa-mock";
import quotaFixture from "./fixtures/contract/quota.json";
import { closedUrl, KEY } from "./helpers";

/** The contract example, observed just now. */
function freshQuota() {
	const now = Date.now();
	const cred = quotaFixture.credentials[0]!;
	return {
		...quotaFixture,
		generated_at: new Date(now).toISOString(),
		credentials: [
			{
				...cred,
				observed_at: new Date(now - 60_000).toISOString(),
				windows: cred.windows.map((w, i) => ({ ...w, resets_at: new Date(now + (i + 1) * 3_600_000).toISOString() })),
			},
		],
	};
}

const agentDir = sdk.getAgentDir();
if (!agentDir.startsWith(os.tmpdir())) throw new Error("test/preload.ts isolation missing");
const dataDir = path.join(agentDir, "plugins-data", "omp-cliproxy-usage");
// test/preload.ts redirects the omp config root; plugin settings live in <root>/plugins.
const lockfile = path.join(path.dirname(agentDir), "plugins", "omp-plugins.lock.json");
const TRACE = "01a0f377-da29-7269-bbc8-f6c7ce1ca506";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

interface Recorder {
	pi: ExtensionAPI;
	registrations: { name: string; config: ProviderConfig }[];
	handlers: Map<string, Handler>;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	entries: { type: string; data: unknown }[];
	warnings: string[];
}

function recorder(): Recorder {
	const r: Recorder = { pi: undefined as unknown as ExtensionAPI, registrations: [], handlers: new Map(), commands: new Map(), entries: [], warnings: [] };
	r.pi = {
		pi: sdk,
		logger: { warn: (m: string) => r.warnings.push(m), debug() {}, info() {}, error() {} },
		registerProvider: (name: string, config: ProviderConfig) => r.registrations.push({ name, config }),
		on: (event: string, handler: Handler) => r.handlers.set(event, handler),
		registerCommand: (name: string, opts: { handler: (a: string, c: unknown) => Promise<void> }) => r.commands.set(name, opts.handler),
		appendEntry: (type: string, data: unknown) => r.entries.push({ type, data }),
	} as unknown as ExtensionAPI;
	return r;
}

interface UiLog {
	status: (string | undefined)[];
	widgets: unknown[];
	notes: string[];
}

function context(entries: unknown[] = []) {
	const ui: UiLog = { status: [], widgets: [], notes: [] };
	const ctx = {
		hasUI: true,
		ui: {
			setStatus: (_k: string, t: string | undefined) => ui.status.push(t),
			setWidget: (_k: string, lines: unknown) => ui.widgets.push(lines),
			notify: (m: string) => ui.notes.push(m),
		},
		setInterval: () => 0,
		sessionManager: { getEntries: () => entries },
		modelRegistry: { authStorage: { usage: { invalidate: async () => {} } } },
	};
	return { ctx, ui };
}

async function writeConfig(providerUrl: string, settings: Record<string, unknown>) {
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:
  cpa-test:
    baseUrl: ${providerUrl}/v1
    api: openai-completions
    apiKey: CPA_TEST_KEY
    authHeader: true
    models:
      - id: gpt-6-sol
        name: GPT 6 Sol
        reasoning: true
        input: [text]
        contextWindow: 272000
        maxTokens: 64000
      - id: mystery-1
        name: Mystery
        reasoning: false
        input: [text]
        contextWindow: 32000
        maxTokens: 4000
`,
	);
	// omp caches models.yml per path for the process; each test rewrites it.
	ModelsConfigFile.invalidate();
	await fs.mkdir(path.dirname(lockfile), { recursive: true });
	await fs.writeFile(
		lockfile,
		JSON.stringify({ plugins: {}, settings: { "omp-cliproxy-usage": { provider: "cpa-test", apiKeyEnv: "CPA_TEST_KEY", ...settings } } }),
	);
}

async function allFiles(dir: string): Promise<string> {
	const names = await fs.readdir(dir, { recursive: true, withFileTypes: true });
	const parts = await Promise.all(
		names.filter(n => n.isFile()).map(n => fs.readFile(path.join(n.parentPath, n.name), "latin1").catch(() => "")),
	);
	return parts.join("\n");
}

const params = { provider: "cpa-test", credential: { type: "api_key" as const, apiKey: "inference" } };
const usageCtx = { fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init) };

describe("extension factory", () => {
	let mock: CpaMock | undefined;
	beforeEach(async () => {
		process.env.CPA_TEST_KEY = "inference-key-value";
		process.env.CLIPROXY_MANAGEMENT_KEY = KEY;
		await fs.rm(dataDir, { recursive: true, force: true });
	});
	afterEach(async () => {
		await mock?.stop();
		mock = undefined;
	});

	for (const [status, setup] of [
		[401, (_m: CpaMock) => (process.env.CLIPROXY_MANAGEMENT_KEY = "wrong-key-value-wrong-key-value")],
		[403, (m: CpaMock) => (m.fault = "forbidden")],
	] as const) {
		test(`${status} → one warning, then no CPA request from any route or poll; snapshot rates keep pricing`, async () => {
			mock = startCpaMock({ managementKey: KEY, quota: freshQuota() });
			await writeConfig(mock.url, { reconcile: true, display: "both", currency: "EUR" });
			const good = recorder();
			await extension(good.pi);
			await good.handlers.get("session_start")!({ type: "session_start" }, context().ctx); // good key: writes the rates/quota/fx snapshots
			mock.seen.length = 0;
			setup(mock);

			const r = recorder();
			await extension(r.pi);
			expect(mock.seen).toHaveLength(1); // the startup `rates` call that got the 401/403
			expect(r.registrations[0]!.config.models!.find(m => m.id === "gpt-6-sol")?.cost.input).toBe(2);

			const ticks: (() => void)[] = [];
			const sessionEntries: unknown[] = [
				{ type: "custom", customType: "cliproxy-usage/trace", data: { trace: TRACE }, timestamp: new Date(Date.now() - 1000).toISOString() },
			];
			const { ctx, ui } = context(sessionEntries);
			const polling = { ...ctx, setInterval: (fn: () => void) => ticks.push(fn) };
			await r.handlers.get("session_start")!({ type: "session_start" }, polling);
			expect(ticks).toHaveLength(1);
			for (let i = 0; i < 3; i++) {
				ticks[0]!();
				await r.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, polling);
				await (r.registrations.at(-1)!.config.usage as UsageProvider).fetchUsage(params, usageCtx);
			}
			await r.commands.get("cliproxy-usage")!("refresh", polling);
			expect(mock.seen).toHaveLength(1);

			const stopped = r.warnings.filter(w => w.includes("stopped all CPA requests"));
			expect(stopped).toHaveLength(1);
			expect(stopped[0]).toContain(status === 401 ? "management key rejected (401)" : "(403)");
			expect(r.warnings.filter(w => w.includes(`(${status})`))).toHaveLength(1);
			expect(ui.status.at(-1)).toContain("Codex 5h 42%"); // cached quota still shown
			expect(JSON.stringify([r.warnings, ui])).not.toContain(KEY);
		});
	}

	test("registers every model with CPA rates (unknown keeps cost 0) plus the quota provider, in the factory", async () => {
		mock = startCpaMock({ managementKey: KEY });
		await writeConfig(mock.url, {});
		const r = recorder();
		await extension(r.pi);

		expect(r.registrations).toHaveLength(1);
		const { name, config } = r.registrations[0]!;
		expect(name).toBe("cpa-test");
		expect(config).toMatchObject({ baseUrl: `${mock.url}/v1`, api: "openai-completions", apiKey: "CPA_TEST_KEY", authHeader: true });
		const byId = new Map((config.models as RegisteredModel[]).map(m => [m.id, m]));
		expect(byId.get("gpt-6-sol")?.cost).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
			longContext: { inputThreshold: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
		});
		expect(byId.get("gpt-6-sol")).toMatchObject({ name: "GPT 6 Sol", contextWindow: 272000, maxTokens: 64000, reasoning: true });
		expect(byId.get("mystery-1")?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const report = await (config.usage as UsageProvider).fetchUsage(params, usageCtx);
		expect(report?.limits.map(l => [l.window?.label, l.amount.usedFraction])).toEqual([
			["5 Hour", 0.42],
			["7 Day", 0.17],
		]);
		expect(r.warnings).toEqual([]);
	});

	test("apiKeyEnv unset → nothing registered, one warning, command still answers", async () => {
		mock = startCpaMock({ managementKey: KEY });
		await writeConfig(mock.url, { apiKeyEnv: "" });
		const r = recorder();
		await extension(r.pi);
		expect(r.registrations).toEqual([]);
		expect(r.warnings.filter(w => w.includes("apiKeyEnv"))).toHaveLength(1);
		const { ctx, ui } = context();
		await r.commands.get("cliproxy-usage")!("", ctx);
		expect(ui.notes[0]).toContain("apiKeyEnv");
	});

	test("CPA slow at startup → factory returns within the budget and prices from the snapshot", async () => {
		mock = startCpaMock({ managementKey: KEY, slowMs: 5_000 });
		await writeConfig(mock.url, { startupTimeoutMs: 300 });
		await extension(recorder().pi); // writes the snapshot
		mock.fault = "slow";
		const r = recorder();
		const started = performance.now();
		await extension(r.pi);
		expect(performance.now() - started).toBeLessThan(1_500);
		const priced = r.registrations[0]!.config.models!.find(m => m.id === "gpt-6-sol");
		expect(priced?.cost.input).toBe(2);
		expect(r.warnings.filter(w => w.includes("rates from snapshot"))).toHaveLength(1);
	});

	test("CPA down with no snapshot and no feed → quota-only registration, roster untouched", async () => {
		const down = await closedUrl();
		await writeConfig(down, { feedUrl: `${down}/feed.zstd` });
		const r = recorder();
		await extension(r.pi);
		expect(r.registrations).toHaveLength(1);
		expect(r.registrations[0]!.config.models).toBeUndefined();
		expect(r.registrations[0]!.config.usage).toBeDefined();
		expect(r.warnings.some(w => w.startsWith("[omp-cliproxy-usage] no rates available"))).toBe(true);
	});

	test("session: status line, reconciliation via trace entries, /cliproxy-usage report; key never leaks", async () => {
		mock = startCpaMock({ managementKey: KEY, quota: freshQuota() });
		await writeConfig(mock.url, { reconcile: true, display: "both" });
		const r = recorder();
		await extension(r.pi);
		const sessionEntries: unknown[] = [];
		const { ctx, ui } = context(sessionEntries);

		await r.handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(ui.status.at(-1)).toBe("Codex 5h 42% · 7d 17% | $?");
		expect(ui.widgets.at(-1)).toHaveLength(2);

		await r.handlers.get("after_provider_response")!(
			{ type: "after_provider_response", status: 200, headers: { "x-cpa-trace-id": `20260930175833-c0ffee00c0ffee00-${TRACE}` } },
			ctx,
		);
		// Same trace again (retry of the same response) is not persisted twice.
		await r.handlers.get("after_provider_response")!({ type: "after_provider_response", status: 200, headers: { "x-cpa-trace-id": TRACE } }, ctx);
		// Responses without the header (other providers) are ignored.
		await r.handlers.get("after_provider_response")!({ type: "after_provider_response", status: 200, headers: {} }, ctx);
		expect(r.entries).toEqual([{ type: "cliproxy-usage/trace", data: { trace: TRACE } }]);

		sessionEntries.push(
			{ type: "custom", customType: "cliproxy-usage/trace", data: { trace: TRACE }, timestamp: new Date(Date.now() - 1000).toISOString() },
			{ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "cpa-test", model: "priced-fixture", usage: { cost: { total: 0.00264 } } } },
		);
		await r.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, ctx);
		expect(ui.status.at(-1)).toBe("Codex 5h 42% · 7d 17% | $? | cpa $0.0026 (Δ +0%)");

		await r.commands.get("cliproxy-usage")!("refresh", ctx);
		const report = ui.notes.at(-1)!;
		expect(report).toMatch(/\| codex c0ffee \| 5 Hour \| 42% \| ok \| \S+Z \| \S+Z \|/);
		expect(report).toContain("Unpriced (cost 0): mystery-1");
		expect(report).toContain("rc_4f1a9c2e0b7d");
		expect(report).toContain("Traces: 1 complete, 0 pending, 0 missing");

		// Resume: a fresh process restores the trace from session entries.
		const resumed = recorder();
		await extension(resumed.pi);
		const second = context(sessionEntries);
		await resumed.handlers.get("session_start")!({ type: "session_start" }, second.ctx);
		expect(second.ui.status.at(-1)).toContain("cpa $0.0026");

		const everything = JSON.stringify([r.registrations, r.entries, ui, r.warnings, second.ui]) + (await allFiles(agentDir)) + (await allFiles(path.dirname(lockfile)));
		expect(everything).not.toContain(KEY);
	});

	test("an unchanged rate set is not re-registered on refresh; a changed card is", async () => {
		mock = startCpaMock({ managementKey: KEY });
		await writeConfig(mock.url, {});
		const r = recorder();
		await extension(r.pi);
		const { ctx } = context();
		await r.handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(r.registrations).toHaveLength(1);
		const [sol, mystery] = [
			{ model: "gpt-6-sol", status: "ok", catalog: null, resolved_by: "override", rate_card_id: "rc_changed0000", rates: { input: 3, output: 12, cache_read: 0.3, cache_write: 3 }, tiers: [] },
			{ model: "mystery-1", status: "unknown", catalog: null, resolved_by: null, rate_card_id: null, rates: null, tiers: [] },
		];
		mock.options.rates = [sol, mystery] as never;
		await r.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, ctx);
		expect(r.registrations).toHaveLength(1); // agent_end refreshes quota only
		await r.commands.get("cliproxy-usage")!("refresh", ctx);
		expect(r.registrations).toHaveLength(2);
		expect(r.registrations[1]!.config.models!.find(m => m.id === "gpt-6-sol")?.cost).toEqual({ input: 3, output: 12, cacheRead: 0.3, cacheWrite: 3 });
	});

	test("currency: status/widget/report in EUR with the rate date; registered omp costs stay USD; CPA down → fx snapshot", async () => {
		mock = startCpaMock({ managementKey: KEY, quota: freshQuota() });
		await writeConfig(mock.url, { reconcile: true, display: "both", currency: "EUR" });
		const r = recorder();
		await extension(r.pi);
		// Rates handed to omp are the USD cards, unconverted.
		expect(r.registrations[0]!.config.models!.find(m => m.id === "gpt-6-sol")?.cost.input).toBe(2);

		const sessionEntries: unknown[] = [
			{ type: "custom", customType: "cliproxy-usage/trace", data: { trace: TRACE }, timestamp: new Date(Date.now() - 1000).toISOString() },
			{ type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "cpa-test", model: "priced-fixture", usage: { cost: { total: 0.00264 } } } },
		];
		const { ctx, ui } = context(sessionEntries);
		await r.handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(ui.status.at(-1)).toBe("Codex 5h 42% · 7d 17% | $? | cpa €0.0023 (Δ +0%, ECB rate 2026-09-30)");
		expect((ui.widgets.at(-1) as string[]).at(-1)).toBe("session omp €0.0023 · cpa €0.0023 · ECB rate 2026-09-30");

		await r.commands.get("cliproxy-usage")!("", ctx);
		const report = ui.notes.at(-1)!;
		expect(report).toContain("Total: omp €0.0023 ($0.0026) · CPA €0.0023 ($0.0026)");
		expect(report).toContain("ECB rate 2026-09-30");
		expect(r.warnings).toEqual([]);

		// CPA goes away: a fresh process shows the snapshot rates, marked cached.
		await mock.stop();
		mock = undefined;
		const down = recorder();
		await extension(down.pi);
		const second = context(sessionEntries);
		await down.handlers.get("session_start")!({ type: "session_start" }, second.ctx);
		expect((second.ui.widgets.at(-1) as string[]).at(-1)).toBe("session omp €0.0023 · cpa pending · ECB rate 2026-09-30, cached");
		expect(await fs.readFile(path.join(dataDir, "fx.json"), "utf8")).not.toContain(KEY);
	});

	test("currency without a rate → USD with one warning, however often it renders", async () => {
		mock = startCpaMock({ managementKey: KEY, quota: freshQuota() });
		await writeConfig(mock.url, { reconcile: true, currency: "GBP" });
		const r = recorder();
		await extension(r.pi);
		const sessionEntries: unknown[] = [
			{ type: "custom", customType: "cliproxy-usage/trace", data: { trace: TRACE }, timestamp: new Date(Date.now() - 1000).toISOString() },
		];
		const { ctx, ui } = context(sessionEntries);
		await r.handlers.get("session_start")!({ type: "session_start" }, ctx);
		await r.handlers.get("agent_end")!({ type: "agent_end", messages: [] }, ctx);
		expect(ui.status.at(-1)).toContain("cpa $0.0026");
		expect(r.warnings.filter(w => w.includes("no GBP rate"))).toHaveLength(1);
		await r.commands.get("cliproxy-usage")!("", ctx);
		expect(ui.notes.at(-1)).toContain("No GBP rate from cliproxy-costs; showing USD.");
	});
});
