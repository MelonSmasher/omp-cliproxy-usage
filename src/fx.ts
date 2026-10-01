// Display-only currency conversion. Every amount is computed and stored in
// USD; this module only converts at the latest rate from cliproxy-costs `fx`
// when text is rendered. Rates registered with omp never pass through here.
import type { FxResponse, FxSource, FxStatus } from "./contract";

const CODE = /^[A-Z]{3}$/;

export interface CurrencyView {
	/** Currency amounts are shown in. */
	currency: string;
	/** Units of `currency` per 1 USD (1 for USD). */
	rate: number;
	source: FxSource | undefined;
	status: FxStatus | undefined;
	/** ECB reference date, when the rate came from the ECB. */
	asOf: string | null;
	/** Rates come from the local snapshot because CPA was unreachable. */
	fromCache: boolean;
	/** Currency that was asked for but has no rate; amounts fell back to USD. */
	missing: string | undefined;
}

export const USD_VIEW: CurrencyView = {
	currency: "USD",
	rate: 1,
	source: undefined,
	status: undefined,
	asOf: null,
	fromCache: false,
	missing: undefined,
};

/**
 * Pick the display currency: the `currency` setting, else the CPA's
 * `display_currency`, else USD. A currency without a rate falls back to USD
 * and is reported in `missing`; it is never shown at a rate of 1.
 */
export function currencyView(setting: string, fx: FxResponse | null, fromCache = false): CurrencyView {
	const fromCpa = fx && CODE.test(fx.display_currency) ? fx.display_currency : undefined;
	const wanted = setting || fromCpa || "USD";
	const meta = fx ? { source: fx.source, status: fx.status, asOf: fx.as_of, fromCache } : {};
	if (wanted === "USD") return { ...USD_VIEW, ...meta };
	const rate = fx?.rates[wanted];
	if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
		return { ...USD_VIEW, ...meta, currency: wanted, rate };
	}
	return { ...USD_VIEW, ...meta, missing: wanted };
}

const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, digits: number): Intl.NumberFormat {
	const key = `${currency}:${digits}`;
	let f = formatters.get(key);
	if (!f) {
		f = new Intl.NumberFormat(undefined, {
			style: "currency",
			currency,
			currencyDisplay: "narrowSymbol",
			minimumFractionDigits: digits,
			maximumFractionDigits: digits,
		});
		formatters.set(key, f);
	}
	return f;
}

/** Format a USD amount in the view's currency: `€1.62`, `¥12.34`, `$0.0026`, `€1,235`. */
export function formatMoney(usd: number, view: CurrencyView = USD_VIEW): string {
	const v = usd * view.rate;
	const abs = Math.abs(v);
	const digits = abs >= 100 ? 0 : abs >= 1 || v === 0 ? 2 : 4;
	return formatter(view.currency, digits).format(v);
}

/** Where the rate came from: `ECB rate 2026-09-30`, `fixed rate`, plus `, stale` / `, cached`. USD: none. */
export function rateLabel(view: CurrencyView): string | undefined {
	if (view.currency === "USD") return undefined;
	const base = view.source === "ecb" ? `ECB rate ${view.asOf ?? "unknown date"}` : "fixed rate";
	const flags = [
		view.status === "stale" || view.status === "error" ? view.status : undefined,
		view.fromCache ? "cached" : undefined,
	].filter(Boolean);
	return [base, ...flags].join(", ");
}

/** Note shown when the chosen currency has no rate. */
export function missingNote(view: CurrencyView): string | undefined {
	return view.missing ? `no ${view.missing} rate from cliproxy-costs; showing USD` : undefined;
}
