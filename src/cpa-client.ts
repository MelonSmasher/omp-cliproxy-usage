import {
	type FxResponse,
	isErrorResponse,
	isFxResponse,
	isQuotaResponse,
	isRatesResponse,
	isRequestsResponse,
	READ_API_PREFIX,
	type QuotaResponse,
	type RatesResponse,
	type RequestsResponse,
} from "./contract";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CpaErrorKind =
	| "no_token" // token env var unset
	| "unauthorized" // 401
	| "disabled" // 503 read_api_disabled
	| "not_installed" // 404 on the route: plugin missing on the CPA side
	| "http" // any other non-2xx
	| "network" // connection refused, DNS, TLS…
	| "timeout"
	| "schema"; // 2xx with a body that does not match the contract

/**
 * Error raised by every read-route call. The message names the route and the
 * failure class only: never the token, never the query string, never the host
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
		case "no_token":
			return "read token not set";
		case "unauthorized":
			return "read token rejected (401)";
		case "disabled":
			return "read API disabled on the CPA side (503)";
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
	/** Returns the read token at call time (never cached by the client). */
	token: () => string | undefined;
	fetch?: FetchLike;
	timeoutMs?: number;
}

/** Client for the cliproxy-costs read routes (`/v0/resource/plugins/cliproxy-costs/api/v1/*`). */
export class CpaClient {
	readonly #baseUrl: string;
	readonly #token: () => string | undefined;
	readonly #fetch: FetchLike;
	readonly #timeoutMs: number;

	constructor(options: CpaClientOptions) {
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#token = options.token;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#timeoutMs = options.timeoutMs ?? 5_000;
	}

	get baseUrl(): string {
		return this.#baseUrl;
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

	async #get<T>(route: string, query: string, guard: (v: unknown) => v is T, signal?: AbortSignal): Promise<T> {
		const token = this.#token();
		if (!token) throw new CpaError("no_token", route);
		const timeout = AbortSignal.timeout(this.#timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const url = `${this.#baseUrl}${READ_API_PREFIX}/${route}${query ? `?${query}` : ""}`;
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: "GET",
				headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
				signal: combined,
			});
		} catch {
			if (timeout.aborted) throw new CpaError("timeout", route);
			if (signal?.aborted) throw signal.reason;
			throw new CpaError("network", route);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			body = undefined;
			if (timeout.aborted) throw new CpaError("timeout", route);
		}
		if (!response.ok) {
			const code = isErrorResponse(body) ? body.error.code : undefined;
			if (response.status === 401) throw new CpaError("unauthorized", route, 401);
			if (response.status === 503 && code === "read_api_disabled") throw new CpaError("disabled", route, 503);
			if (response.status === 404 && code !== "not_found") throw new CpaError("not_installed", route, 404);
			throw new CpaError("http", route, response.status);
		}
		if (!guard(body)) throw new CpaError("schema", route, response.status);
		return body;
	}
}

/** CPA root from an omp provider base URL: strips one trailing `/v1` (and slashes), keeps any path prefix. */
export function cpaRootFromProviderUrl(providerBaseUrl: string): string {
	return providerBaseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}
