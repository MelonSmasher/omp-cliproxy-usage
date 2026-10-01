import type { RateModel, RateTier, Rates } from "./contract";
import type { FetchLike } from "./cpa-client";
import type { FeedCache, SnapshotStore } from "./snapshot";

/** Providers searched for an exact model id when no alias is configured. */
export const FEED_SEARCH_ORDER = ["anthropic", "openai", "google"] as const;

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

interface FeedCost {
	input?: unknown;
	output?: unknown;
	cache_read?: unknown;
	cache_write?: unknown;
	tiers?: unknown;
	context_over_200k?: unknown;
}

/** Parsed feed: provider -> model id -> cost block (only priced models kept). */
export type Feed = Map<string, Map<string, FeedCost>>;

/**
 * Parse the Stencil catalog (`{<provider>: {models: {<id>: {cost?}}}}`).
 * Throws when the shape drifted: no provider with at least one priced model.
 */
export function parseFeed(bytes: Uint8Array): Feed {
	let raw = bytes;
	if (ZSTD_MAGIC.every((b, i) => bytes[i] === b)) raw = Bun.zstdDecompressSync(bytes);
	if (raw.byteLength > MAX_DECODED_BYTES) throw new Error("feed too large");
	const json: unknown = JSON.parse(new TextDecoder().decode(raw));
	if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("feed: not an object");
	const feed: Feed = new Map();
	for (const [provider, entry] of Object.entries(json)) {
		const models = (entry as { models?: unknown } | null)?.models;
		if (typeof models !== "object" || models === null) continue;
		const priced = new Map<string, FeedCost>();
		for (const [id, model] of Object.entries(models)) {
			const cost = (model as { cost?: unknown } | null)?.cost;
			if (typeof cost === "object" && cost !== null) priced.set(id, cost as FeedCost);
		}
		if (priced.size > 0) feed.set(provider, priced);
	}
	if (feed.size === 0) throw new Error("feed: no priced models");
	return feed;
}

const rate = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function feedRates(c: Record<string, unknown>): Rates {
	const out: Rates = {};
	const input = rate(c.input);
	const output = rate(c.output);
	const cacheRead = rate(c.cache_read);
	const cacheWrite = rate(c.cache_write);
	if (input !== undefined) out.input = input;
	if (output !== undefined) out.output = output;
	if (cacheRead !== undefined) out.cache_read = cacheRead;
	if (cacheWrite !== undefined) out.cache_write = cacheWrite;
	return out;
}

/** Context tiers from a feed cost block; `context_over_200k` only when `tiers` is absent (same as cliproxy-costs). */
function feedTiers(cost: FeedCost): RateTier[] {
	const tiers: RateTier[] = [];
	if (Array.isArray(cost.tiers)) {
		for (const t of cost.tiers) {
			const spec = (t as { tier?: { type?: unknown; size?: unknown } } | null)?.tier;
			if (spec?.type !== "context" || typeof spec.size !== "number") continue;
			tiers.push({ above_prompt_tokens: spec.size, ...feedRates(t as Record<string, unknown>) });
		}
	} else if (typeof cost.context_over_200k === "object" && cost.context_over_200k !== null) {
		tiers.push({ above_prompt_tokens: 200_000, ...feedRates(cost.context_over_200k as Record<string, unknown>) });
	}
	return tiers.sort((a, b) => a.above_prompt_tokens - b.above_prompt_tokens);
}

/**
 * Resolve model ids against the feed: configured alias first, else the exact
 * id in exactly one of anthropic/openai/google. Ambiguous or missing → unknown.
 * `rate_card_id` stays null: only cliproxy-costs issues card ids.
 */
export function resolveFromFeed(
	feed: Feed,
	ids: readonly string[],
	aliases: ReadonlyMap<string, { provider: string; model: string }>,
): RateModel[] {
	return ids.map(id => {
		const alias = aliases.get(id);
		let ref: { provider: string; model: string } | undefined;
		let resolvedBy: string | null = null;
		if (alias) {
			if (feed.get(alias.provider)?.has(alias.model)) {
				ref = alias;
				resolvedBy = "alias";
			}
		} else {
			const hits = FEED_SEARCH_ORDER.filter(p => feed.get(p)?.has(id));
			if (hits.length === 1 && hits[0]) {
				ref = { provider: hits[0], model: id };
				resolvedBy = "search";
			}
		}
		const cost = ref ? feed.get(ref.provider)?.get(ref.model) : undefined;
		if (!ref || !cost) {
			return { model: id, status: "unknown", catalog: null, resolved_by: null, rate_card_id: null, rates: null, tiers: [] };
		}
		return {
			model: id,
			status: "ok",
			catalog: ref,
			resolved_by: resolvedBy,
			rate_card_id: null,
			rates: feedRates(cost as Record<string, unknown>),
			tiers: feedTiers(cost),
		};
	});
}

/**
 * Fetch the feed with an ETag cache in the plugin data dir. A 304 or a network
 * failure with a cached body uses the cached body; parse failures of a fresh
 * body fall back to the cached one.
 */
export async function loadFeed(
	url: string,
	store: SnapshotStore,
	fetchImpl: FetchLike,
	signal?: AbortSignal,
): Promise<Feed> {
	const cached = await store.loadFeed(url);
	const headers: Record<string, string> = { Accept: "application/zstd, application/json" };
	if (cached?.etag) headers["If-None-Match"] = cached.etag;
	let fresh: FeedCache | null = null;
	try {
		const response = await fetchImpl(url, { headers, signal });
		if (response.status === 200) {
			fresh = { etag: response.headers.get("etag"), body: new Uint8Array(await response.arrayBuffer()) };
		} else if (response.status !== 304) {
			throw new Error(`feed HTTP ${response.status}`);
		}
	} catch (error) {
		if (!cached) throw error;
	}
	if (fresh) {
		try {
			const feed = parseFeed(fresh.body);
			await store.saveFeed(url, fresh);
			return feed;
		} catch (error) {
			if (!cached) throw error;
		}
	}
	if (!cached) throw new Error("feed: no data");
	return parseFeed(cached.body);
}
