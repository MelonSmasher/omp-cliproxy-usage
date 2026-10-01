// Runs omp's real ModelRegistry (pinned devDependency) against a temporary
// agent dir: reads the roster the way the extension does, re-registers every
// model with a new cost, and checks that nothing but cost changed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as sdk from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { cardToCost } from "../src/rates";
import { readRoster, toRegisteredModel } from "../src/roster";

const MODELS_YML = `providers:
  px:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: PX_TEST_KEY
    authHeader: true
    models:
      - id: chat-a
        name: Chat A
        reasoning: true
        input: [text, image]
        contextWindow: 272000
        maxTokens: 64000
        thinking: { mode: effort, efforts: [low, medium, high] }
      - id: image-b
        name: Image B
        reasoning: false
        input: [text]
        contextWindow: 8000
        maxTokens: 1000
        supportsTools: false
      - id: plain-c
        reasoning: false
        input: [text]
`;

const normalize = (v: unknown): unknown => {
	if (typeof v === "function") return "<fn>";
	if (Array.isArray(v)) return v.map(normalize);
	if (v && typeof v === "object") {
		return Object.fromEntries(
			Object.keys(v)
				.sort()
				.map(k => [k, normalize((v as Record<string, unknown>)[k])]),
		);
	}
	return v;
};

const withoutCost = (m: Model) => {
	const { cost: _cost, ...rest } = m;
	return normalize(rest);
};

describe("roster re-registration on omp 18.4.4", () => {
	// test/preload.ts points omp at a throwaway agent dir.
	const agentDir = sdk.getAgentDir();
	const pi = { pi: sdk } as unknown as ExtensionAPI;

	beforeAll(async () => {
		await fs.writeFile(path.join(agentDir, "models.yml"), MODELS_YML);
		// omp caches models.yml per path for the process; other suites write it too.
		ModelsConfigFile.invalidate();
		process.env.PX_TEST_KEY = "px-test-inference-key";
	});
	afterAll(async () => {
		await fs.rm(path.join(agentDir, "models.yml"), { force: true });
	});

	const freshRegistry = async () => {
		const settings = (await sdk.Settings.init({ cwd: agentDir })).overlay({ extendedContext: false });
		const auth = await sdk.discoverAuthStorage(undefined, { settings });
		const registry = new sdk.ModelRegistry(auth, undefined, { settings });
		await registry.refresh("offline");
		return registry;
	};

	test("readRoster returns every chat model, the provider base URL and the auth-header mode", async () => {
		const roster = await readRoster(pi, "px", agentDir);
		expect(roster.models.map(m => m.id).sort()).toEqual(["chat-a", "image-b", "plain-c"]);
		expect(roster.baseUrl).toBe("http://127.0.0.1:9/v1");
		expect(roster.api).toBe("openai-completions");
		expect(roster.authHeader).toBe(true);
		expect(await readRoster(pi, "no-such-provider", agentDir)).toMatchObject({ models: [] });
	});

	test("re-registering with toRegisteredModel changes only cost, in lazy and full-snapshot registries", async () => {
		const roster = await readRoster(pi, "px", agentDir);
		const card = {
			model: "",
			status: "ok" as const,
			catalog: null,
			resolved_by: "override",
			rate_card_id: "rc_x",
			rates: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
			tiers: [{ above_prompt_tokens: 272000, input: 4, output: 15 }],
		};
		for (const snapshot of ["lazy", "full"] as const) {
			const registry = await freshRegistry();
			const before = new Map(registry.getProviderModels("px").map(m => [m.id, m]));
			if (snapshot === "full") registry.getAll("all");
			registry.registerProvider(
				"px",
				{
					baseUrl: roster.baseUrl,
					api: roster.api,
					apiKey: "PX_TEST_KEY",
					authHeader: roster.authHeader,
					models: roster.models.map(m => toRegisteredModel(m, cardToCost(card, m.cost).cost)),
				},
				"test",
			);
			const after = registry.getProviderModels("px");
			expect(after.map(m => m.id).sort()).toEqual([...before.keys()].sort());
			for (const a of after) {
				const b = before.get(a.id)!;
				expect(withoutCost(a)).toEqual(withoutCost(b));
				expect(a.cost).toEqual({
					input: 2,
					output: 10,
					cacheRead: 0.2,
					cacheWrite: 2.5,
					longContext: { inputThreshold: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 2.5 },
				});
				// Auth header still resolves from the same key reference.
				expect(Object.keys((await registry.resolveModelHeaders(a)) ?? {})).toContain("Authorization");
			}
			expect(after.find(m => m.id === "image-b")?.supportsTools).toBe(false);
		}
	});
});
