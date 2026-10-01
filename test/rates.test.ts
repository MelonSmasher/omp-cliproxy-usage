import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RateModel } from "../src/contract";
import { CpaClient } from "../src/cpa-client";
import { parseFeed, resolveFromFeed } from "../src/feed";
import { cardToCost, rateSignature, resolveRates, type RateChainDeps } from "../src/rates";
import type { OmpCost } from "../src/roster";
import { resolveSettings } from "../src/settings";
import { SnapshotStore } from "../src/snapshot";
import ratesFixture from "./fixtures/contract/rates.json";
import { type CpaMock, startCpaMock } from "./fixtures/cpa-mock";
import { closedUrl, feedJson, TOKEN, tempDir } from "./helpers";

const ZERO: OmpCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const card = (over: Partial<RateModel>): RateModel => ({
	model: "m",
	status: "ok",
	catalog: { provider: "openai", model: "m" },
	resolved_by: "learned",
	rate_card_id: "rc_000000000000",
	rates: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
	tiers: [],
	...over,
});

describe("cardToCost", () => {
	test("maps base rates and the lowest tier to longContext, inheriting missing tier keys", () => {
		const { cost, state } = cardToCost(
			card({
				tiers: [
					{ above_prompt_tokens: 200000, input: 4, output: 15 },
					{ above_prompt_tokens: 1000000, input: 8, output: 30, cache_read: 0.8, cache_write: 10 },
				],
			}),
			ZERO,
		);
		expect(state).toBe("priced");
		expect(cost).toEqual({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 2.5,
			longContext: { inputThreshold: 200000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 2.5 },
		});
	});

	test("an unpriced bucket keeps the model's existing value and flags partial", () => {
		const existing = { input: 1, output: 1, cacheRead: 0.5, cacheWrite: 0.7 };
		const { cost, state } = cardToCost(card({ rates: { input: 2, output: 10 } }), existing);
		expect(state).toBe("partial");
		expect(cost).toEqual({ input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0.7 });
	});

	test("unknown card keeps the existing cost object, including a configured tier", () => {
		const existing: OmpCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, longContext: { inputThreshold: 5, input: 2, output: 4, cacheRead: 0, cacheWrite: 0 } };
		expect(cardToCost(card({ status: "unknown", rates: null }), existing)).toEqual({ cost: existing, state: "unknown" });
		expect(cardToCost(undefined, existing)).toEqual({ cost: existing, state: "unknown" });
	});

	test("a card without tiers drops a stale longContext", () => {
		const existing: OmpCost = { ...ZERO, longContext: { inputThreshold: 5, input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } };
		expect(cardToCost(card({}), existing).cost.longContext).toBeUndefined();
	});
});

describe("rateSignature", () => {
	test("changes when a card id changes or a model appears, not on reordering", () => {
		const set = (cards: RateModel[]) => ({ source: "cpa" as const, fetchedAt: "", cards: new Map(cards.map(c => [c.model, c])) });
		const a = rateSignature(["a", "b"], set([card({ model: "a" }), card({ model: "b", rate_card_id: "rc_1" })]));
		expect(rateSignature(["b", "a"], set([card({ model: "b", rate_card_id: "rc_1" }), card({ model: "a" })]))).toBe(a);
		expect(rateSignature(["a", "b"], set([card({ model: "a" }), card({ model: "b", rate_card_id: "rc_2" })]))).not.toBe(a);
		expect(rateSignature(["a", "b", "c"], set([card({ model: "a" }), card({ model: "b", rate_card_id: "rc_1" })]))).not.toBe(a);
	});
});

describe("feed", () => {
	const feed = parseFeed(Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(feedJson()))));

	test("unique exact id in anthropic|openai|google resolves; tiers take precedence over context_over_200k", () => {
		const [gpt, claude] = resolveFromFeed(feed, ["gpt-x", "claude-y"], new Map());
		expect(gpt).toMatchObject({ status: "ok", resolved_by: "search", catalog: { provider: "openai", model: "gpt-x" }, rate_card_id: null });
		expect(gpt?.tiers).toEqual([{ above_prompt_tokens: 272000, input: 5, output: 22.5 }]);
		expect(claude?.tiers).toEqual([{ above_prompt_tokens: 200000, input: 6, output: 22.5 }]);
	});

	test("ambiguous ids, ids outside the search providers, and bad aliases are unknown; aliases win", () => {
		const aliases = new Map([
			["shared", { provider: "anthropic", model: "shared" }],
			["broken", { provider: "openai", model: "nope" }],
		]);
		const [ambiguous, other, aliased, broken] = [
			...resolveFromFeed(feed, ["shared", "only-other"], new Map()),
			...resolveFromFeed(feed, ["shared", "broken"], aliases),
		];
		expect(ambiguous?.status).toBe("unknown");
		expect(other?.status).toBe("unknown");
		expect(aliased).toMatchObject({ status: "ok", resolved_by: "alias", rates: { input: 2, output: 2 } });
		expect(broken?.status).toBe("unknown");
	});

	test("shape drift is rejected", () => {
		expect(() => parseFeed(new TextEncoder().encode(JSON.stringify({ openai: { models: { x: {} } } })))).toThrow();
	});
});

describe("resolveRates chain", () => {
	let mock: CpaMock | undefined;
	let feedServer: Bun.Server<undefined> | undefined;
	afterEach(async () => {
		await mock?.stop();
		await feedServer?.stop(true);
		mock = undefined;
		feedServer = undefined;
	});

	const startFeed = () => {
		let hits = 0;
		feedServer = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: req => {
				hits++;
				if (req.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
				return new Response(Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(feedJson()))), { headers: { etag: '"v1"' } });
			},
		});
		return { url: `http://127.0.0.1:${feedServer.port}/models.json.zstd`, hits: () => hits };
	};

	const deps = async (baseUrl: string, raw: Record<string, unknown>, dir?: string): Promise<RateChainDeps> => {
		const { settings } = resolveSettings({ provider: "p", ...raw });
		return {
			settings,
			baseUrl,
			client: new CpaClient({ baseUrl, token: () => TOKEN, timeoutMs: 2_000 }),
			store: new SnapshotStore(dir ?? (await tempDir())),
			fetch: (i, init) => fetch(i, init),
		};
	};

	test("cpa ok → cards for the requested ids and a snapshot written without the token", async () => {
		mock = startCpaMock({ token: TOKEN });
		const d = await deps(mock.url, {});
		const { rates, errors } = await resolveRates(d, ["gpt-6-sol", "new-model"]);
		expect(errors).toEqual([]);
		expect(rates?.source).toBe("cpa");
		expect(rates?.cards.get("gpt-6-sol")?.rate_card_id).toBe("rc_4f1a9c2e0b7d");
		expect(rates?.cards.get("new-model")?.status).toBe("unknown");
		const onDisk = await fs.readFile(path.join(d.store.dir, "rates.json"), "utf8");
		expect(onDisk).toContain("rc_4f1a9c2e0b7d");
		expect(onDisk).not.toContain(TOKEN);
		expect((await fs.stat(path.join(d.store.dir, "rates.json"))).mode & 0o777).toBe(0o600);
	});

	test("cpa down → last snapshot (any age) with the failure noted", async () => {
		mock = startCpaMock({ token: TOKEN });
		const dir = await tempDir();
		const url = mock.url;
		await resolveRates(await deps(url, {}, dir), ["gpt-6-sol"]);
		await mock.stop();
		mock = undefined;
		const { rates, errors } = await resolveRates(await deps(url, {}, dir), ["gpt-6-sol"]);
		expect(rates?.source).toBe("snapshot");
		expect(rates?.cards.get("gpt-6-sol")?.rates).toEqual(ratesFixture.models[0]!.rates);
		expect(errors[0]).toContain("unreachable");
	});

	test("a snapshot from another CPA base URL is not used; the feed is, and its ETag is honored", async () => {
		mock = startCpaMock({ token: TOKEN });
		const dir = await tempDir();
		await resolveRates(await deps(mock.url, {}, dir), ["gpt-6-sol"]);
		const feed = startFeed();
		const other = await closedUrl();
		const first = await resolveRates(await deps(other, { feedUrl: feed.url }, dir), ["gpt-x", "gpt-6-sol"]);
		expect(first.rates?.source).toBe("feed");
		expect(first.rates?.cards.get("gpt-x")?.rates?.input).toBe(2.5);
		expect(first.rates?.cards.get("gpt-6-sol")?.status).toBe("unknown");
		// Second fetch sends If-None-Match and reuses the cached body on 304.
		const second = await resolveRates(await deps(other, { feedUrl: feed.url, rates: "feed" }, dir), ["gpt-x"]);
		expect(second.rates?.cards.get("gpt-x")?.rates?.input).toBe(2.5);
		expect(feed.hits()).toBe(2);
	});

	test("rates=off → no cards and no network", async () => {
		mock = startCpaMock({ token: TOKEN });
		const { rates } = await resolveRates(await deps(mock.url, { rates: "off" }), ["gpt-6-sol"]);
		expect(rates).toBeNull();
		expect(mock.seen).toEqual([]);
	});

	test("the startup budget bounds a slow CPA and the chain still falls back to the snapshot", async () => {
		mock = startCpaMock({ token: TOKEN, slowMs: 3_000 });
		const dir = await tempDir();
		await resolveRates(await deps(mock.url, {}, dir), ["gpt-6-sol"]);
		mock.fault = "slow";
		const started = performance.now();
		const { rates } = await resolveRates(await deps(mock.url, {}, dir), ["gpt-6-sol"], AbortSignal.timeout(200));
		expect(performance.now() - started).toBeLessThan(1_500);
		expect(rates?.source).toBe("snapshot");
	});
});
