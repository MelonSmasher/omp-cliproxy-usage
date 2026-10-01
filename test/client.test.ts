import { afterEach, describe, expect, test } from "bun:test";
import { CpaClient, CpaError, cpaRootFromProviderUrl } from "../src/cpa-client";
import { type CpaMock, startCpaMock } from "./fixtures/cpa-mock";
import { closedUrl, TOKEN } from "./helpers";

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
		expect(e.message).not.toContain(TOKEN);
		expect(e.message).not.toContain("secret-model");
		expect(e.message).not.toContain("127.0.0.1");
	};

	test("401 → unauthorized", async () => {
		mock = startCpaMock({ token: TOKEN });
		const e = await failure(new CpaClient({ baseUrl: mock.url, token: () => `${TOKEN}x` }).rates(["secret-model"]));
		expect([e.kind, e.status]).toEqual(["unauthorized", 401]);
		assertRedacted(e);
	});

	test("503 read_api_disabled → disabled; 500 → http", async () => {
		mock = startCpaMock({ token: TOKEN });
		const client = new CpaClient({ baseUrl: mock.url, token: () => TOKEN });
		mock.fault = "disabled";
		expect((await failure(client.quota())).kind).toBe("disabled");
		mock.fault = "500";
		const e = await failure(client.rates(["secret-model"]));
		expect([e.kind, e.status]).toEqual(["http", 500]);
		assertRedacted(e);
	});

	test("route missing (CPA without the plugin) → not_installed", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("404 page not found", { status: 404 }) });
		try {
			const e = await failure(new CpaClient({ baseUrl: `http://127.0.0.1:${server.port}`, token: () => TOKEN }).quota());
			expect(e.kind).toBe("not_installed");
		} finally {
			await server.stop(true);
		}
	});

	test("wrong schema → schema; unreachable → network; slow → timeout", async () => {
		mock = startCpaMock({ token: TOKEN, slowMs: 1_000 });
		const client = new CpaClient({ baseUrl: mock.url, token: () => TOKEN, timeoutMs: 150 });
		mock.fault = "schema";
		expect((await failure(client.quota())).kind).toBe("schema");
		mock.fault = "slow";
		expect((await failure(client.quota())).kind).toBe("timeout");
		const down = await failure(new CpaClient({ baseUrl: await closedUrl(), token: () => TOKEN }).rates(["secret-model"]));
		expect(down.kind).toBe("network");
		assertRedacted(down);
	});

	test("unset token → no_token without any request", async () => {
		mock = startCpaMock({ token: TOKEN });
		expect((await failure(new CpaClient({ baseUrl: mock.url, token: () => undefined }).quota())).kind).toBe("no_token");
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
