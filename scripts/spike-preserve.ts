// Dev tool: verify that this plugin's re-registration changes nothing but cost
// on YOUR omp install and configuration.
//
// Run as an extension so it uses the omp binary's own modules:
//
//   SPIKE_PROVIDER=<provider id> SPIKE_APIKEY_ENV=<env var name of the key> \
//     omp models <provider id> --json --no-extensions -e ./scripts/spike-preserve.ts > /dev/null
//
// It reads the provider's models (extended context off, as the plugin does),
// re-registers them through the plugin's own mapping with a marker cost in a
// fresh throwaway registry (lazy and full-snapshot paths, extended context off
// and on), deep-compares every Model field except `cost`, and prints a JSON
// summary to stderr. Header VALUES are never read or printed. It registers
// nothing in the running omp.
import type { Model } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readRoster, toRegisteredModel } from "../src/roster";

const MARKER = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };

function normalize(v: unknown): unknown {
	if (typeof v === "function") return "<fn>";
	if (Array.isArray(v)) return v.map(normalize);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
		return out;
	}
	return v;
}

export default async function spikePreserve(pi: ExtensionAPI): Promise<void> {
	const provider = process.env.SPIKE_PROVIDER;
	const apiKeyEnv = process.env.SPIKE_APIKEY_ENV;
	if (!provider || !apiKeyEnv) {
		process.stderr.write("spike-preserve: set SPIKE_PROVIDER and SPIKE_APIKEY_ENV\n");
		return;
	}
	const cwd = process.cwd();
	const roster = await readRoster(pi, provider, cwd);
	const sdk = pi.pi;
	const result: Record<string, unknown> = { provider, models: roster.models.length, omp: sdk.VERSION };

	for (const extendedContext of [false, true]) {
		for (const snapshot of ["lazy", "full"] as const) {
			const settings = (await sdk.Settings.init({ cwd })).overlay({ extendedContext });
			const auth = await sdk.discoverAuthStorage(undefined, { settings });
			try {
				const registry = new sdk.ModelRegistry(auth, undefined, { settings });
				await registry.refresh("offline");
				const before = new Map(registry.getProviderModels(provider).map(m => [m.id, m]));
				const headersBefore = new Map<string, string>();
				for (const m of before.values()) {
					headersBefore.set(m.id, Object.keys((await registry.resolveModelHeaders(m)) ?? {}).sort().join(","));
				}
				if (snapshot === "full") registry.getAll("all");
				registry.registerProvider(
					provider,
					{
						baseUrl: roster.baseUrl,
						api: roster.api,
						apiKey: apiKeyEnv,
						authHeader: roster.authHeader,
						models: roster.models.map(m => toRegisteredModel(m, MARKER)),
					},
					"spike-preserve",
				);
				const after = registry.getProviderModels(provider);
				const diffs: Record<string, number> = {};
				const samples: string[] = [];
				const missing = [...before.keys()].filter(id => !after.some(a => a.id === id));
				for (const a of after) {
					const b = before.get(a.id) as Model | undefined;
					if (!b) continue;
					for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
						if (k === "cost") continue;
						const bv = JSON.stringify(normalize((b as unknown as Record<string, unknown>)[k]));
						const av = JSON.stringify(normalize((a as unknown as Record<string, unknown>)[k]));
						if (bv === av) continue;
						diffs[k] = (diffs[k] ?? 0) + 1;
						if (samples.length < 10) samples.push(`${a.id}.${k}: ${String(bv).slice(0, 120)} -> ${String(av).slice(0, 120)}`);
					}
					const names = Object.keys((await registry.resolveModelHeaders(a)) ?? {}).sort().join(",");
					if (names !== headersBefore.get(a.id)) diffs["<header names>"] = (diffs["<header names>"] ?? 0) + 1;
				}
				result[`${extendedContext ? "extended" : "standard"}/${snapshot}`] = { missing, diffs, samples };
			} finally {
				auth.close();
			}
		}
	}
	process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
}
