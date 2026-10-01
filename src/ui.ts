import type { QuotaCredential, QuotaResponse, QuotaWindow } from "./contract";
import { type CurrencyView, formatMoney, missingNote, rateLabel, USD_VIEW } from "./fx";
import { isStale, windowFamily } from "./quota";
import type { RateSet } from "./rates";
import type { OmpEstimate, ReconcileTotals } from "./reconcile";
import { driftPct } from "./reconcile";

export const STATUS_KEY = "cliproxy";
export const WIDGET_KEY = "cliproxy-usage";
const WIDGET_MAX_LINES = 10;
const BAR_WIDTH = 10;

/**
 * Compact window tag: 300 min → 5h, 10080 → 7d, 1440 → 1d, else minutes/hours.
 * A model-scoped window (cliproxy-costs id `claude:7d_fable:10080`) keeps its
 * scope — `7d fable` — so it stays distinct from the shared 7d limit.
 */
export function windowTag(w: Pick<QuotaWindow, "id" | "duration_ms">): string {
	const minutes = Math.round(w.duration_ms / 60_000);
	let tag: string;
	if (minutes % 1440 === 0) tag = `${minutes / 1440}d`;
	else if (minutes % 60 === 0) tag = `${minutes / 60}h`;
	else tag = `${minutes}m`;
	const scope = windowScope(w);
	return scope ? `${tag} ${scope}` : tag;
}

/** Model scope of a window id `<family>:<n><unit>_<scope>:<minutes>`, e.g. "fable"; "" for shared windows. */
function windowScope(w: Pick<QuotaWindow, "id">): string {
	const name = w.id.split(":")[1] ?? "";
	const i = name.indexOf("_");
	return i > 0 ? name.slice(i + 1).replaceAll("_", " ") : "";
}

function familyLabel(family: string): string {
	return family.length === 0 ? family : family[0]!.toUpperCase() + family.slice(1);
}

function pct(w: QuotaWindow): string {
	return `${Math.round(w.used_percent)}%`;
}

function formatDuration(ms: number): string {
	if (ms <= 0) return "now";
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

interface FamilyGroup {
	family: string;
	/** Worst (highest) usage per window tag across credentials of the family, in first-seen order. */
	windows: Map<string, QuotaWindow>;
	stale: boolean;
}

function groupByFamily(quota: QuotaResponse, staleAfterMs: number, now: number): FamilyGroup[] {
	const groups = new Map<string, FamilyGroup>();
	for (const c of quota.credentials) {
		const stale = isStale(c, staleAfterMs, now);
		for (const w of c.windows) {
			const family = windowFamily(w, c);
			let g = groups.get(family);
			if (!g) {
				g = { family, windows: new Map(), stale: false };
				groups.set(family, g);
			}
			if (stale) g.stale = true;
			const tag = windowTag(w);
			const prev = g.windows.get(tag);
			if (!prev || w.used_percent > prev.used_percent) g.windows.set(tag, w);
		}
	}
	return [...groups.values()];
}

export interface StatusInput {
	quota: QuotaResponse | null;
	/** True when the quota shown is a cached copy because the last fetch failed. */
	quotaFromCache: boolean;
	staleAfterMs: number;
	now: number;
	/** At least one roster model has no rate. */
	unpriced: boolean;
	reconcile: { totals: ReconcileTotals; omp: OmpEstimate } | null;
	/** Display currency for money; amounts are USD underneath. */
	currency?: CurrencyView;
}

/**
 * Compact status: `Claude 5h 42% · 7d 17% | Codex 5h 81% (stale) | $? | cpa €1.62 (Δ +3%)`.
 * One group per upstream family; the worst credential per window is shown.
 * Returns undefined when there is nothing to show.
 */
export function statusText(input: StatusInput): string | undefined {
	const parts: string[] = [];
	if (input.quota) {
		for (const g of groupByFamily(input.quota, input.staleAfterMs, input.now)) {
			const windows = [...g.windows.entries()].map(([tag, w]) => `${tag} ${pct(w)}`).join(" · ");
			parts.push(`${familyLabel(g.family)} ${windows}${g.stale || input.quotaFromCache ? " (stale)" : ""}`);
		}
	}
	if (input.unpriced) parts.push("$?");
	if (input.reconcile && input.reconcile.totals.traces > 0) {
		const { totals, omp } = input.reconcile;
		let text = totals.complete === 0 ? "cpa pending" : `cpa ${formatMoney(totals.cpaUsd, input.currency)}`;
		const drift = totals.complete > 0 ? driftPct(totals.cpaUsd, omp.usd) : null;
		const notes = [
			drift === null ? undefined : `Δ ${drift >= 0 ? "+" : ""}${drift.toFixed(0)}%`,
			totals.complete > 0 && input.currency ? rateLabel(input.currency) : undefined,
		].filter(Boolean);
		if (notes.length > 0) text += ` (${notes.join(", ")})`;
		if (totals.pending > 0 && totals.complete > 0) text += " …";
		parts.push(text);
	}
	return parts.length > 0 ? parts.join(" | ") : undefined;
}

function bar(fraction: number): string {
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
	return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

export interface WidgetInput {
	quota: QuotaResponse | null;
	staleAfterMs: number;
	now: number;
	reconcile: { totals: ReconcileTotals; omp: OmpEstimate } | null;
	currency?: CurrencyView;
}

/**
 * Widget: one line per credential × window with a bar and reset countdown,
 * then (with `reconcile`) one session-cost line in the display currency with
 * its rate source; at most 10 lines.
 */
export function widgetLines(input: WidgetInput): string[] | undefined {
	const { quota, staleAfterMs, now } = input;
	const view = input.currency ?? USD_VIEW;
	const totals = input.reconcile?.totals;
	const costLine =
		input.reconcile && totals && totals.traces > 0
			? [
					`session omp ${formatMoney(input.reconcile.omp.usd, view)}`,
					`cpa ${totals.complete === 0 ? "pending" : formatMoney(totals.cpaUsd, view)}`,
					rateLabel(view),
				]
					.filter(Boolean)
					.join(" · ")
			: undefined;
	const maxQuota = WIDGET_MAX_LINES - (costLine ? 1 : 0);
	const lines: string[] = [];
	const credentials = quota?.credentials ?? [];
	const total = credentials.reduce((n, c) => n + c.windows.length, 0);
	outer: for (const c of credentials) {
		const stale = isStale(c, staleAfterMs, now);
		for (const w of c.windows) {
			if (lines.length === maxQuota - 1 && total > maxQuota) {
				lines.push(`… ${total - lines.length} more (/cliproxy-usage)`);
				break outer;
			}
			const reset = w.resets_at ? ` resets in ${formatDuration(Date.parse(w.resets_at) - now)}` : "";
			const fraction = typeof w.used_fraction === "number" ? w.used_fraction : w.used_percent / 100;
			lines.push(
				`${c.label} ${windowTag(w).padEnd(3)} ${bar(fraction)} ${pct(w).padStart(4)}${reset}${stale ? " (stale)" : ""}`,
			);
		}
	}
	if (costLine) lines.push(costLine);
	return lines.length > 0 ? lines : undefined;
}

function mdCell(v: string): string {
	return v.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function credentialRows(c: QuotaCredential, staleAfterMs: number, now: number): string[] {
	const stale = isStale(c, staleAfterMs, now);
	return c.windows.map(w =>
		[
			mdCell(c.label),
			mdCell(w.label),
			`${w.used_percent}%`,
			w.status,
			w.resets_at ?? "—",
			`${c.observed_at}${stale ? " (stale)" : ""}`,
		].join(" | "),
	);
}

export interface ReportInput {
	provider: string;
	baseUrl: string | undefined;
	quota: QuotaResponse | null;
	quotaFetchedAt: string | undefined;
	quotaFromCache: boolean;
	staleAfterMs: number;
	now: number;
	rates: RateSet | null;
	/** omp model ids with no rate. */
	unpricedModels: string[];
	/** omp model ids priced only partially (a bucket without rate). */
	partialModels: string[];
	reconcile: { totals: ReconcileTotals; omp: OmpEstimate } | null;
	currency?: CurrencyView;
	errors: string[];
}

/** Full `/cliproxy-usage` report (markdown). */
export function reportMarkdown(r: ReportInput): string {
	const out: string[] = [`## cliproxy usage — \`${r.provider}\``, ""];
	const view = r.currency ?? USD_VIEW;
	const converted = view.currency !== "USD";
	/** Display amount; converted reports append the USD original. */
	const money = (usd: number) => (converted ? `${formatMoney(usd, view)} (${formatMoney(usd)})` : formatMoney(usd));

	out.push("### Quota");
	if (!r.quota || r.quota.credentials.length === 0) {
		out.push("", r.quota ? "No quota observations recorded yet." : "Quota unavailable.");
	} else {
		out.push("", "| Credential | Window | Used | Status | Resets at | Observed |", "|---|---|---|---|---|---|");
		for (const c of r.quota.credentials) out.push(...credentialRows(c, r.staleAfterMs, r.now).map(row => `| ${row} |`));
		const credits = r.quota.credentials.filter(c => c.credits);
		for (const c of credits) {
			const cr = c.credits!;
			const bits = [cr.unlimited ? "unlimited" : undefined, cr.balance ? `balance ${cr.balance}` : undefined].filter(Boolean);
			if (bits.length > 0) out.push("", `Credits (${mdCell(c.label)}): ${bits.join(", ")}`);
		}
		out.push("", `Fetched ${r.quotaFetchedAt ?? "—"}${r.quotaFromCache ? " (cached copy; CPA unreachable)" : ""}. ${"CPA passive observation, not a live poll."}`);
	}

	if (r.reconcile) {
		const { totals, omp } = r.reconcile;
		out.push("", "### Session cost (omp estimate vs CPA)", "");
		const models = new Set([...omp.byModel.keys(), ...totals.byModel.keys()]);
		if (models.size > 0) {
			out.push("| Model | omp | CPA |", "|---|---|---|");
			for (const m of [...models].sort()) {
				const o = omp.byModel.get(m);
				const c = totals.byModel.get(m);
				out.push(`| ${mdCell(m)} | ${o === undefined ? "—" : money(o)} | ${c === undefined ? "—" : money(c)} |`);
			}
			out.push("");
		}
		const drift = totals.complete > 0 ? driftPct(totals.cpaUsd, omp.usd) : null;
		out.push(
			`Total: omp ${money(omp.usd)} · CPA ${money(totals.cpaUsd)}${drift === null ? "" : ` (Δ ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}%)`}`,
			`Traces: ${totals.complete} complete, ${totals.pending} pending, ${totals.missing} missing${totals.unpriced ? "; some requests unpriced on the CPA side" : ""}`,
		);
	}

	const label = rateLabel(view);
	const note = missingNote(view);
	if (label || note) {
		out.push("", "### Currency", "");
		if (label) out.push(`Amounts in ${view.currency} (USD in parentheses) at ${view.rate} ${view.currency}/USD, ${label}. Rate cards and omp's own costs stay USD.`);
		if (note) out.push(`${note[0]!.toUpperCase()}${note.slice(1)}.`);
	}

	out.push("", "### Rates", "");
	if (!r.rates) {
		out.push("No rate source available; models keep their configured cost.");
	} else {
		out.push(`Source: ${r.rates.source} (${r.rates.fetchedAt})`, "");
		const priced = [...r.rates.cards.values()].filter(c => c.status !== "unknown");
		if (priced.length > 0) {
			out.push("| Model | In | Out | Cache read | Cache write | Tier | Card |", "|---|---|---|---|---|---|---|");
			for (const c of priced.sort((a, b) => a.model.localeCompare(b.model))) {
				const t = c.tiers[0];
				const n = (v: number | undefined) => (v === undefined ? "—" : String(v));
				out.push(
					`| ${mdCell(c.model)} | ${n(c.rates?.input)} | ${n(c.rates?.output)} | ${n(c.rates?.cache_read)} | ${n(c.rates?.cache_write)} | ${t ? `>${t.above_prompt_tokens}` : "—"} | ${c.rate_card_id ?? c.status} |`,
				);
			}
		}
	}
	if (r.unpricedModels.length > 0) out.push("", `Unpriced (cost 0): ${r.unpricedModels.map(mdCell).join(", ")}`);
	if (r.partialModels.length > 0) out.push("", `Partially priced: ${r.partialModels.map(mdCell).join(", ")}`);

	if (r.errors.length > 0) {
		out.push("", "### Last errors", "", ...r.errors.map(e => `- ${mdCell(e)}`));
	}
	return out.join("\n");
}
