import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

/** omp's full cost shape; `longContext` survives runtime registration (verified on 18.4.4). */
export type OmpCost = Model["cost"];

/**
 * What the plugin registers per model. `ProviderModelConfig` is the public
 * type; the registry additionally accepts `supportsTools`, `tokenizer`,
 * `omitMaxOutputTokens`, `remoteCompaction`, and a `cost.longContext` tier,
 * which must be copied for the re-registered row to match the discovered one.
 */
export type RegisteredModel = Omit<ProviderModelConfig, "cost"> & {
	cost: OmpCost;
	supportsTools?: boolean;
	tokenizer?: Model["tokenizer"];
	omitMaxOutputTokens?: boolean;
	remoteCompaction?: Model["remoteCompaction"];
};

export interface Roster {
	/** Provider base URL as omp resolves it (usually ends in `/v1`). */
	baseUrl: string;
	api: Api;
	/** True when every model's resolved headers carry `Authorization`. */
	authHeader: boolean;
	models: Model[];
}

/**
 * Copy every public field of a live registry row and replace only `cost`.
 * Omitting any of these makes omp reset it to a default on re-registration
 * (`name`, `thinking`, `maxTokens`, `contextWindow`), or turns an unset
 * `supportsTools` into `false`; `compatConfig` is passed as `compat`.
 */
export function toRegisteredModel(m: Model, cost: OmpCost): RegisteredModel {
	return {
		id: m.id,
		name: m.name,
		api: m.api,
		reasoning: m.reasoning,
		thinking: m.thinking,
		input: m.input,
		cost,
		// Discovered rows may carry null limits; omp's builder treats a missing value the same way.
		contextWindow: m.contextWindow as number,
		maxTokens: m.maxTokens as number,
		preferWebsockets: m.preferWebsockets,
		headers: m.headers,
		compat: m.compatConfig,
		premiumMultiplier: m.premiumMultiplier,
		supportsTools: m.supportsTools,
		tokenizer: m.tokenizer,
		omitMaxOutputTokens: m.omitMaxOutputTokens,
		remoteCompaction: m.remoteCompaction,
	};
}

/**
 * Read the provider's current models through a throwaway registry with
 * extended context forced off, so the copied windows are the standard ones and
 * `models.yml` `maxContextWindow` still widens them when the user enables
 * extended context. Offline refresh: reads config + discovery cache only.
 * Header values are resolved transiently to learn header *names*; no value is
 * kept.
 */
export async function readRoster(pi: ExtensionAPI, provider: string, cwd: string): Promise<Roster> {
	const sdk = pi.pi;
	const settings = (await sdk.Settings.init({ cwd })).overlay({ extendedContext: false });
	const auth = await sdk.discoverAuthStorage(undefined, { settings });
	try {
		const registry = new sdk.ModelRegistry(auth, undefined, { settings });
		await registry.refresh("offline");
		const models = registry
			.getProviderModels(provider)
			.filter(m => m.kind === undefined || m.kind === "chat");
		const first = models[0];
		if (!first) return { baseUrl: "", api: "openai-completions", authHeader: false, models: [] };
		let authHeader = true;
		for (const m of models) {
			const headers = await registry.resolveModelHeaders(m);
			if (!headers || !Object.keys(headers).some(k => k.toLowerCase() === "authorization")) {
				authHeader = false;
				break;
			}
		}
		return {
			baseUrl: registry.getProviderBaseUrl(provider) ?? first.baseUrl,
			api: first.api,
			authHeader,
			models,
		};
	} finally {
		auth.close();
	}
}
