import { describe, expect, test } from "bun:test";
import type { QuotaResponse } from "../src/contract";
import { statusText, widgetLines } from "../src/ui";

const NOW = Date.parse("2026-09-30T18:00:00.000Z");

// A Claude credential with the shared weekly limit and a separate Fable weekly
// limit (cliproxy-costs window id `claude:7d_fable:10080`).
const quota: QuotaResponse = {
	schema: 1,
	generated_at: "2026-09-30T18:00:00.000Z",
	stale_after_ms: 1_800_000,
	credentials: [
		{
			credential: "aa00bb11cc22dd33",
			provider: "claude",
			label: "claude aa00bb",
			observed_at: "2026-09-30T17:59:00.000Z",
			stale: false,
			windows: [
				{ id: "claude:5h:300", label: "5 Hour", duration_ms: 18_000_000, used_percent: 6, used_fraction: 0.06, resets_at: null, status: "ok" },
				{ id: "claude:7d:10080", label: "7 Day", duration_ms: 604_800_000, used_percent: 40, used_fraction: 0.4, resets_at: null, status: "ok" },
				{ id: "claude:7d_fable:10080", label: "Fable 7 Day", duration_ms: 604_800_000, used_percent: 81, used_fraction: 0.81, resets_at: null, status: "warning" },
			],
		},
	],
};

describe("model-scoped quota windows", () => {
	test("status line keeps the Fable weekly limit separate from the shared weekly limit", () => {
		const text = statusText({ quota, quotaFromCache: false, staleAfterMs: 1_800_000, now: NOW, unpriced: false, reconcile: null });
		expect(text).toBe("Claude 5h 6% · 7d 40% · 7d fable 81%");
	});

	test("widget labels each weekly limit distinctly", () => {
		const lines = widgetLines({ quota, staleAfterMs: 1_800_000, now: NOW, reconcile: null }) ?? [];
		expect(lines.map(l => l.split(/\s+█|\s+░/)[0])).toEqual(["claude aa00bb 5h", "claude aa00bb 7d", "claude aa00bb 7d fable"]);
	});
});
