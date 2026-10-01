import * as path from "node:path";
import type { UsageProvider } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import type { FxResponse, QuotaResponse } from "./contract";
import { CpaClient, cpaRootFromProviderUrl, type FetchLike } from "./cpa-client";
import { type CurrencyView, currencyView, missingNote } from "./fx";
import { createQuotaProvider } from "./quota";
import { cardToCost, type RateSet, rateSignature, resolveRates } from "./rates";
import { ompEstimate, parseTraceId, Reconciler, TRACE_ENTRY_TYPE, type TraceEntryData } from "./reconcile";
import { readRoster, type Roster, toRegisteredModel } from "./roster";
import { loadSettings, PLUGIN_NAME, readToken, type Settings } from "./settings";
import { SnapshotStore } from "./snapshot";
import { reportMarkdown, STATUS_KEY, statusText, WIDGET_KEY, widgetLines } from "./ui";

const SUPPORTED_OMP = /^18\.4\./;
const MAX_ERRORS = 8;
const REFRESH_TIMEOUT_MS = 10_000;
/** ECB publishes once per working day; re-read `fx` at most this often (manual refresh always does). */
const FX_TTL_MS = 15 * 60_000;

/** Shared, per-process plugin state. Holds no secrets. */
interface State {
	settings: Settings;
	/** CPA root (no `/v1`); undefined until the roster (or `baseUrl` setting) provides it. */
	baseUrl: string | undefined;
	client: CpaClient | undefined;
	store: SnapshotStore;
	roster: Roster | undefined;
	rates: RateSet | null;
	signature: string | undefined;
	unpriced: string[];
	partial: string[];
	quota: QuotaResponse | null;
	quotaFetchedAt: string | undefined;
	quotaFromCache: boolean;
	/** Display exchange rates; USD everywhere else. */
	fx: FxResponse | null;
	fxFetchedMs: number | undefined;
	fxFromCache: boolean;
	errors: string[];
	warned: Set<string>;
	reconciler: Reconciler;
}

export default async function cliproxyUsage(pi: ExtensionAPI): Promise<void> {
	const warn = (state: Pick<State, "warned">, message: string) => {
		if (state.warned.has(message)) return;
		state.warned.add(message);
		pi.logger.warn(`[${PLUGIN_NAME}] ${message}`);
	};
	const bootWarned = new Set<string>();

	const version = typeof pi.pi.VERSION === "string" ? pi.pi.VERSION : "unknown";
	if (!SUPPORTED_OMP.test(version)) {
		warn({ warned: bootWarned }, `built for omp 18.4.x, running on ${version}; verify with "omp models <provider> --json"`);
	}

	const cwd = process.cwd();
	const { settings, warnings } = await loadSettings(cwd);
	for (const w of warnings) warn({ warned: bootWarned }, w);

	const state: State = {
		settings,
		baseUrl: settings.baseUrl,
		client: undefined,
		store: new SnapshotStore(path.join(pi.pi.getAgentDir(), "plugins-data", PLUGIN_NAME)),
		roster: undefined,
		rates: null,
		signature: undefined,
		unpriced: [],
		partial: [],
		quota: null,
		quotaFetchedAt: undefined,
		quotaFromCache: false,
		fx: null,
		fxFetchedMs: undefined,
		fxFromCache: false,
		errors: [],
		warned: bootWarned,
		reconciler: new Reconciler(),
	};
	const fetchImpl: FetchLike = (input, init) => fetch(input, init);

	const recordError = (message: string) => {
		state.errors = [message, ...state.errors.filter(e => e !== message)].slice(0, MAX_ERRORS);
	};

	const makeClient = (baseUrl: string) =>
		new CpaClient({ baseUrl, token: () => readToken(state.settings), fetch: fetchImpl });

	const quotaProvider = (): UsageProvider | undefined => {
		const client = state.client;
		if (!client) return undefined;
		return createQuotaProvider({
			provider: settings.provider,
			client,
			staleAfterMs: settings.staleAfterMinutes * 60_000,
			onQuota: quota => {
				state.quota = quota;
				state.quotaFetchedAt = new Date().toISOString();
				state.quotaFromCache = false;
				void state.store
					.saveQuota({ provider: settings.provider, baseUrl: client.baseUrl, fetchedAt: state.quotaFetchedAt, quota })
					.catch(() => undefined);
			},
			onError: message => {
				recordError(message);
				warn(state, message);
			},
			fallback: async () => (await state.store.loadQuota(settings.provider, client.baseUrl))?.quota ?? null,
		});
	};

	/**
	 * Re-read the roster, recompute rates, and (re)register when the id set or
	 * any card changed. `networkBudgetMs` bounds the rate fetch only (the roster
	 * read is local).
	 */
	const syncRates = async (networkBudgetMs: number | undefined, force: boolean): Promise<void> => {
		let roster: Roster;
		try {
			roster = await readRoster(pi, settings.provider, cwd);
		} catch (error) {
			recordError(`roster read failed: ${error instanceof Error ? error.message : "error"}`);
			warn(state, "could not read the provider roster; rates not registered");
			return;
		}
		if (roster.models.length === 0) {
			// An empty or failed read must never replace a working roster.
			warn(state, `provider "${settings.provider}" has no models (check "provider" setting and models.yml); rates not registered`);
			return;
		}
		if (!state.baseUrl) state.baseUrl = cpaRootFromProviderUrl(roster.baseUrl);
		if (!state.client) state.client = makeClient(state.baseUrl);

		const ids = roster.models.map(m => m.id);
		let rates: RateSet | null = null;
		if (settings.rates !== "off") {
			const result = await resolveRates(
				{ settings, baseUrl: state.baseUrl, client: state.client, store: state.store, fetch: fetchImpl },
				ids,
				networkBudgetMs === undefined ? undefined : AbortSignal.timeout(networkBudgetMs),
			);
			rates = result.rates;
			for (const e of result.errors) recordError(e);
			if (result.errors.length > 0) {
				warn(state, rates ? `rates from ${rates.source} (${result.errors[0]})` : `no rates available (${result.errors.join("; ")})`);
			}
		}
		const signature = rateSignature(ids, rates);
		state.roster = roster;
		if (!force && signature === state.signature) return;

		const unpriced: string[] = [];
		const partial: string[] = [];
		const models = roster.models.map(m => {
			const priced = cardToCost(rates?.cards.get(m.id), m.cost);
			if (priced.state === "unknown") unpriced.push(m.id);
			else if (priced.state === "partial") partial.push(m.id);
			return toRegisteredModel(m, priced.cost);
		});
		// Only replace the roster when there is something to price; otherwise register quota alone.
		const config: ProviderConfig = rates
			? {
					baseUrl: roster.baseUrl,
					api: roster.api,
					apiKey: settings.apiKeyEnv,
					authHeader: roster.authHeader,
					models,
					usage: quotaProvider(),
				}
			: { apiKey: settings.apiKeyEnv, usage: quotaProvider() };
		try {
			pi.registerProvider(settings.provider, config);
			state.rates = rates;
			state.signature = signature;
			state.unpriced = rates ? unpriced : [];
			state.partial = partial;
		} catch (error) {
			recordError(`registration failed: ${error instanceof Error ? error.message : "error"}`);
			warn(state, "provider registration with rates failed; registering quota only");
			registerUsageOnly();
		}
	};

	const registerUsageOnly = () => {
		if (!state.client && state.baseUrl) state.client = makeClient(state.baseUrl);
		const usage = quotaProvider();
		if (!usage) {
			warn(state, 'no CPA URL known (set "baseUrl" or fix "provider"); quota disabled');
			return;
		}
		try {
			pi.registerProvider(settings.provider, { apiKey: settings.apiKeyEnv, usage });
		} catch (error) {
			recordError(`usage registration failed: ${error instanceof Error ? error.message : "error"}`);
		}
	};

	// ---- factory-time registration (omp models / omp usage never emit session_start) ----
	if (!settings.apiKeyEnv) {
		warn(state, 'setting "apiKeyEnv" is unset: rates and quota are disabled (see README)');
	} else {
		if (!readToken(settings) && settings.rates === "cpa") {
			warn(state, `read token env var ${settings.tokenEnv} is not set; using snapshot/feed rates and no quota`);
		}
		await syncRates(settings.startupTimeoutMs, true);
		if (!state.roster?.models.length) registerUsageOnly();
	}

	// ---- session hooks ----
	const refreshQuota = async () => {
		if (!state.client) return;
		try {
			const quota = await state.client.quota();
			state.quota = quota;
			state.quotaFetchedAt = new Date().toISOString();
			state.quotaFromCache = false;
			await state.store
				.saveQuota({ provider: settings.provider, baseUrl: state.client.baseUrl, fetchedAt: state.quotaFetchedAt, quota })
				.catch(() => undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : "quota fetch failed";
			recordError(message);
			warn(state, message);
			if (!state.quota) {
				const snap = await state.store.loadQuota(settings.provider, state.client.baseUrl);
				if (snap) {
					state.quota = snap.quota;
					state.quotaFetchedAt = snap.fetchedAt;
				}
			}
			state.quotaFromCache = state.quota !== null;
		}
	};

	/** Display-only rates; on failure keep the last good copy, else the snapshot. Not fetched when `currency` is USD. */
	const refreshFx = async (force = false) => {
		if (!state.client || settings.currency === "USD") return;
		if (!force && state.fx && !state.fxFromCache && state.fxFetchedMs !== undefined && Date.now() - state.fxFetchedMs < FX_TTL_MS) return;
		try {
			const fx = await state.client.fx();
			state.fx = fx;
			state.fxFetchedMs = Date.now();
			state.fxFromCache = false;
			await state.store
				.saveFx({ baseUrl: state.client.baseUrl, fetchedAt: new Date(state.fxFetchedMs).toISOString(), fx })
				.catch(() => undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : "fx fetch failed";
			recordError(message);
			// Without a `currency` setting, a CPA lacking `fx` (older cliproxy-costs) just means USD.
			if (settings.currency) warn(state, message);
			if (!state.fx) {
				const snap = await state.store.loadFx(state.client.baseUrl);
				if (snap) state.fx = snap.fx;
			}
			state.fxFromCache = state.fx !== null;
		}
	};

	/** Display currency for the plugin's own text; warns once when the chosen one has no rate. */
	const currentView = (): CurrencyView => {
		const view = currencyView(settings.currency, state.fx, state.fxFromCache);
		const note = missingNote(view);
		if (note) warn(state, note);
		return view;
	};

	const reconcileView = (ctx: ExtensionContext) => {
		if (!settings.reconcile) return null;
		return {
			totals: state.reconciler.totals(),
			omp: ompEstimate(ctx.sessionManager.getEntries(), settings.provider, state.reconciler.since),
		};
	};

	const render = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const now = Date.now();
		const staleAfterMs = settings.staleAfterMinutes * 60_000;
		const reconcile = reconcileView(ctx);
		const currency = currentView();
		if (settings.display === "status" || settings.display === "both") {
			ctx.ui.setStatus(
				STATUS_KEY,
				statusText({
					quota: state.quota,
					quotaFromCache: state.quotaFromCache,
					staleAfterMs,
					now,
					unpriced: state.unpriced.length > 0,
					reconcile,
					currency,
				}),
			);
		}
		if (settings.display === "widget" || settings.display === "both") {
			ctx.ui.setWidget(WIDGET_KEY, widgetLines({ quota: state.quota, staleAfterMs, now, reconcile, currency }), {
				placement: "belowEditor",
			});
		}
	};

	const reconcileNow = async (ctx: ExtensionContext) => {
		if (!settings.reconcile || !state.client || state.reconciler.pendingIds.length === 0) return;
		await state.reconciler.lookup(state.client);
		if (state.reconciler.lastError) recordError(state.reconciler.lastError);
		const drift = state.reconciler.checkDrift(reconcileView(ctx)!.omp, settings.driftWarnPct);
		if (drift !== undefined && ctx.hasUI) {
			ctx.ui.notify(
				`cliproxy: CPA recorded cost differs from omp's estimate by ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}% (see /cliproxy-usage)`,
				"warning",
			);
		}
	};

	/**
	 * omp resolves `--model` and the restored default model before extension
	 * registrations are applied, so the session can hold the pre-registration
	 * Model object (old cost) even though the registry has the priced one.
	 * Swap in the registry's current row for the same selector when its cost
	 * differs; the provider, id and every other field are unchanged.
	 */
	const rebindActiveModel = async (ctx: ExtensionContext) => {
		const active = ctx.model;
		if (!active || active.provider !== settings.provider) return;
		const current = ctx.modelRegistry.find(active.provider, active.id);
		if (!current || current === active || Bun.deepEquals(current.cost, active.cost)) return;
		try {
			await pi.setModel(current);
		} catch (error) {
			recordError(`could not apply rates to the active model: ${error instanceof Error ? error.message : "error"}`);
		}
	};

	let refreshing: Promise<void> | undefined;
	const refresh = (ctx: ExtensionContext, force = false): Promise<void> => {
		refreshing ??= (async () => {
			try {
				if (settings.apiKeyEnv) await syncRates(REFRESH_TIMEOUT_MS, force);
				await rebindActiveModel(ctx);
				await Promise.all([refreshQuota(), refreshFx(force), reconcileNow(ctx)]);
				render(ctx);
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	};

	const startSession = async (ctx: ExtensionContext) => {
		state.reconciler.reset();
		if (settings.reconcile) state.reconciler.restore(ctx.sessionManager.getEntries());
		if (!settings.apiKeyEnv || !state.client) return;
		if (ctx.hasUI && settings.display !== "off") {
			ctx.setInterval(() => void refresh(ctx), settings.refreshSeconds * 1000);
		}
		await refresh(ctx);
	};

	pi.on("session_start", async (_event, ctx) => startSession(ctx));
	pi.on("session_switch", async (_event, ctx) => {
		state.reconciler.reset();
		if (settings.reconcile) state.reconciler.restore(ctx.sessionManager.getEntries());
		render(ctx);
	});

	pi.on("after_provider_response", async event => {
		if (!settings.reconcile) return;
		// Only CPA sets this header, so its presence is the provider filter.
		const trace = parseTraceId(event.headers["x-cpa-trace-id"]);
		if (!trace || !state.reconciler.add(trace)) return;
		pi.appendEntry<TraceEntryData>(TRACE_ENTRY_TYPE, { trace });
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!settings.apiKeyEnv || !state.client) return;
		await Promise.all([refreshQuota(), refreshFx(), reconcileNow(ctx)]);
		render(ctx);
	});

	pi.registerCommand("cliproxy-usage", {
		description: "CLIProxyAPI quota, rates and session cost (arg: refresh)",
		getArgumentCompletions: prefix =>
			"refresh".startsWith(prefix) ? [{ value: "refresh", label: "refresh", description: "re-fetch quota and rates" }] : null,
		handler: async (args, ctx) => {
			if (!settings.apiKeyEnv) {
				ctx.ui.notify('cliproxy-usage: set "apiKeyEnv" first (omp plugin config set omp-cliproxy-usage apiKeyEnv <ENV_NAME>)', "warning");
				return;
			}
			if (args.trim() === "refresh") {
				// Manual refresh is the only path that discards omp's cached report.
				await ctx.modelRegistry.authStorage.usage.invalidate(settings.provider).catch(() => undefined);
				await refresh(ctx, true);
			} else {
				await Promise.all([state.quota ? undefined : refreshQuota(), refreshFx(), reconcileNow(ctx)]);
				render(ctx);
			}
			const text = reportMarkdown({
				provider: settings.provider,
				baseUrl: state.baseUrl,
				quota: state.quota,
				quotaFetchedAt: state.quotaFetchedAt,
				quotaFromCache: state.quotaFromCache,
				staleAfterMs: settings.staleAfterMinutes * 60_000,
				now: Date.now(),
				rates: state.rates,
				unpricedModels: state.unpriced,
				partialModels: state.partial,
				reconcile: reconcileView(ctx),
				currency: currentView(),
				errors: state.errors,
			});
			ctx.ui.notify(text, "info");
		},
	});
}
