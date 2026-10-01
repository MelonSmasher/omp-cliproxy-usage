import type { UsageLimit, UsageProvider, UsageReport, UsageStatus } from "@oh-my-pi/pi-ai";
import type { QuotaCredential, QuotaResponse, QuotaWindow } from "./contract";
import type { CpaClient } from "./cpa-client";

export const QUOTA_SOURCE = "cliproxy-costs";
export const PASSIVE_NOTE = "CPA passive observation, not a live poll";
export const CACHED_NOTE = "CPA unreachable; showing the last cached observation";

/** Upstream family shown in labels and used as `scope.tier` (the part of window id before the first `:`). */
export function windowFamily(w: Pick<QuotaWindow, "id">, c: Pick<QuotaCredential, "provider">): string {
	const i = w.id.indexOf(":");
	return i > 0 ? w.id.slice(0, i) : c.provider;
}

/**
 * Staleness is decided locally from `observed_at` so a cached/snapshot payload
 * ages correctly; CPA's own `stale` flag also counts.
 */
export function isStale(c: Pick<QuotaCredential, "observed_at" | "stale">, staleAfterMs: number, now: number): boolean {
	if (c.stale) return true;
	const observed = Date.parse(c.observed_at);
	return !Number.isFinite(observed) || now - observed > staleAfterMs;
}

function windowStatus(w: QuotaWindow, stale: boolean): UsageStatus {
	if (stale) return "unknown";
	if (w.status === "ok" || w.status === "warning" || w.status === "exhausted" || w.status === "unknown") return w.status;
	return "unknown";
}

/**
 * Map a cliproxy-costs quota payload to an omp UsageReport. One limit per
 * credential × window; ids are unique per pair; the native status segment
 * reads `amount.usedFraction`, so it is always set.
 */
export function quotaToReport(
	quota: QuotaResponse,
	opts: {
		provider: string;
		staleAfterMs: number;
		now: number;
		/** Mark every window stale (the payload is a cached copy, not a fresh fetch). */
		forceStale?: boolean;
		extraNotes?: string[];
	},
): UsageReport {
	const limits: UsageLimit[] = [];
	const observedAt: Record<string, string> = {};
	for (const c of quota.credentials) {
		observedAt[c.credential] = c.observed_at;
		const stale = opts.forceStale === true || isStale(c, opts.staleAfterMs, opts.now);
		for (const w of c.windows) {
			const resetsAt = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
			const notes = [`Observed ${c.observed_at}`];
			if (stale) notes.push("Stale");
			limits.push({
				id: `${c.credential}:${w.id}`,
				label: `${c.label} — ${w.label}`,
				scope: { provider: opts.provider, accountId: c.credential, windowId: w.id, tier: windowFamily(w, c) },
				window: {
					id: w.id,
					label: w.label,
					durationMs: w.duration_ms,
					...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
				},
				amount: {
					used: w.used_percent,
					limit: 100,
					unit: "percent",
					usedFraction: typeof w.used_fraction === "number" ? w.used_fraction : w.used_percent / 100,
				},
				status: windowStatus(w, stale),
				notes,
			});
		}
	}
	return {
		provider: opts.provider,
		fetchedAt: opts.now,
		limits,
		notes: [PASSIVE_NOTE, ...(opts.extraNotes ?? [])],
		metadata: { source: QUOTA_SOURCE, observedAt },
	};
}

export interface QuotaProviderDeps {
	provider: string;
	client: CpaClient;
	staleAfterMs: number;
	/** Called once per distinct failure message (the caller rate-limits warnings). */
	onError?: (message: string) => void;
	/** Called with every successfully fetched payload (the caller caches it). */
	onQuota?: (quota: QuotaResponse) => void;
	/** Last cached payload, served (all windows stale) when CPA cannot be reached. */
	fallback?: () => Promise<QuotaResponse | null>;
	now?: () => number;
}

/**
 * omp UsageProvider backed by cliproxy-costs `GET quota`. On failure it serves
 * the cached payload marked stale (survives restarts), else null so omp keeps
 * its in-process last good report and backs off. It never touches
 * `params.credential` (the inference key omp hands to every usage fetcher).
 */
export function createQuotaProvider(deps: QuotaProviderDeps): UsageProvider {
	const now = deps.now ?? Date.now;
	return {
		id: deps.provider,
		retainLastGoodOnFailure: true,
		failureBackoffMs: 120_000,
		async fetchUsage(params) {
			try {
				const quota = await deps.client.quota(params.signal);
				deps.onQuota?.(quota);
				return quotaToReport(quota, { provider: deps.provider, staleAfterMs: deps.staleAfterMs, now: now() });
			} catch (error) {
				deps.onError?.(error instanceof Error ? error.message : "quota fetch failed");
			}
			const cached = await deps.fallback?.().catch(() => null);
			if (!cached) return null;
			return quotaToReport(cached, {
				provider: deps.provider,
				staleAfterMs: deps.staleAfterMs,
				now: now(),
				forceStale: true,
				extraNotes: [CACHED_NOTE],
			});
		},
	};
}
