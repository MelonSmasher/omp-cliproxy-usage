import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export const PLUGIN_NAME = "omp-cliproxy-usage";
export const DEFAULT_FEED_URL = "https://catalog.stencil.so/models.json.zstd";

export type RatesMode = "cpa" | "feed" | "off";
export type DisplayMode = "status" | "widget" | "both" | "off";

export interface Settings {
	provider: string;
	baseUrl: string | undefined;
	tokenEnv: string;
	apiKeyEnv: string | undefined;
	rates: RatesMode;
	feedUrl: string;
	/** Parsed `aliases` setting: model id -> { provider, model } in the feed. */
	aliases: Map<string, { provider: string; model: string }>;
	reconcile: boolean;
	display: DisplayMode;
	staleAfterMinutes: number;
	refreshSeconds: number;
	startupTimeoutMs: number;
	driftWarnPct: number;
	/** ISO 4217 display currency; "" = the CPA's `display_currency`. Display only; omp costs stay USD. */
	currency: string;
}

export const DEFAULTS: Readonly<Omit<Settings, "aliases">> = {
	provider: "cliproxy",
	baseUrl: undefined,
	tokenEnv: "CLIPROXY_USAGE_TOKEN",
	apiKeyEnv: undefined,
	rates: "cpa",
	feedUrl: DEFAULT_FEED_URL,
	reconcile: false,
	display: "status",
	staleAfterMinutes: 30,
	refreshSeconds: 60,
	startupTimeoutMs: 1500,
	driftWarnPct: 10,
	currency: "",
};

interface NumberRule {
	min: number;
	max?: number;
}

const NUMBER_RULES: Record<"staleAfterMinutes" | "refreshSeconds" | "startupTimeoutMs" | "driftWarnPct", NumberRule> = {
	staleAfterMinutes: { min: 1 },
	refreshSeconds: { min: 15 },
	startupTimeoutMs: { min: 100, max: 10_000 },
	driftWarnPct: { min: 0 },
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;
const RATES_VALUES: readonly RatesMode[] = ["cpa", "feed", "off"];
const DISPLAY_VALUES: readonly DisplayMode[] = ["status", "widget", "both", "off"];

export interface ResolvedSettings {
	settings: Settings;
	/** One message per rejected value; the default was used instead. */
	warnings: string[];
}

/**
 * Apply defaults and validation to raw plugin settings (as stored by
 * `omp plugin config set`). Invalid values fall back to the default and
 * produce a warning that names the key but never echoes the value.
 */
export function resolveSettings(raw: Record<string, unknown>): ResolvedSettings {
	const warnings: string[] = [];
	const reject = (key: string, why: string) => warnings.push(`setting "${key}" ignored: ${why}; using default`);

	const str = (key: "provider" | "feedUrl", fallback: string): string => {
		const v = raw[key];
		if (v === undefined) return fallback;
		if (typeof v === "string" && v.trim() !== "") return v.trim();
		reject(key, "expected a non-empty string");
		return fallback;
	};
	const envName = (key: "tokenEnv" | "apiKeyEnv"): string | undefined => {
		const v = raw[key];
		if (v === undefined || v === "") return DEFAULTS[key];
		if (typeof v === "string" && ENV_NAME.test(v.trim())) return v.trim();
		reject(key, "expected an environment variable name");
		return DEFAULTS[key];
	};
	const num = (key: keyof typeof NUMBER_RULES): number => {
		const v = raw[key];
		if (v === undefined) return DEFAULTS[key];
		const rule = NUMBER_RULES[key];
		const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
		if (typeof n === "number" && Number.isFinite(n) && n >= rule.min && (rule.max === undefined || n <= rule.max)) {
			return n;
		}
		reject(key, rule.max === undefined ? `expected a number >= ${rule.min}` : `expected ${rule.min}..${rule.max}`);
		return DEFAULTS[key];
	};

	let baseUrl: string | undefined;
	if (raw.baseUrl !== undefined && raw.baseUrl !== "") {
		const parsed = typeof raw.baseUrl === "string" ? URL.parse(raw.baseUrl.trim()) : null;
		if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
			baseUrl = parsed.href.replace(/\/+$/, "");
		} else {
			reject("baseUrl", "expected an http(s) URL");
		}
	}

	let rates = DEFAULTS.rates;
	if (raw.rates !== undefined) {
		if (RATES_VALUES.includes(raw.rates as RatesMode)) rates = raw.rates as RatesMode;
		else reject("rates", `expected one of ${RATES_VALUES.join("|")}`);
	}

	let display = DEFAULTS.display;
	if (raw.display !== undefined) {
		if (DISPLAY_VALUES.includes(raw.display as DisplayMode)) display = raw.display as DisplayMode;
		else reject("display", `expected one of ${DISPLAY_VALUES.join("|")}`);
	}

	let reconcile = DEFAULTS.reconcile;
	if (raw.reconcile !== undefined) {
		if (typeof raw.reconcile === "boolean") reconcile = raw.reconcile;
		else if (raw.reconcile === "true" || raw.reconcile === "false") reconcile = raw.reconcile === "true";
		else reject("reconcile", "expected a boolean");
	}

	const aliases = new Map<string, { provider: string; model: string }>();
	if (raw.aliases !== undefined && raw.aliases !== "") {
		const parsed = parseAliases(raw.aliases);
		if (parsed) for (const [k, v] of parsed) aliases.set(k, v);
		else reject("aliases", 'expected a JSON object of "<model>": "<provider>/<model>"');
	}

	let currency = DEFAULTS.currency;
	if (raw.currency !== undefined && raw.currency !== "") {
		if (typeof raw.currency === "string" && CURRENCY_CODE.test(raw.currency.trim())) currency = raw.currency.trim().toUpperCase();
		else reject("currency", "expected a 3-letter ISO 4217 code");
	}

	const feedUrl = str("feedUrl", DEFAULTS.feedUrl);
	if (!URL.canParse(feedUrl)) reject("feedUrl", "expected a URL");

	return {
		settings: {
			provider: str("provider", DEFAULTS.provider),
			baseUrl,
			tokenEnv: envName("tokenEnv") ?? DEFAULTS.tokenEnv,
			apiKeyEnv: envName("apiKeyEnv"),
			rates,
			feedUrl: URL.canParse(feedUrl) ? feedUrl : DEFAULTS.feedUrl,
			aliases,
			reconcile,
			display,
			staleAfterMinutes: num("staleAfterMinutes"),
			refreshSeconds: num("refreshSeconds"),
			startupTimeoutMs: num("startupTimeoutMs"),
			driftWarnPct: num("driftWarnPct"),
			currency,
		},
		warnings,
	};
}

function parseAliases(value: unknown): Map<string, { provider: string; model: string }> | null {
	let obj: unknown = value;
	if (typeof value === "string") {
		try {
			obj = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
	const out = new Map<string, { provider: string; model: string }>();
	for (const [model, target] of Object.entries(obj)) {
		if (typeof target !== "string") return null;
		const slash = target.indexOf("/");
		if (slash <= 0 || slash === target.length - 1) return null;
		out.set(model, { provider: target.slice(0, slash), model: target.slice(slash + 1) });
	}
	return out;
}

/** Read global + project plugin settings from omp and resolve them. */
export async function loadSettings(cwd: string): Promise<ResolvedSettings> {
	return resolveSettings(await getPluginSettings(PLUGIN_NAME, cwd));
}

/** The read token, read from the environment on every call; never stored. */
export function readToken(s: Pick<Settings, "tokenEnv">): string | undefined {
	const value = process.env[s.tokenEnv];
	return value && value.trim() !== "" ? value.trim() : undefined;
}
