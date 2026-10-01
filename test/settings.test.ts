import { describe, expect, test } from "bun:test";
import { DEFAULTS, readToken, resolveSettings } from "../src/settings";

describe("resolveSettings", () => {
	test("empty input yields the documented defaults", () => {
		const { settings, warnings } = resolveSettings({});
		expect(warnings).toEqual([]);
		expect(settings).toMatchObject({ ...DEFAULTS, aliases: new Map() });
	});

	test("invalid values fall back to defaults with one warning each, never echoing the value", () => {
		const { settings, warnings } = resolveSettings({
			rates: "sometimes",
			display: 3,
			refreshSeconds: 5,
			startupTimeoutMs: 60_000,
			apiKeyEnv: "not an env name; secret-looking-value",
			baseUrl: "ftp://x",
			aliases: "{not json",
			reconcile: "yes",
		});
		expect(settings).toMatchObject({
			rates: "cpa",
			display: "status",
			refreshSeconds: 60,
			startupTimeoutMs: 1500,
			apiKeyEnv: undefined,
			baseUrl: undefined,
			reconcile: false,
		});
		expect(warnings).toHaveLength(8);
		expect(warnings.join("\n")).not.toContain("secret-looking-value");
	});

	test("string forms from `omp plugin config set` are accepted; baseUrl loses trailing slashes", () => {
		const { settings, warnings } = resolveSettings({
			refreshSeconds: "120",
			reconcile: "true",
			baseUrl: "https://cpa.example.com/root/",
			aliases: '{"my-model":"openai/gpt-x","b":"anthropic/claude-y"}',
		});
		expect(warnings).toEqual([]);
		expect(settings.refreshSeconds).toBe(120);
		expect(settings.reconcile).toBe(true);
		expect(settings.baseUrl).toBe("https://cpa.example.com/root");
		expect(settings.aliases.get("my-model")).toEqual({ provider: "openai", model: "gpt-x" });
	});

	test("aliases must be provider/model pairs", () => {
		expect(resolveSettings({ aliases: '{"a":"no-slash"}' }).warnings).toHaveLength(1);
		expect(resolveSettings({ aliases: '{"a":"openai/"}' }).warnings).toHaveLength(1);
	});

	test("currency: 3-letter code, upper-cased; empty means the CPA default; anything else is rejected", () => {
		expect(resolveSettings({ currency: " eur " }).settings.currency).toBe("EUR");
		expect(resolveSettings({ currency: "" }).settings.currency).toBe("");
		const bad = resolveSettings({ currency: "EURO" });
		expect(bad.settings.currency).toBe("");
		expect(bad.warnings).toHaveLength(1);
	});
});

describe("readToken", () => {
	test("reads the named env var at call time; blank means unset", () => {
		process.env.OCU_TEST_TOKEN = "  ";
		expect(readToken({ tokenEnv: "OCU_TEST_TOKEN" })).toBeUndefined();
		process.env.OCU_TEST_TOKEN = "abc";
		expect(readToken({ tokenEnv: "OCU_TEST_TOKEN" })).toBe("abc");
		delete process.env.OCU_TEST_TOKEN;
		expect(readToken({ tokenEnv: "OCU_TEST_TOKEN" })).toBeUndefined();
	});
});
