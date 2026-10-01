import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** 64-hex sentinel token; tests assert it never appears in any output. */
export const TOKEN = "5e1f7c0ffee0ddba11deadbeefcafe0123456789abcdef0123456789abcdef01";

export async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-cliproxy-usage-test-"));
}

/** A URL on a port nothing listens on (bound, then released). */
export async function closedUrl(): Promise<string> {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const url = `http://127.0.0.1:${server.port}`;
	await server.stop(true);
	return url;
}

/** Minimal Stencil-shaped feed. */
export function feedJson(): Record<string, unknown> {
	return {
		openai: {
			id: "openai",
			models: {
				"gpt-x": {
					id: "gpt-x",
					cost: {
						input: 2.5,
						output: 15,
						cache_read: 0.25,
						tiers: [{ input: 5, output: 22.5, tier: { type: "context", size: 272000 } }],
						context_over_200k: { input: 5, output: 22.5 },
					},
				},
				shared: { id: "shared", cost: { input: 1, output: 1 } },
			},
		},
		anthropic: {
			id: "anthropic",
			models: {
				"claude-y": { id: "claude-y", cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, context_over_200k: { input: 6, output: 22.5 } } },
				shared: { id: "shared", cost: { input: 2, output: 2 } },
			},
		},
		other: { id: "other", models: { "only-other": { id: "only-other", cost: { input: 9, output: 9 } } } },
	};
}
