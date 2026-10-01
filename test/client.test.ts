import { afterEach, describe, expect, test } from "bun:test";
import { CpaClient, CpaError, cpaRootFromProviderUrl } from "../src/cpa-client";
import { type CpaMock, startCpaMock } from "./fixtures/cpa-mock";
import { closedUrl, KEY } from "./helpers";

describe("CpaClient errors", () => {
	let mock: CpaMock | undefined;
	afterEach(async () => {
		await mock?.stop();
		mock = undefined;
	});

	const failure = async (p: Promise<unknown>): Promise<CpaError> => {
		try {
			await p;
		} catch (error) {
			if (error instanceof CpaError) return error;
			throw error;
		}
		throw new Error("expected a CpaError");
	};

	const assertRedacted = (e: CpaError) => {
		expect(e.message).not.toContain(KEY);
		expect(e.message).not.toContain("secret-model");
		expect(e.message).not.toContain("127.0.0.1");
	};

	test("401 → unauthorized, and no further request on any route afterwards", async () => {
		mock = startCpaMock({ managementKey: KEY });
		const stops: CpaError[] = [];
		const client = new CpaClient({ baseUrl: mock.url, managementKey: () => `${KEY}x`, onAuthFailure: e => stops.push(e) });
		const e = await failure(client.rates(["secret-model"]));
		expect([e.kind, e.status]).toEqual(["unauthorized", 401]);
		expect(e.message).toContain("management key rejected (401)");
		assertRedacted(e);
		for (const later of [client.quota(), client.fx(), client.requests(["t-1"]), client.rates(["secret-model"])]) {
			expect((await failure(later)).kind).toBe("unauthorized");
		}
		expect(mock.seen).toHaveLength(1);
		expect(stops).toHaveLength(1);
		expect(client.authFailure?.kind).toBe("unauthorized");
	});

	test("403 (IP blocked / remote management off) → forbidden, and no further request afterwards", async () => {
		mock = startCpaMock({ managementKey: KEY });
		mock.fault = "forbidden";
		const client = new CpaClient({ baseUrl: mock.url, managementKey: () => KEY });
		const e = await failure(client.quota());
		expect([e.kind, e.status]).toEqual(["forbidden", 403]);
		expect(e.message).toContain("temporarily blocked");
		mock.fault = "none"; // even once CPA would answer again, this client stays stopped
		expect((await failure(client.quota())).kind).toBe("forbidden");
		expect((await failure(client.rates(["secret-model"]))).kind).toBe("forbidden");
		expect(mock.seen).toHaveLength(1);
	});

	test("calls made together before the key is accepted send one request at a time, so one 401 stops the rest", async () => {
		mock = startCpaMock({ managementKey: KEY });
		const client = new CpaClient({ baseUrl: mock.url, managementKey: () => "wrong-key-value-wrong-key-value" });
		const kinds = await Promise.all([client.quota(), client.fx(), client.rates(["a"]), client.requests(["t-1"])].map(p => failure(p).then(e => e.kind)));
		expect(kinds).toEqual(["unauthorized", "unauthorized", "unauthorized", "unauthorized"]);
		expect(mock.seen).toHaveLength(1);
	});

	test("after the key is accepted, calls overlap; 500 → http", async () => {
		mock = startCpaMock({ managementKey: KEY, slowMs: 300 });
		const client = new CpaClient({ baseUrl: mock.url, managementKey: () => KEY });
		await client.quota();
		mock.fault = "slow";
		const started = performance.now();
		await Promise.all([client.quota(), client.fx(), client.rates(["a"])]);
		expect(performance.now() - started).toBeLessThan(800);
		mock.fault = "500";
		const e = await failure(client.rates(["secret-model"]));
		expect([e.kind, e.status]).toEqual(["http", 500]);
		assertRedacted(e);
	});

	test("route missing (CPA without the plugin) → not_installed", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("404 page not found", { status: 404 }) });
		try {
			const e = await failure(new CpaClient({ baseUrl: `http://127.0.0.1:${server.port}`, managementKey: () => KEY }).quota());
			expect(e.kind).toBe("not_installed");
		} finally {
			await server.stop(true);
		}
	});

	test("wrong schema → schema; unreachable → network; slow → timeout", async () => {
		mock = startCpaMock({ managementKey: KEY, slowMs: 1_000 });
		const client = new CpaClient({ baseUrl: mock.url, managementKey: () => KEY, timeoutMs: 150 });
		mock.fault = "schema";
		expect((await failure(client.quota())).kind).toBe("schema");
		mock.fault = "slow";
		expect((await failure(client.quota())).kind).toBe("timeout");
		const down = await failure(new CpaClient({ baseUrl: await closedUrl(), managementKey: () => KEY }).rates(["secret-model"]));
		expect(down.kind).toBe("network");
		assertRedacted(down);
	});

	test("unset key → no_key without any request", async () => {
		mock = startCpaMock({ managementKey: KEY });
		expect((await failure(new CpaClient({ baseUrl: mock.url, managementKey: () => undefined }).quota())).kind).toBe("no_key");
		expect(mock.seen).toEqual([]);
	});
});

describe("cpaRootFromProviderUrl", () => {
	test("strips one trailing /v1 and slashes, keeps a path prefix", () => {
		expect(cpaRootFromProviderUrl("http://localhost:8317/v1")).toBe("http://localhost:8317");
		expect(cpaRootFromProviderUrl("https://gw.example.com/cpa/v1/")).toBe("https://gw.example.com/cpa");
		expect(cpaRootFromProviderUrl("http://localhost:8317")).toBe("http://localhost:8317");
		expect(cpaRootFromProviderUrl("http://h/v1/v1")).toBe("http://h/v1");
	});
});
