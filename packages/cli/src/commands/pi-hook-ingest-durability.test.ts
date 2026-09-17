/**
 * Durability-layer tests for pi-hook-ingest. Kept in their own file so the
 * measured describe bodies stay under the test-file line ratchet.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestPiHookPayload } from "./pi-hook-ingest.js";
import { spoolPiHookPayload } from "./pi-hook-ingest-spool.js";

const SANDBOX_ENV_KEYS = [
	"CODEMEM_PI_HOOK_LOCK_DIR",
	"CODEMEM_PI_HOOK_SPOOL_DIR",
	"CODEMEM_PLUGIN_LOG_PATH",
	"CODEMEM_PLUGIN_LOG",
	"CODEMEM_PI_HOOK_LOCK_TTL_S",
	"CODEMEM_PI_HOOK_LOCK_GRACE_S",
];

function installPiIngestSandbox(): {
	sandboxDir: string;
	lockDir: string;
	queueDir: string;
	pluginLogPath: string;
	cleanup: () => void;
} {
	const sandboxDir = mkdtempSync(join(tmpdir(), "codemem-cli-pi-ingest-test-"));
	const saved: Record<string, string | undefined> = {};
	for (const key of SANDBOX_ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	const lockDir = join(sandboxDir, "lock");
	const queueDir = join(sandboxDir, "spool");
	const pluginLogPath = join(sandboxDir, "plugin.log");
	process.env.CODEMEM_PI_HOOK_LOCK_DIR = lockDir;
	process.env.CODEMEM_PI_HOOK_SPOOL_DIR = queueDir;
	process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
	return {
		sandboxDir,
		lockDir,
		queueDir,
		pluginLogPath,
		cleanup: () => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(sandboxDir, { recursive: true, force: true });
		},
	};
}

describe("pi-hook-ingest durability drain", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains spooled backlog on the HTTP-success path so a recovered viewer doesn't strand entries", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "previously-spooled",
				tag: "queued",
			}),
			"utf8",
		);

		const httpCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "fresh", tag: "fresh" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) => {
					httpCalls.push(payload);
					return { ok: true, inserted: 1, skipped: 0 };
				},
				directIngest: () => {
					throw new Error("direct ingest should not be called when HTTP succeeds");
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "http" });
		expect(httpCalls.map((p) => p.tag)).toEqual(["fresh", "queued"]);
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
	});

	it("skips backlog drain on HTTP success when spool is empty (no extra HTTP calls)", async () => {
		let httpCallCount = 0;
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "no-backlog" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => {
					httpCallCount++;
					return { ok: true, inserted: 1, skipped: 0 };
				},
				directIngest: () => {
					throw new Error("direct ingest should not be called");
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		expect(httpCallCount).toBe(1);
	});
});

describe("pi-hook-ingest durability spool", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("treats HTTP skipped as a successful no-op without direct fallback", async () => {
		let directCalls = 0;
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
				directIngest: () => {
					directCalls++;
					return { inserted: 0, skipped: 1 };
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result).toEqual({ inserted: 0, skipped: 1, via: "http" });
		expect(directCalls).toBe(1);
	});

	it("spools the payload when both HTTP and direct ingest fail", async () => {
		const result = await ingestPiHookPayload(
			{
				piEvent: "session_start",
				sessionId: "sess-spool",
				timestamp: "2026-04-09T00:00:00Z",
			},
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("simulated direct ingest failure");
				},
				resolveDb: () => "/tmp/never-used.sqlite",
			},
		);
		expect(result.via).toBe("spool");
		const queued = readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"));
		expect(queued).toHaveLength(1);
		expect(readFileSync(sandbox.pluginLogPath, "utf8")).toContain("spooled payload");
	});
});

describe("pi-hook-ingest durability queued drain", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains spooled payloads through the handler before processing the new payload", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "queued-1",
				tag: "queued-1",
			}),
			"utf8",
		);
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000002-pid-2.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "queued-2",
				tag: "queued-2",
			}),
			"utf8",
		);

		const httpCalls: Array<Record<string, unknown>> = [];
		const directCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{
				piEvent: "session_start",
				sessionId: "fresh",
				tag: "fresh",
			},
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) => {
					httpCalls.push(payload);
					return { ok: false, inserted: 0, skipped: 0 };
				},
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
		expect(httpCalls.map((p) => p.tag)).toEqual(["fresh", "queued-1", "queued-2", "fresh"]);
		expect(directCalls.map((p) => p.tag)).toEqual(["queued-1", "queued-2", "fresh"]);
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
	});
});

describe("pi-hook-ingest boundary replay on recovered spool", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("replays the boundary flush when a spooled session_before_compact is drained later", async () => {
		// Original invocation: viewer down and DB down — boundary payload spools
		// without any flush (both flush writes fail).
		const spooled = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-recover", tag: "boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("db unavailable");
				},
				boundaryFlush: () => {
					throw new Error("flush unavailable");
				},
				resolveDb: () => "/tmp/unreachable.sqlite",
			},
		);
		expect(spooled.via).toBe("spool");

		// Later invocation: viewer still down, DB healthy — drain must deliver AND
		// replay the flush-only boundary, or the compact extraction is lost.
		const flushes: Array<Record<string, unknown>> = [];
		const directCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-later", tag: "later" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					flushes.push(payload);
				},
				resolveDb: () => "/tmp/healthy.sqlite",
			},
		);

		expect(result.via).toBe("direct");
		expect(readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"))).toHaveLength(0);
		// Delivery write-through (best-effort enqueue; skip for flush-only) plus
		// the boundary's own write-through both hit the boundary payload, then
		// the current event lands. Deduplication makes the double write safe.
		expect(directCalls.map((p) => p.tag)).toEqual(["boundary", "boundary", "later"]);
		expect(flushes.map((p) => p.tag)).toEqual(["boundary"]);
	});

	it("replays direct write-through + flush when a spooled session_shutdown drains over HTTP", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({ piEvent: "session_shutdown", sessionId: "sess-shut", tag: "boundary" }),
			"utf8",
		);

		const flushes: Array<Record<string, unknown>> = [];
		const directCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-next", tag: "next" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					flushes.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.via).toBe("http");
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
		// HTTP accepted the drained envelope; session_shutdown additionally gets
		// the promised synchronous direct write + flush replay. Delivery happ-
		// ened via HTTP so only the boundary write-through goes direct.
		expect(directCalls.map((p) => p.tag)).toEqual(["boundary"]);
		expect(flushes.map((p) => p.tag)).toEqual(["boundary"]);
	});

	it("keeps a recovered boundary spooled when the replayed flush fails, then flushes on a later drain", async () => {
		// Boundary spooled while everything was down.
		const spooled = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-keep", tag: "boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("db unavailable");
				},
				boundaryFlush: () => {
					throw new Error("flush unavailable");
				},
				resolveDb: () => "/tmp/unreachable.sqlite",
			},
		);
		expect(spooled.via).toBe("spool");

		// Recovery pass 1: delivery succeeds (DB healthy) but the flush still
		// fails (observer path down). Entry must NOT be deleted — extraction
		// has not run, so deleting would reproduce the original data loss.
		const firstFlushAttempts: Array<Record<string, unknown>> = [];
		await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-pass1", tag: "pass1" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 1, skipped: 0 }),
				boundaryFlush: (payload) => {
					firstFlushAttempts.push(payload);
					throw new Error("observer still unavailable");
				},
				resolveDb: () => "/tmp/healthy.sqlite",
			},
		);
		expect(firstFlushAttempts.map((p) => p.tag)).toEqual(["boundary"]);
		expect(readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"))).toHaveLength(1);

		// Recovery pass 2: flush now succeeds; entry drains and is deleted.
		const secondFlushAttempts: Array<Record<string, unknown>> = [];
		await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-pass2", tag: "pass2" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 1, skipped: 0 }),
				boundaryFlush: (payload) => {
					secondFlushAttempts.push(payload);
				},
				resolveDb: () => "/tmp/healthy.sqlite",
			},
		);
		expect(secondFlushAttempts.map((p) => p.tag)).toEqual(["boundary"]);
		expect(readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"))).toHaveLength(0);
	});
});
describe("pi-hook-ingest durability boundary order", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains the backlog BEFORE the boundary flush on the HTTP-success path", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "queued-before-flush",
				tag: "queued",
			}),
			"utf8",
		);

		const events: string[] = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "sess-end", tag: "fresh" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) => {
					events.push(`http:${String(payload.tag ?? "")}`);
					return { ok: true, inserted: 0, skipped: 0 };
				},
				directIngest: (payload) => {
					events.push(`direct:${String(payload.tag ?? "")}`);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					events.push(`flush:${String(payload.tag ?? "")}`);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		expect(events).toEqual(["http:fresh", "http:queued", "direct:fresh", "flush:fresh"]);
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
	});

	it("force-flushes session_shutdown via direct ingest + boundary flush even when HTTP succeeded", async () => {
		const directCalls: Array<Record<string, unknown>> = [];
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "sess-end" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		expect(directCalls).toHaveLength(1);
		expect(directCalls[0]?.piEvent).toBe("session_shutdown");
		expect(boundaryFlushCalls).toHaveLength(1);
		expect(boundaryFlushCalls[0]?.piEvent).toBe("session_shutdown");
	});
});

describe("pi-hook-ingest durability boundary compact", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("force-flushes session_before_compact as observe-only boundary", async () => {
		const directCalls: Array<Record<string, unknown>> = [];
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 0, skipped: 1 };
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		expect(directCalls).toHaveLength(1);
		expect(boundaryFlushCalls).toHaveLength(1);
		expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
	});

	it("force-flushes boundary payload on lock-busy unlocked direct path", async () => {
		mkdirSync(sandbox.lockDir);
		writeFileSync(join(sandbox.lockDir, "pid"), String(process.pid), "utf8");
		writeFileSync(join(sandbox.lockDir, "ts"), String(Math.floor(Date.now() / 1000)), "utf8");
		writeFileSync(join(sandbox.lockDir, "owner"), "external-owner", "utf8");

		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact-busy" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 0, skipped: 1 }),
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.via).toBe("direct");
		expect(boundaryFlushCalls).toHaveLength(1);
		expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
	});
});

describe("pi-hook-ingest durability boundary spool", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("force-flushes boundary payload on locked spool path when direct fails", async () => {
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact-spool" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("simulated db write failure");
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.via).toBe("spool");
		expect(boundaryFlushCalls).toHaveLength(1);
		expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
	});

	it("does not boundary-flush ordinary transcript events", async () => {
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		await ingestPiHookPayload(
			{
				piEvent: "message_end",
				sessionId: "sess-msg",
				role: "user",
				text: "hello",
				entryId: "e1",
			},
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
				directIngest: () => {
					throw new Error("direct should not run");
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(boundaryFlushCalls).toHaveLength(0);
	});
});

describe("pi-hook-ingest durability viewer-down drain", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains queued spool entries via direct fallback when the viewer stays down", async () => {
		const dbPath = join(sandbox.sandboxDir, "fallback.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();

		expect(
			spoolPiHookPayload({
				piEvent: "session_start",
				sessionId: "queued-stream",
				timestamp: "2026-05-29T01:00:00Z",
			}),
		).toBe(true);

		const result = await ingestPiHookPayload(
			{
				piEvent: "message_end",
				sessionId: "current-stream",
				role: "user",
				text: "hello",
				entryId: "e-current",
				timestamp: "2026-05-29T01:01:00Z",
			},
			{ host: "127.0.0.1", port: 38888, db: dbPath },
			{ httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }) },
		);

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
		const verify = connect(dbPath);
		try {
			const count = verify.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
				count: number;
			};
			expect(count.count).toBe(2);
			const sources = verify
				.prepare("SELECT DISTINCT source AS source FROM raw_events")
				.all() as Array<{ source: string }>;
			expect(sources.map((r) => r.source)).toEqual(["pi"]);
		} finally {
			verify.close();
		}
	});
});
