import { describe, expect, test } from "bun:test";
import { type FxResponse, isFxResponse } from "../src/contract";
import { currencyView, formatMoney, rateLabel } from "../src/fx";
import fxFixture from "./fixtures/contract/fx.json";

const fx = (over: Partial<FxResponse> = {}): FxResponse => ({ ...(fxFixture as FxResponse), ...over });

describe("contract fixture", () => {
	test("the vendored fx example passes the guard; a zero or non-USD base does not", () => {
		expect(isFxResponse(fxFixture)).toBe(true);
		expect(isFxResponse({ ...fxFixture, base: "EUR" })).toBe(false);
		expect(isFxResponse({ ...fxFixture, rates: { USD: 1, EUR: 0 } })).toBe(false);
	});
});

describe("currencyView", () => {
	test("precedence: setting > CPA display_currency > USD", () => {
		const cpaEur = fx({ display_currency: "EUR" });
		expect(currencyView("CNY", cpaEur)).toMatchObject({ currency: "CNY", rate: 6.70454 });
		expect(currencyView("", cpaEur)).toMatchObject({ currency: "EUR", rate: 0.880669 });
		expect(currencyView("", null)).toMatchObject({ currency: "USD", rate: 1, missing: undefined });
		expect(currencyView("", fx())).toMatchObject({ currency: "USD", rate: 1 });
	});

	test("a currency without a rate falls back to USD and says so; never shown at rate 1", () => {
		const view = currencyView("GBP", fx());
		expect(view).toMatchObject({ currency: "USD", rate: 1, missing: "GBP" });
		expect(formatMoney(2, view)).toBe("$2.00");
		// Same when CPA is unreachable and nothing is cached.
		expect(currencyView("EUR", null)).toMatchObject({ currency: "USD", missing: "EUR" });
		// A CPA whose display default lacks a rate also falls back.
		expect(currencyView("", fx({ display_currency: "JPY" }))).toMatchObject({ currency: "USD", missing: "JPY" });
	});
});

describe("formatMoney", () => {
	test("converts USD at the view rate with the narrow symbol", () => {
		const eur = currencyView("EUR", fx());
		const cny = currencyView("CNY", fx());
		expect(formatMoney(1.84, eur)).toBe("€1.62");
		expect(formatMoney(1.84, cny)).toBe("¥12.34");
		expect(formatMoney(0.00264, eur)).toBe("€0.0023");
		expect(formatMoney(200, cny)).toBe("¥1,341");
		expect(formatMoney(0, eur)).toBe("€0.00");
		expect(formatMoney(0.00264)).toBe("$0.0026");
	});
});

describe("rateLabel", () => {
	test("names the ECB date, fixed source, and stale/cached state; none for USD", () => {
		expect(rateLabel(currencyView("EUR", fx()))).toBe("ECB rate 2026-09-30");
		expect(rateLabel(currencyView("EUR", fx({ status: "stale" }), true))).toBe("ECB rate 2026-09-30, stale, cached");
		expect(rateLabel(currencyView("EUR", fx({ source: "fixed", as_of: null })))).toBe("fixed rate");
		expect(rateLabel(currencyView("USD", fx()))).toBeUndefined();
	});
});
