/**
 * Read-enrichment patch shape: `structuredContent` survives verbatim when the
 * handler replaces `content`, and only literal successful `read` results are
 * enriched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import codememPiExtension, { __setTestExecImpl } from "./index.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type Payload = Record<string, unknown>;
type ReadPatch = { content?: Array<Record<string, unknown>>; structuredContent?: unknown };

const CONTEXT_BLOCK = "per-file context";

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
		cwd: "/tmp/pi-read-enrichment",
		signal: new AbortController().signal,
		sessionManager: {
			getSessionId: () => "sess-read-enrichment",
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

async function emitRead(
	h: Harness,
	input: {
		toolCallId: string;
		toolName?: string;
		content?: unknown[];
		structuredContent?: unknown;
		isError?: boolean;
	},
): Promise<ReadPatch | undefined> {
	const event: Payload = {
		toolCallId: input.toolCallId,
		toolName: input.toolName ?? "read",
		input: { path: "src/a.ts" },
		content: input.content ?? [{ type: "text", text: "file body" }],
		isError: input.isError ?? false,
	};
	if (input.structuredContent !== undefined) event.structuredContent = input.structuredContent;
	return (await h.emit("tool_result", event)) as ReadPatch | undefined;
}

beforeEach(() => {
	vi.stubEnv("CODEMEM_VIEWER_AUTO", "0");
	vi.stubEnv("CODEMEM_PI_FILE_CONTEXT", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("offline");
		}),
	);
	__setTestExecImpl(async (args) => {
		if (args[0] === "claude-hook-file-context") {
			return {
				stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: CONTEXT_BLOCK } }),
				stderr: "",
			};
		}
		return { stdout: JSON.stringify({ inserted: 1, skipped: 0 }), stderr: "" };
	});
});

afterEach(() => {
	__setTestExecImpl(null);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("read enrichment structured content", () => {
	it("returns structuredContent verbatim alongside the appended block", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const patch = await emitRead(h, {
			toolCallId: "read-object",
			content: [{ type: "text", text: "file body" }],
			structuredContent: { files: ["a.ts"], truncated: false },
		});
		expect(patch?.structuredContent).toEqual({ files: ["a.ts"], truncated: false });
		expect(patch?.content).toHaveLength(2);
		expect(patch?.content?.[0]).toMatchObject({ type: "text", text: "file body" });
		expect(String(patch?.content?.[1]?.text)).toContain("## codemem memories");
	});

	it("keeps string, false, and null structured values verbatim", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const values = ["ok", false, null];
		for (const [index, value] of values.entries()) {
			const patch = await emitRead(h, {
				toolCallId: `read-value-${index}`,
				structuredContent: value,
			});
			expect(patch?.structuredContent).toBe(value);
		}
	});
});

describe("read enrichment content shapes", () => {
	it("preserves image blocks while appending the enrichment block", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const patch = await emitRead(h, {
			toolCallId: "read-image",
			content: [{ type: "text", text: "note" }, image],
		});
		expect(patch?.content?.[0]).toMatchObject({ type: "text", text: "note" });
		expect(patch?.content?.[1]).toEqual(image);
		expect(patch?.content).toHaveLength(3);
	});

	it("leaves structuredContent undefined when the read result has none", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const patch = await emitRead(h, { toolCallId: "read-plain" });
		expect(patch?.content).toHaveLength(2);
		expect(patch?.structuredContent).toBeUndefined();
	});

	it("does not enrich foreign read names or failed reads", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const foreign = await emitRead(h, { toolCallId: "read-foreign", toolName: "mcp__other__read" });
		expect(foreign).toBeUndefined();
		const suffixed = await emitRead(h, { toolCallId: "read-suffix", toolName: "read_extra" });
		expect(suffixed).toBeUndefined();
		const failed = await emitRead(h, { toolCallId: "read-failed", isError: true });
		expect(failed).toBeUndefined();
	});
});
