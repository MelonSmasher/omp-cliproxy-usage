import type { RateModel, Rates } from "./contract";
import { type CpaClient, CpaError, type FetchLike } from "./cpa-client";
import { loadFeed, resolveFromFeed } from "./feed";
import type { OmpCost } from "./roster";
import type { Settings } from "./settings";
import type { SnapshotStore } from "./snapshot";

export type RateSource = "cpa" | "snapshot" | "feed";

export interface RateSet {
	source: RateSource;
	/** When the cards were produced (snapshot: when they were fetched from CPA). */
	fetchedAt: string;
	/** Cards by omp model id. */
	cards: Map<string, RateModel>;
}

export interface RateResult {
	/** Null when no source produced cards (models keep their existing cost). */
	rates: RateSet | null;
	/** Human-readable reasons the chain fell back, in order (no secrets). */
	errors: string[];
}

export type PricingState = "priced" | "partial" | "unknown";

export interface PricedCost {
	cost: OmpCost;
	state: PricingState;
}

/**
 * Card → omp cost (USD / 1M tokens).
 * - unknown card: the model keeps its existing cost untouched.
 * - a bucket the card leaves unpriced keeps the model's existing value → `partial`.
 * - `longContext` comes from the lowest tier (omp supports one, applied when
 *   prompt tokens exceed the threshold, same as cliproxy-costs); a tier key
 *   that is missing inherits the base rate. A card without tiers drops any
 *   previous `longContext` so a stale tier never outlives new base rates.
 */
export function cardToCost(card: RateModel | undefined, existing: OmpCost): PricedCost {
	if (!card || card.status === "unknown" || !card.rates) return { cost: existing, state: "unknown" };
	const r: Rates = card.rates;
	let partial = false;
	const pick = (v: number | null | undefined, fallback: number): number => {
		if (typeof v === "number") return v;
		partial = true;
		return fallback;
	};
	const cost: OmpCost = {
		input: pick(r.input, existing.input),
		output: pick(r.output, existing.output),
		cacheRead: pick(r.cache_read, existing.cacheRead),
		cacheWrite: pick(r.cache_write, existing.cacheWrite),
	};
	const tier = card.tiers[0];
	if (tier) {
		cost.longContext = {
			inputThreshold: tier.above_prompt_tokens,
			input: tier.input ?? cost.input,
			output: tier.output ?? cost.output,
			cacheRead: tier.cache_read ?? cost.cacheRead,
			cacheWrite: tier.cache_write ?? cost.cacheWrite,
		};
	}
	return { cost, state: partial ? "partial" : "priced" };
}

/** Identity of a rate set for change detection: model ids + card ids (or card content when no id). */
export function rateSignature(ids: readonly string[], rates: RateSet | null): string {
	return [...ids]
		.sort()
		.map(id => {
			const card = rates?.cards.get(id);
			if (!card || card.status === "unknown") return `${id}=?`;
			return `${id}=${card.rate_card_id ?? JSON.stringify([card.rates, card.tiers])}`;
		})
		.join("\n");
}

function describeError(error: unknown): string {
	if (error instanceof CpaError) return error.message;
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
	return error instanceof Error ? error.message.split("\n")[0] ?? "error" : "error";
}

export interface RateChainDeps {
	settings: Pick<Settings, "provider" | "rates" | "feedUrl" | "aliases">;
	/** CPA root used as the snapshot key. */
	baseUrl: string;
	client: CpaClient;
	store: SnapshotStore;
	fetch: FetchLike;
	now?: () => Date;
}

/**
 * Rate source chain: cliproxy-costs `rates` → last-good snapshot (any age) →
 * Stencil feed (aliases + unique exact id). `signal` bounds every network step
 * (startup timeout); local snapshot reads still happen after it fires.
 */
export async function resolveRates(
	deps: RateChainDeps,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<RateResult> {
	const { settings, store } = deps;
	const now = deps.now ?? (() => new Date());
	const errors: string[] = [];
	if (settings.rates === "off") return { rates: null, errors };

	if (settings.rates === "cpa") {
		try {
			const res = await deps.client.rates(ids, signal);
			const models = res.models.filter(m => ids.includes(m.model));
			const fetchedAt = now().toISOString();
			try {
				await store.saveRates({ provider: settings.provider, baseUrl: deps.baseUrl, fetchedAt, models });
			} catch (error) {
				errors.push(`snapshot not saved: ${describeError(error)}`);
			}
			return { rates: { source: "cpa", fetchedAt, cards: new Map(models.map(m => [m.model, m])) }, errors };
		} catch (error) {
			errors.push(`cpa rates: ${describeError(error)}`);
		}
		const snap = await store.loadRates(settings.provider, deps.baseUrl);
		if (snap) {
			const cards = new Map(snap.models.map(m => [m.model, m]));
			return { rates: { source: "snapshot", fetchedAt: snap.fetchedAt, cards }, errors };
		}
		errors.push("no rates snapshot");
	}

	try {
		const feed = await loadFeed(settings.feedUrl, store, deps.fetch, signal);
		const models = resolveFromFeed(feed, ids, settings.aliases);
		const cards = new Map(models.map(m => [m.model, m]));
		return { rates: { source: "feed", fetchedAt: now().toISOString(), cards }, errors };
	} catch (error) {
		errors.push(`feed: ${describeError(error)}`);
	}
	return { rates: null, errors };
}
