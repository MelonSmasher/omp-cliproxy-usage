import type { Trace } from "./contract";
import type { CpaClient } from "./cpa-client";

export const TRACE_ENTRY_TYPE = "cliproxy-usage/trace";
/** Pending traces are retried until this age, then reported as missing (never counted as 0). */
export const PENDING_GIVE_UP_MS = 10 * 60_000;
const BATCH = 100;

const FULL_TRACE_HEADER = /^\d{14}-[0-9a-f]{16}-(.+)$/i;

/**
 * Trace id from CPA's `X-Cpa-Trace-Id` (`<yyyymmddhhmmss>-<auth index>-<uuid>`)
 * or a bare id. Returns undefined for empty input.
 */
export function parseTraceId(header: string | undefined): string | undefined {
	const value = header?.trim();
	if (!value) return undefined;
	return FULL_TRACE_HEADER.exec(value)?.[1] ?? value;
}

export interface TraceEntryData {
	trace: string;
}

export function isTraceEntryData(v: unknown): v is TraceEntryData {
	return typeof v === "object" && v !== null && typeof (v as TraceEntryData).trace === "string";
}

interface TrackedTrace {
	id: string;
	firstSeen: number;
	state: "pending" | "complete" | "missing";
	cost: number | null;
	/** Per-model CPA cost from the trace's attempts. */
	byModel: Map<string, number>;
	unpriced: boolean;
}

export interface ReconcileTotals {
	traces: number;
	complete: number;
	pending: number;
	missing: number;
	/** Sum of CPA-recorded costs over complete traces (null costs excluded). */
	cpaUsd: number;
	/** True when at least one complete trace had no price on the CPA side. */
	unpriced: boolean;
	byModel: Map<string, number>;
}

export interface OmpEstimate {
	usd: number;
	byModel: Map<string, number>;
}

/** Relative difference of CPA vs omp in percent; null when omp has no estimate to compare. */
export function driftPct(cpaUsd: number, ompUsd: number): number | null {
	if (ompUsd <= 0) return null;
	return ((cpaUsd - ompUsd) / ompUsd) * 100;
}

/**
 * Per-session reconciliation state. Holds trace ids only (no token, no
 * request content); persistence is the caller's `appendEntry`.
 */
export class Reconciler {
	readonly #traces = new Map<string, TrackedTrace>();
	#since: number | undefined;
	#driftNotified = false;
	#lastError: string | undefined;

	constructor(private readonly now: () => number = Date.now) {}

	/** Earliest trace time (ms): omp's estimate is summed from here on. */
	get since(): number | undefined {
		return this.#since;
	}

	get lastError(): string | undefined {
		return this.#lastError;
	}

	/** Forget everything (session switch). */
	reset(): void {
		this.#traces.clear();
		this.#since = undefined;
		this.#driftNotified = false;
		this.#lastError = undefined;
	}

	/** Record a new trace; returns false when it was already tracked (so the caller does not persist twice). */
	add(id: string, seenAt: number = this.now()): boolean {
		if (this.#traces.has(id)) return false;
		this.#traces.set(id, { id, firstSeen: seenAt, state: "pending", cost: null, byModel: new Map(), unpriced: false });
		if (this.#since === undefined || seenAt < this.#since) this.#since = seenAt;
		return true;
	}

	/** Restore traces from persisted session entries (resume). */
	restore(entries: readonly { type: string; customType?: string; data?: unknown; timestamp?: string }[]): void {
		for (const e of entries) {
			if (e.type !== "custom" || e.customType !== TRACE_ENTRY_TYPE || !isTraceEntryData(e.data)) continue;
			const at = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
			this.add(e.data.trace, Number.isFinite(at) ? at : this.now());
		}
	}

	get pendingIds(): string[] {
		return [...this.#traces.values()].filter(t => t.state === "pending").map(t => t.id);
	}

	/**
	 * Look up pending traces (≤100 per request). `complete` stores CPA's cost;
	 * `pending` stays pending until PENDING_GIVE_UP_MS, then becomes `missing`;
	 * `expired` becomes `missing`. Errors leave traces pending.
	 */
	async lookup(client: CpaClient, signal?: AbortSignal): Promise<void> {
		const pending = this.pendingIds;
		for (let i = 0; i < pending.length; i += BATCH) {
			let traces: Trace[];
			try {
				traces = (await client.requests(pending.slice(i, i + BATCH), signal)).traces;
				this.#lastError = undefined;
			} catch (error) {
				this.#lastError = error instanceof Error ? error.message : "requests lookup failed";
				return;
			}
			for (const t of traces) this.#apply(t);
		}
		const now = this.now();
		for (const t of this.#traces.values()) {
			if (t.state === "pending" && now - t.firstSeen > PENDING_GIVE_UP_MS) t.state = "missing";
		}
	}

	#apply(t: Trace): void {
		const tracked = this.#traces.get(t.trace_id);
		if (!tracked || tracked.state !== "pending") return;
		if (t.status === "expired") {
			tracked.state = "missing";
			return;
		}
		if (t.status !== "complete") return;
		tracked.state = "complete";
		tracked.cost = t.cost_usd;
		tracked.unpriced = t.attempts.some(a => a.cost === null);
		for (const a of t.attempts) {
			if (!a.cost) continue;
			tracked.byModel.set(a.model, (tracked.byModel.get(a.model) ?? 0) + a.cost.total);
		}
	}

	totals(): ReconcileTotals {
		const out: ReconcileTotals = {
			traces: this.#traces.size,
			complete: 0,
			pending: 0,
			missing: 0,
			cpaUsd: 0,
			unpriced: false,
			byModel: new Map(),
		};
		for (const t of this.#traces.values()) {
			if (t.state === "pending") out.pending++;
			else if (t.state === "missing") out.missing++;
			else {
				out.complete++;
				out.cpaUsd += t.cost ?? 0;
				if (t.unpriced) out.unpriced = true;
				for (const [m, c] of t.byModel) out.byModel.set(m, (out.byModel.get(m) ?? 0) + c);
			}
		}
		return out;
	}

	/**
	 * Returns the drift percentage once per session when every trace is settled
	 * and |drift| exceeds the threshold; undefined otherwise.
	 */
	checkDrift(omp: OmpEstimate, thresholdPct: number): number | undefined {
		if (this.#driftNotified) return undefined;
		const totals = this.totals();
		if (totals.complete === 0 || totals.pending > 0) return undefined;
		const drift = driftPct(totals.cpaUsd, omp.usd);
		if (drift === null || Math.abs(drift) <= thresholdPct) return undefined;
		this.#driftNotified = true;
		return drift;
	}
}

interface AssistantLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	usage?: { cost?: { total?: unknown } };
}

/**
 * omp's own estimate for the same period: assistant messages on `provider`
 * whose entry time is at or after `since` (the first recorded trace).
 */
export function ompEstimate(
	entries: readonly { type: string; timestamp?: string; message?: unknown }[],
	provider: string,
	since: number | undefined,
): OmpEstimate {
	const out: OmpEstimate = { usd: 0, byModel: new Map() };
	if (since === undefined) return out;
	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = e.message as AssistantLike | undefined;
		if (m?.role !== "assistant" || m.provider !== provider) continue;
		const at = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
		if (!(at >= since)) continue;
		const cost = m.usage?.cost?.total;
		if (typeof cost !== "number" || !Number.isFinite(cost)) continue;
		out.usd += cost;
		const model = typeof m.model === "string" ? m.model : "?";
		out.byModel.set(model, (out.byModel.get(model) ?? 0) + cost);
	}
	return out;
}
