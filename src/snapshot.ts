import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type FxResponse, isFxResponse, type QuotaResponse, type RateModel } from "./contract";

/** Last-good rate cards from cliproxy-costs, keyed to one omp provider id. */
export interface RatesSnapshot {
	version: 1;
	provider: string;
	/** Base URL the cards were fetched from (a different CPA invalidates them). */
	baseUrl: string;
	fetchedAt: string;
	models: RateModel[];
}

/** Last-good quota payload, so a restarted omp can show it (marked stale) while CPA is down. */
export interface QuotaSnapshot {
	version: 1;
	provider: string;
	baseUrl: string;
	fetchedAt: string;
	quota: QuotaResponse;
}

/** Last-good display exchange rates, so a CPA outage keeps the chosen currency. */
export interface FxSnapshot {
	version: 1;
	baseUrl: string;
	fetchedAt: string;
	fx: FxResponse;
}

export interface FeedCache {
	etag: string | null;
	body: Uint8Array;
}

/**
 * Plugin data directory store. Holds only public data (rates, quota
 * percentages, exchange rates, the public pricing feed); no management key, no inference key, no request content.
 * Files are written atomically with mode 0600 inside a 0700 directory.
 */
export class SnapshotStore {
	constructor(readonly dir: string) {}

	async loadRates(provider: string, baseUrl: string): Promise<RatesSnapshot | null> {
		const snap = await this.#readJson<RatesSnapshot>("rates.json");
		if (!snap || snap.version !== 1 || snap.provider !== provider || snap.baseUrl !== baseUrl) return null;
		return Array.isArray(snap.models) ? snap : null;
	}

	async saveRates(snap: Omit<RatesSnapshot, "version">): Promise<void> {
		await this.#writeFile("rates.json", JSON.stringify({ version: 1, ...snap }));
	}

	async loadQuota(provider: string, baseUrl: string): Promise<QuotaSnapshot | null> {
		const snap = await this.#readJson<QuotaSnapshot>("quota.json");
		if (!snap || snap.version !== 1 || snap.provider !== provider || snap.baseUrl !== baseUrl) return null;
		return snap.quota && Array.isArray(snap.quota.credentials) ? snap : null;
	}

	async saveQuota(snap: Omit<QuotaSnapshot, "version">): Promise<void> {
		await this.#writeFile("quota.json", JSON.stringify({ version: 1, ...snap }));
	}

	async loadFx(baseUrl: string): Promise<FxSnapshot | null> {
		const snap = await this.#readJson<FxSnapshot>("fx.json");
		if (!snap || snap.version !== 1 || snap.baseUrl !== baseUrl) return null;
		return isFxResponse(snap.fx) ? snap : null;
	}

	async saveFx(snap: Omit<FxSnapshot, "version">): Promise<void> {
		await this.#writeFile("fx.json", JSON.stringify({ version: 1, ...snap }));
	}

	async loadFeed(url: string): Promise<FeedCache | null> {
		const meta = await this.#readJson<{ url: string; etag: string | null }>("feed.json");
		if (!meta || meta.url !== url) return null;
		try {
			return { etag: meta.etag, body: new Uint8Array(await fs.readFile(path.join(this.dir, "feed.bin"))) };
		} catch {
			return null;
		}
	}

	async saveFeed(url: string, cache: FeedCache): Promise<void> {
		await this.#writeFile("feed.bin", cache.body);
		await this.#writeFile("feed.json", JSON.stringify({ url, etag: cache.etag }));
	}

	async #readJson<T>(name: string): Promise<T | null> {
		try {
			return JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8")) as T;
		} catch {
			return null;
		}
	}

	async #writeFile(name: string, data: string | Uint8Array): Promise<void> {
		await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
		const target = path.join(this.dir, name);
		const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tmp, data, { mode: 0o600 });
		await fs.rename(tmp, target);
	}
}
