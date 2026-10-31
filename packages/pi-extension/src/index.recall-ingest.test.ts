/**
 * Pi recall safety at the real ingest seam: the exact payload delivered to
 * `PiCodememClient.ingest`, its CLI serialization, and factory event wiring.
 *
 * The fixture runs every handler registered for an event (the extension
 * registers several per lifecycle event) in registration order, following the
 * real SDK order: tool_execution_start → tool_call → tool_result →
 * tool_execution_end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiCodememClient } from "./client.js";
import codememPiExtension, { __setTestExecImpl } from "./index.js";
import { MAX_CORRELATED_CALLS } from "./recall-correlation.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type Payload = Record<string, unknown>;
type CliCall = { args: string[]; stdin?: string };
type ToolResult = {
	id: string;
	toolName: string;
	text?: string;
	parent?: string;
	isError?: boolean;
};

const RECALL = "RECALLED-MEMORY-MARKER";
const SAFE = "UNRELATED-READ-OUTPUT";
const RECALL_TOOL = "mcp__codemem__memory_search";
const CODEMODE = "codemode";
const SESSION = "sess-recall-ingest";

const cliCalls: CliCall[] = [];

function createHarness() {
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool() {},
		appendEntry() {},
	};
	codememPiExtension(pi as never);
	const ctx = {
		cwd: "/tmp/pi-recall",
		signal: new AbortController().signal,
		sessionManager: {
			getSessionId: () => SESSION,
			getEntries: () => [],
			getLeafEntry: () => null,
			getSessionFile: () => null,
		},
		ui: { notify() {} },
	};
	async function emit(name: string, event: Payload = {}) {
		let last: unknown;
		for (const handler of handlers.get(name) ?? []) {
			last = await handler({ type: name, ...event }, ctx);
		}
		return last;
	}
	return { emit };
}

type Harness = ReturnType<typeof createHarness>;

function captureIngest(): Payload[] {
	const captured: Payload[] = [];
	vi.spyOn(PiCodememClient.prototype, "ingest").mockImplementation(async (payload) => {
		captured.push({ ...payload });
		return { ok: true, via: "http" };
	});
	return captured;
}

function payloadFor(captured: Payload[], toolCallId: string): Payload {
	const found = captured.find(
		(payload) => payload.piEvent === "tool_result" && payload.toolCallId === toolCallId,
	);
	if (!found) throw new Error(`no tool_result payload for ${toolCallId}`);
	return found;
}

async function begin(h: Harness, id: string, toolName: string, parent?: string): Promise<void> {
	const extra = { toolCallId: id, toolName, parentToolCallId: parent };
	await h.emit("tool_execution_start", { ...extra, args: {} });
	await h.emit("tool_call", { ...extra, input: {} });
}

async function end(h: Harness, input: ToolResult): Promise<void> {
	const isError = input.isError ?? false;
	const extra = {
		toolCallId: input.id,
		toolName: input.toolName,
		parentToolCallId: input.parent,
	};
	await h.emit("tool_result", {
		...extra,
		input: {},
		isError,
		content: [{ type: "text", text: input.text ?? SAFE }],
	});
	await h.emit("tool_execution_end", { ...extra, result: {}, isError });
}

beforeEach(() => {
	vi.stubEnv("CODEMEM_VIEWER_AUTO", "0");
	vi.stubEnv("CODEMEM_PI_FILE_CONTEXT", "0");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("offline");
		}),
	);
	__setTestExecImpl(async (args, opts) => {
		cliCalls.push({ args, stdin: opts?.stdin });
		return { stdout: JSON.stringify({ inserted: 1, skipped: 0 }), stderr: "" };
	});
});

afterEach(() => {
	__setTestExecImpl(null);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	cliCalls.length = 0;
});

describe("pi recall ingest redaction", () => {
	it("redacts the child ingest copy and leaves the frozen model result untouched", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const content = Object.freeze([Object.freeze({ type: "text", text: RECALL })]);
		await begin(h, "c1", RECALL_TOOL);
		const event = { toolCallId: "c1", toolName: RECALL_TOOL, input: {}, content, isError: false };
		const returned = await h.emit("tool_result", {
			...event,
			structuredContent: { recalled: RECALL },
		});
		await h.emit("tool_execution_end", { toolCallId: "c1", toolName: RECALL_TOOL, result: {} });

		expect(returned).toBeUndefined();
		expect(content[0]?.text).toBe(RECALL);
		const payload = payloadFor(captured, "c1");
		expect(payload.toolName).toBe("codemem_memory_search");
		expect(payload.toolOutput ?? null).toBeNull();
		expect(payload).not.toHaveProperty("structuredContent");
		expect(payload).toMatchObject({ sessionId: SESSION, isError: false });
		expect(JSON.stringify(captured)).not.toContain(RECALL);
	});

	it("redacts a failed recall result and keeps its error lifecycle fields", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await end(h, {
			id: "c-err",
			toolName: "mcp__codemem__memory_get",
			text: RECALL,
			isError: true,
		});
		const payload = payloadFor(captured, "c-err");
		expect(payload.toolName).toBe("codemem_memory_get");
		expect(payload.isError).toBe(true);
		expect(payload.toolOutput ?? null).toBeNull();
		expect(JSON.stringify(captured)).not.toContain(RECALL);
	});
});

describe("pi recall aggregate correlation", () => {
	it("omits a mixed aggregate but keeps its unrelated read child", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await begin(h, "agg", CODEMODE);
		await begin(h, "read-1", "read", "agg");
		await end(h, { id: "read-1", toolName: "read", text: SAFE, parent: "agg" });
		await begin(h, "recall-1", RECALL_TOOL, "agg");
		await end(h, { id: "recall-1", toolName: RECALL_TOOL, text: RECALL, parent: "agg" });
		await end(h, { id: "agg", toolName: CODEMODE, text: `${SAFE}\n${RECALL}` });

		expect(payloadFor(captured, "read-1").toolOutput).toBe(SAFE);
		expect(payloadFor(captured, "agg").toolOutput ?? null).toBeNull();
		expect(JSON.stringify(captured)).not.toContain(RECALL);
	});

	it("omits nested ancestors after the recall child has already completed", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await begin(h, "outer", CODEMODE);
		await begin(h, "inner", CODEMODE, "outer");
		await begin(h, "deep", RECALL_TOOL, "inner");
		await end(h, { id: "deep", toolName: RECALL_TOOL, text: RECALL, parent: "inner" });
		await end(h, { id: "inner", toolName: CODEMODE, text: RECALL, parent: "outer" });
		await end(h, { id: "outer", toolName: CODEMODE, text: RECALL });

		expect(payloadFor(captured, "inner").toolOutput ?? null).toBeNull();
		expect(payloadFor(captured, "outer").toolOutput ?? null).toBeNull();
		expect(JSON.stringify(captured)).not.toContain(RECALL);
	});

	it("omits a failed aggregate whose partial output carries recall", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await begin(h, "agg-fail", CODEMODE);
		await begin(h, "deep-fail", RECALL_TOOL, "agg-fail");
		await end(h, { id: "deep-fail", toolName: RECALL_TOOL, text: RECALL, parent: "agg-fail" });
		await end(h, {
			id: "agg-fail",
			toolName: CODEMODE,
			text: `Script failed: ${RECALL}`,
			isError: true,
		});

		const payload = payloadFor(captured, "agg-fail");
		expect(payload.isError).toBe(true);
		expect(payload.toolOutput ?? null).toBeNull();
		expect(JSON.stringify(captured)).not.toContain(RECALL);
	});
});

describe("pi recall overflow and reset wiring", () => {
	it("defers turn_end and agent_settled while calls are active and hard-resets on session_start", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		for (let index = 0; index <= MAX_CORRELATED_CALLS; index += 1) {
			await h.emit("tool_execution_start", { toolCallId: `fill-${index}`, toolName: "bash" });
		}
		await end(h, { id: "agg-x", toolName: CODEMODE });
		expect(payloadFor(captured, "agg-x").toolOutput ?? null).toBeNull();
		await h.emit("turn_end", {});
		await end(h, { id: "agg-y", toolName: CODEMODE });
		expect(payloadFor(captured, "agg-y").toolOutput ?? null).toBeNull();
		await end(h, { id: "leaf-x", toolName: "bash" });
		expect(payloadFor(captured, "leaf-x").toolOutput).toBe(SAFE);
		await h.emit("agent_settled", { aborted: false });
		await end(h, { id: "agg-z", toolName: CODEMODE });
		expect(payloadFor(captured, "agg-z").toolOutput ?? null).toBeNull();
		await h.emit("session_start", { reason: "resume" });
		await end(h, { id: "agg-after", toolName: CODEMODE });
		expect(payloadFor(captured, "agg-after").toolOutput).toBe(SAFE);
	});

	it("adds no ingest traffic or CLI work for correlation lifecycle events", async () => {
		const captured = captureIngest();
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await begin(h, "agg-ok", CODEMODE);
		await begin(h, "read-ok", "read", "agg-ok");
		await end(h, { id: "read-ok", toolName: "read", text: SAFE, parent: "agg-ok" });
		await end(h, { id: "agg-ok", toolName: CODEMODE, text: SAFE });
		expect(payloadFor(captured, "agg-ok").toolOutput).toBe(SAFE);
		const before = captured.length;
		await h.emit("turn_end", {});
		await h.emit("agent_settled", { aborted: false });
		expect(captured).toHaveLength(before);
		expect(cliCalls).toEqual([]);
	});
});

describe("pi recall ingest serialization", () => {
	it("serializes the CLI ingest payload with the canonical name and no recall text", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await begin(h, "wire-1", RECALL_TOOL);
		await end(h, { id: "wire-1", toolName: RECALL_TOOL, text: RECALL });
		const ingestCalls = cliCalls.filter((call) => call.args[0] === "pi-hook-ingest");
		const stdin = ingestCalls.map((call) => call.stdin ?? "").join("\n");
		expect(stdin).toContain('"toolName":"codemem_memory_search"');
		expect(stdin).not.toContain(RECALL);
		expect(cliCalls.every((call) => call.args[0] === "pi-hook-ingest")).toBe(true);
	});
});
