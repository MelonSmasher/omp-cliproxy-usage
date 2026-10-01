import {
	API_PREFIX,
	type FxResponse,
	isErrorResponse,
	isFxResponse,
	isQuotaResponse,
	isRatesResponse,
	isRequestsResponse,
	type QuotaResponse,
	type RatesResponse,
	type RequestsResponse,
} from "./contract";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CpaErrorKind =
	| "no_key" // management key env var unset
	| "unauthorized" // 401: wrong or missing management key
	| "forbidden" // 403: IP blocked after repeated wrong keys, or remote management disabled
	| "not_installed" // 404 with a body that is not the plugin's: plugin missing on the CPA side
	| "http" // any other non-2xx
	| "network" // connection refused, DNS, TLS…
	| "timeout"
	| "schema"; // 2xx with a body that does not match the contract

/**
 * Error raised by every data-route call. The message names the route and the
 * failure class only: never the key, never the query string, never the host
 * error text (which can echo request details).
 */
export class CpaError extends Error {
	constructor(
		readonly kind: CpaErrorKind,
		readonly route: string,
		readonly status?: number,
	) {
		super(`cliproxy-costs ${route}: ${describe(kind, status)}`);
		this.name = "CpaError";
	}
}

function describe(kind: CpaErrorKind, status: number | undefined): string {
	switch (kind) {
		case "no_key":
			return "management key not set";
		case "unauthorized":
			return "management key rejected (401)";
		case "forbidden":
			return "CPA refused management access (403): the IP is temporarily blocked after repeated wrong keys, or remote management is disabled";
		case "not_installed":
			return "route not found (404); is cliproxy-costs installed?";
		case "http":
			return `HTTP ${status ?? "error"}`;
		case "network":
			return "CPA unreachable";
		case "timeout":
			return "request timed out";
		case "schema":
			return "unexpected response shape";
	}
}

export interface CpaClientOptions {
	/** CPA root URL, e.g. `http://localhost:8317` (no trailing `/v1`). */
	baseUrl: string;
	/** Returns the CPA management key at call time (never cached by the client). */
	managementKey: () => string | undefined;
	fetch?: FetchLike;
	timeoutMs?: number;
	/** Called once, when the client stops after a 401/403. */
	onAuthFailure?: (error: CpaError) => void;
}

/**
 * Client for the cliproxy-costs data routes (`/v0/management/cliproxy-costs/v1/*`).
 *
 * CPA blocks a client IP after 5 wrong management keys and every further wrong
 * key extends the block. So until CPA has accepted the key once, requests run
 * one at a time; after the first 401 or 403 the client sends nothing more on
 * any route: every later call rethrows that error without touching the
 * network. Only a new client (plugin reload) clears it.
 */
export class CpaClient {
	readonly #baseUrl: string;
	readonly #managementKey: () => string | undefined;
	readonly #fetch: FetchLike;
	readonly #timeoutMs: number;
	readonly #onAuthFailure: ((error: CpaError) => void) | undefined;
	#authFailure: CpaError | undefined;
	/** CPA answered 2xx once, so the key is good and requests may overlap. */
	#keyAccepted = false;
	/** Tail of the one-at-a-time queue used until the key is accepted. */
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: CpaClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#managementKey = options.managementKey;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#timeoutMs = options.timeoutMs ?? 5_000;
		this.#onAuthFailure = options.onAuthFailure;
	}

	get baseUrl(): string {
		return this.#baseUrl;
	}

	/** The 401/403 that stopped this client, if any. */
	get authFailure(): CpaError | undefined {
		return this.#authFailure;
	}

	async rates(models: readonly string[], signal?: AbortSignal): Promise<RatesResponse> {
		const query = models.length > 0 ? `models=${models.map(encodeURIComponent).join(",")}` : "";
		return this.#get("rates", query, isRatesResponse, signal);
	}

	async quota(signal?: AbortSignal): Promise<QuotaResponse> {
		return this.#get("quota", "", isQuotaResponse, signal);
	}

	/** Display-only exchange rates (USD base). */
	async fx(signal?: AbortSignal): Promise<FxResponse> {
		return this.#get("fx", "", isFxResponse, signal);
	}

	/** Up to 100 trace ids per call (contract limit); callers batch. */
	async requests(traceIds: readonly string[], signal?: AbortSignal): Promise<RequestsResponse> {
		if (traceIds.length === 0 || traceIds.length > 100) throw new RangeError("requests: 1..100 trace ids");
		return this.#get("requests", `trace_id=${traceIds.map(encodeURIComponent).join(",")}`, isRequestsResponse, signal);
	}

	#get<T>(route: string, query: string, guard: (v: unknown) => v is T, signal?: AbortSignal): Promise<T> {
		if (this.#keyAccepted) return this.#send(route, query, guard, signal);
		const result = this.#queue.then(() => this.#send(route, query, guard, signal));
		this.#queue = result.catch(() => undefined);
		return result;
	}

	async #send<T>(route: string, query: string, guard: (v: unknown) => v is T, signal?: AbortSignal): Promise<T> {
		if (this.#authFailure) throw this.#authFailure;
		const key = this.#managementKey();
		if (!key) throw new CpaError("no_key", route);
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const url = `${this.#baseUrl}${API_PREFIX}/${route}${query ? `?${query}` : ""}`;
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
				signal: combined,
			});
		} catch {
			if (timeout.aborted) throw new CpaError("timeout", route);
			if (signal?.aborted) throw signal.reason;
			throw new CpaError("network", route);
		}
		if (response.status === 401 || response.status === 403) {
			// Latch on the status alone; the body is CPA's, not the plugin's.
			if (!this.#authFailure) {
				this.#authFailure = new CpaError(response.status === 401 ? "unauthorized" : "forbidden", route, response.status);
				this.#onAuthFailure?.(this.#authFailure);
			}
			throw this.#authFailure;
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = undefined;
			if (timeout.aborted) throw new CpaError("timeout", route);
		}
		if (!response.ok) {
			// CPA's own 404 (no such management route) is not plugin-shaped.
			const code = isErrorResponse(body) ? body.error.code : undefined;
			if (response.status === 404 && code !== "not_found") throw new CpaError("not_installed", route, 404);
			throw new CpaError("http", route, response.status);
		}
		this.#keyAccepted = true;
		if (!guard(body)) throw new CpaError("schema", route, response.status);
		return body;
	}
}

/** CPA root from an omp provider base URL: strips one trailing `/v1` (and slashes), keeps any path prefix. */
export function cpaRootFromProviderUrl(providerBaseUrl: string): string {
	return providerBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
