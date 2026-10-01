// Types and runtime guards for the cliproxy-costs data API (schema 1), served
// under CPA's management API and authenticated by CPA with the management key.
// Hand-written on purpose: the plugin has no runtime dependencies.

export const CONTRACT_SCHEMA = 1;
export const API_PREFIX = "/v0/management/cliproxy-costs/v1";

export interface Rates {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

export interface RateTier extends Rates {
	above_prompt_tokens: number;
}

export type RateStatus = "ok" | "override" | "unknown";

export interface RateModel {
	model: string;
	status: RateStatus;
	catalog: { provider: string; model: string } | null;
	resolved_by: string | null;
	rate_card_id: string | null;
	rates: Rates | null;
	tiers: RateTier[];
}

export interface FeedInfo {
	url: string;
	etag: string | null;
	fetched_at: string | null;
	status: string;
	error: string | null;
}

export interface RatesResponse {
	schema: number;
	feed: FeedInfo | null;
	models: RateModel[];
}

export type WindowStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface QuotaWindow {
	id: string;
	label: string;
	duration_ms: number;
	used_percent: number;
	used_fraction: number;
	resets_at: string | null;
	status: WindowStatus;
}

export interface QuotaCredits {
	has_credits?: boolean;
	unlimited?: boolean;
	balance?: string;
}

export interface QuotaCredential {
	credential: string;
	/** Raw CPA auth id (may contain file names or e-mail addresses); display only. */
	auth_id?: string;
	provider: string;
	label: string;
	observed_at: string;
	stale: boolean;
	plan?: string;
	windows: QuotaWindow[];
	credits?: QuotaCredits;
}

export interface QuotaResponse {
	schema: number;
	generated_at: string;
	stale_after_ms: number;
	credentials: QuotaCredential[];
}

export interface AttemptTokens {
	input: number;
	cache_read: number;
	cache_write: number;
	output: number;
	reasoning: number;
}

export interface Attempt {
	request_id: string;
	requested_at: string;
	provider: string;
	model: string;
	response_model: string | null;
	credential: string | null;
	/** Raw CPA auth id (may contain file names or e-mail addresses); display only. */
	auth_id?: string;
	client: string | null;
	stream: boolean;
	failed: boolean;
	failure_status: number | null;
	latency_ms: number | null;
	ttft_ms: number | null;
	tokens: AttemptTokens;
	cost: { total: number; input: number; cache_read: number; cache_write: number; output: number } | null;
	pricing_status: string;
	rate_card_id: string | null;
	tier: number | null;
}

export type TraceStatus = "complete" | "pending" | "expired";

export interface Trace {
	trace_id: string;
	status: TraceStatus;
	cost_usd: number | null;
	attempts: Attempt[];
}

export interface RequestsResponse {
	schema: number;
	traces: Trace[];
}

export type FxSource = "ecb" | "fixed" | "off";
export type FxStatus = "ok" | "stale" | "error" | "off";

/** `GET fx`: display-only exchange rates. Everything else in the API stays USD. */
export interface FxResponse {
	schema: number;
	base: "USD";
	source: FxSource;
	status: FxStatus;
	/** ECB reference date (`YYYY-MM-DD`); null for fixed/off. */
	as_of: string | null;
	fetched_at: string | null;
	error: string | null;
	/** Default display currency configured on the CPA side. */
	display_currency: string;
	currencies: string[];
	/** Units of the currency per 1 USD; a currency without a rate is absent. */
	rates: Record<string, number>;
}

export interface ErrorResponse {
	schema: number;
	error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Guards. They check the fields this plugin reads; unknown extra fields pass.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNullableStr = (v: unknown): v is string | null => v === null || isStr(v);
const isOptNum = (v: unknown): boolean => v === undefined || v === null || isNum(v);

function isRates(v: unknown): v is Rates {
	return (
		isObj(v) && isOptNum(v.input) && isOptNum(v.output) && isOptNum(v.cache_read) && isOptNum(v.cache_write)
	);
}

function isRateModel(v: unknown): v is RateModel {
	return (
		isObj(v) &&
		isStr(v.model) &&
		(v.status === "ok" || v.status === "override" || v.status === "unknown") &&
		isNullableStr(v.rate_card_id) &&
		(v.rates === null || isRates(v.rates)) &&
		Array.isArray(v.tiers) &&
		v.tiers.every(t => isRates(t) && isNum((t as Obj).above_prompt_tokens))
	);
}

export function isRatesResponse(v: unknown): v is RatesResponse {
	return isObj(v) && v.schema === CONTRACT_SCHEMA && Array.isArray(v.models) && v.models.every(isRateModel);
}

function isQuotaWindow(v: unknown): v is QuotaWindow {
	return (
		isObj(v) &&
		isStr(v.id) &&
		isStr(v.label) &&
		isNum(v.duration_ms) &&
		isNum(v.used_percent) &&
		isOptNum(v.used_fraction) &&
		isNullableStr(v.resets_at ?? null) &&
		isStr(v.status)
	);
}

function isQuotaCredential(v: unknown): v is QuotaCredential {
	return (
		isObj(v) &&
		isStr(v.credential) &&
		isStr(v.provider) &&
		isStr(v.label) &&
		isStr(v.observed_at) &&
		typeof v.stale === "boolean" &&
		Array.isArray(v.windows) &&
		v.windows.every(isQuotaWindow)
	);
}

export function isQuotaResponse(v: unknown): v is QuotaResponse {
	return (
		isObj(v) &&
		v.schema === CONTRACT_SCHEMA &&
		isStr(v.generated_at) &&
		isNum(v.stale_after_ms) &&
		Array.isArray(v.credentials) &&
		v.credentials.every(isQuotaCredential)
	);
}

function isAttempt(v: unknown): v is Attempt {
	return isObj(v) && isStr(v.request_id) && isStr(v.model) && isObj(v.tokens) && (v.cost === null || isObj(v.cost));
}

function isTrace(v: unknown): v is Trace {
	return (
		isObj(v) &&
		isStr(v.trace_id) &&
		(v.status === "complete" || v.status === "pending" || v.status === "expired") &&
		(v.cost_usd === null || isNum(v.cost_usd)) &&
		Array.isArray(v.attempts) &&
		v.attempts.every(isAttempt)
	);
}

export function isRequestsResponse(v: unknown): v is RequestsResponse {
	return isObj(v) && v.schema === CONTRACT_SCHEMA && Array.isArray(v.traces) && v.traces.every(isTrace);
}

export function isFxResponse(v: unknown): v is FxResponse {
	return (
		isObj(v) &&
		v.schema === CONTRACT_SCHEMA &&
		v.base === "USD" &&
		isStr(v.source) &&
		isStr(v.status) &&
		isNullableStr(v.as_of) &&
		(v.fetched_at === undefined || isNullableStr(v.fetched_at)) &&
		(v.error === undefined || isNullableStr(v.error)) &&
		isStr(v.display_currency) &&
		Array.isArray(v.currencies) &&
		v.currencies.every(isStr) &&
		isObj(v.rates) &&
		Object.values(v.rates).every(r => isNum(r) && r > 0)
	);
}

export function isErrorResponse(v: unknown): v is ErrorResponse {
	return isObj(v) && isObj(v.error) && isStr(v.error.code);
}
