// Bun.serve mock of the cliproxy-costs data API (contract schema 1) behind
// CPA's management API, built from the vendored contract examples. Used by
// tests; also runnable standalone for manual omp checks:
//   MOCK_KEY=<32+ chars> bun test/fixtures/cpa-mock.ts
import { API_PREFIX } from "../../src/contract";
import fxFixture from "./contract/fx.json";
import quotaFixture from "./contract/quota.json";
import ratesFixture from "./contract/rates.json";
import requestsFixture from "./contract/requests.json";

const PREFIX = `${API_PREFIX}/`;

/** `forbidden`: CPA's 403 (IP blocked after wrong keys, or remote management off). */
export type Fault = "none" | "slow" | "forbidden" | "schema" | "500";

export interface MockOptions {
	/** CPA management key the mock accepts. */
	managementKey: string;
	port?: number;
	/** Rate cards by model id; defaults to the contract example. */
	rates?: typeof ratesFixture.models;
	quota?: unknown;
	/** `fx` body; defaults to the contract example. */
	fx?: unknown;
	/** trace id -> trace; unknown ids answer `pending`. */
	traces?: Record<string, unknown>;
	slowMs?: number;
}

export interface CpaMock {
	url: string;
	fault: Fault;
	/** Requests seen, as `<route>?<query>` (never headers); includes rejected ones. */
	seen: string[];
	/** Replace the mock's data at runtime. */
	options: MockOptions;
	stop(): Promise<void>;
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
	});

const error = (status: number, code: string, message: string, extra?: Record<string, string>) =>
	json(status, { schema: 1, error: { code, message } }, extra);

export function startCpaMock(options: MockOptions): CpaMock {
	const mock: CpaMock = {
		url: "",
		fault: "none",
		seen: [],
		options,
		async stop() {
			await server.stop(true);
		},
	};
	const server = Bun.serve({
		port: options.port ?? 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			// CPA itself answers unknown routes and auth failures, not in the plugin's error shape.
			if (!url.pathname.startsWith(PREFIX)) return new Response("404 page not found", { status: 404 });
			const route = url.pathname.slice(PREFIX.length);
			mock.seen.push(`${route}?${url.searchParams.toString()}`);
			if (mock.fault === "slow") await Bun.sleep(mock.options.slowMs ?? 5_000);
			if (mock.fault === "forbidden") return json(403, { error: "IP banned due to too many failed attempts. Try again later." });
			const auth = req.headers.get("authorization") ?? "";
			const m = /^bearer\s+(.+)$/i.exec(auth);
			if (!m || m[1] !== mock.options.managementKey) return json(401, { error: "invalid management key" });
			if (mock.fault === "500") return error(500, "internal", "boom");
			if (mock.fault === "schema") return json(200, { schema: 2 });
			switch (route) {
				case "rates": {
					const all = mock.options.rates ?? ratesFixture.models;
					const wanted = url.searchParams.get("models")?.split(",").filter(Boolean);
					const byId = new Map(all.map(r => [r.model, r]));
					const models = wanted
						? wanted.map(
								id =>
									byId.get(id) ?? {
										model: id,
										status: "unknown",
										catalog: null,
										resolved_by: null,
										rate_card_id: null,
										rates: null,
										tiers: [],
									},
							)
						: all;
					return json(200, { schema: 1, feed: ratesFixture.feed, models });
				}
				case "quota":
					return json(200, mock.options.quota ?? quotaFixture);
				case "fx":
					return json(200, mock.options.fx ?? fxFixture);
				case "requests": {
					const ids = (url.searchParams.get("trace_id") ?? "").split(",").filter(Boolean);
					if (ids.length === 0 || ids.length > 100) return error(400, "bad_request", "1..100 trace ids");
					const known = mock.options.traces ?? Object.fromEntries(requestsFixture.traces.map(t => [t.trace_id, t]));
					const traces = ids.map(raw => {
						const id = /^\d{14}-[0-9a-f]{16}-(.+)$/.exec(raw)?.[1] ?? raw;
						return known[id] ?? { trace_id: id, status: "pending", cost_usd: null, attempts: [] };
					});
					return json(200, { schema: 1, traces });
				}
				case "summary":
					return error(404, "not_found", "summary not mocked");
				default:
					return error(404, "not_found", "no such route");
			}
		},
	});
	mock.url = `http://127.0.0.1:${server.port}`;
	return mock;
}

if (import.meta.main) {
	const managementKey = process.env.MOCK_KEY;
	if (!managementKey || managementKey.length < 32) {
		console.error("MOCK_KEY (>= 32 chars) required");
		process.exit(1);
	}
	const mock = startCpaMock({ managementKey, port: Number(process.env.MOCK_PORT ?? 0) });
	console.log(`cpa mock on ${mock.url}`);
}
