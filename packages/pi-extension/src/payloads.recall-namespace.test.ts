/**
 * Pi-only recall namespace: exact `mcp__codemem__memory_*` translation, ingest-copy
 * result redaction, and the unchanged shared-core projection/matcher.
 */
import {
	eventToToolEvent,
	isInternalMemoryTool,
	mapPiEventPayload,
	normalizeToolName,
	projectAdapterToolEvent,
} from "@codemem/core";
import { describe, expect, it } from "vitest";
import {
	buildToolCallPayload,
	buildToolResultPayload,
	normalizePiMcpMemoryToolName,
} from "./payloads.js";

const RECALL = "RECALLED-MEMORY-MARKER";
const SESSION = "sess-recall-ns";

/** Exact namespace, including suffixed tool names. */
const MATCHED: Array<[string, string]> = [
	["mcp__codemem__memory_search", "codemem_memory_search"],
	["mcp__codemem__memory_session_search", "codemem_memory_session_search"],
	["mcp__codemem__memory_get", "codemem_memory_get"],
	["mcp__codemem__memory_search_deep", "codemem_memory_search_deep"],
];

/** Lookalikes, foreign servers, native names, and the already-canonical spelling. */
const UNCHANGED = [
	"mcp__codemem_extra__memory_search",
	"mcp__notcodemem__memory_search",
	"mcp__codemem__memory",
	"mcp__codemem__xmemory_search",
	"MCP__CODEMEM__MEMORY_SEARCH",
	" mcp__codemem__memory_search",
	"codemem_memory_search",
	"memory_search",
	"bash",
	"read",
];

function extractFrom(result: ReturnType<typeof buildToolResultPayload>) {
	const adapter = mapPiEventPayload(result);
	if (!adapter) throw new Error("expected an adapter event");
	// `mapPiEventPayload` returns a typed interface; the projection seam takes a plain record.
	const projected = projectAdapterToolEvent(adapter as unknown as Record<string, unknown>, {});
	if (!projected) throw new Error("expected a projected tool event");
	return { adapter, toolEvent: eventToToolEvent(projected, 12_000) };
}

describe("normalizePiMcpMemoryToolName", () => {
	it("maps exactly Pi's codemem MCP memory namespace and keeps the tool suffix", () => {
		for (const [toolName, canonical] of MATCHED) {
			expect(normalizePiMcpMemoryToolName(toolName)).toBe(canonical);
		}
	});

	it("leaves lookalike, foreign, native, and canonical names untouched", () => {
		for (const toolName of UNCHANGED) {
			expect(normalizePiMcpMemoryToolName(toolName)).toBeNull();
		}
	});
});

describe("buildToolResultPayload recall copy", () => {
	it("redacts the ingest copy of a namespaced recall result and keeps lifecycle fields", () => {
		const payload = buildToolResultPayload({
			sessionId: SESSION,
			toolCallId: "tc-recall",
			toolName: "mcp__codemem__memory_search",
			toolInput: { query: "auth" },
			toolOutput: RECALL,
			isError: false,
		});
		expect(payload.toolName).toBe("codemem_memory_search");
		expect(payload.toolOutput ?? null).toBeNull();
		expect(payload.toolInput).toEqual({ query: "auth" });
		expect(payload).toMatchObject({
			piEvent: "tool_result",
			sessionId: SESSION,
			toolCallId: "tc-recall",
			isError: false,
		});
		expect(typeof payload.ts).toBe("string");
		expect(JSON.stringify(payload)).not.toContain(RECALL);
	});

	it("redacts namespaced error results without keeping the error text", () => {
		const payload = buildToolResultPayload({
			sessionId: SESSION,
			toolCallId: "tc-recall-error",
			toolName: "mcp__codemem__memory_get",
			isError: true,
			error: RECALL,
		});
		expect(payload.toolName).toBe("codemem_memory_get");
		expect(payload.isError).toBe(true);
		expect(payload.toolOutput ?? null).toBeNull();
		expect(JSON.stringify(payload)).not.toContain(RECALL);
	});

	it("redacts a caller-proven aggregate result and still translates tool_call names", () => {
		const payload = buildToolResultPayload({
			sessionId: SESSION,
			toolCallId: "tc-codemode",
			toolName: "codemode",
			toolOutput: RECALL,
			omitResultContent: true,
		});
		expect(payload.toolName).toBe("codemode");
		expect(payload.toolOutput ?? null).toBeNull();
		expect(JSON.stringify(payload)).not.toContain(RECALL);

		const call = buildToolCallPayload({
			sessionId: SESSION,
			toolCallId: "tc-call",
			toolName: "mcp__codemem__memory_pack",
		});
		expect(call.toolName).toBe("codemem_memory_pack");
	});
});

describe("shared core projection", () => {
	it("excludes the translated recall result from extraction with the unchanged matcher", () => {
		const { adapter, toolEvent } = extractFrom(
			buildToolResultPayload({
				sessionId: SESSION,
				toolCallId: "tc-extract",
				toolName: "mcp__codemem__memory_search",
				toolOutput: RECALL,
			}),
		);
		expect(adapter.payload).toMatchObject({ tool_name: "codemem_memory_search" });
		expect(normalizeToolName({ tool: "codemem_memory_search" })).toBe("codemem_memory_search");
		expect(isInternalMemoryTool("codemem_memory_search")).toBe(true);
		expect(isInternalMemoryTool("mcp__codemem__memory_search")).toBe(false);
		expect(isInternalMemoryTool("memory_search")).toBe(false);
		expect(toolEvent).toBeNull();
	});

	it("still extracts a lookalike tool result with its content", () => {
		const { adapter, toolEvent } = extractFrom(
			buildToolResultPayload({
				sessionId: SESSION,
				toolCallId: "tc-foreign",
				toolName: "mcp__other__memory_search",
				toolOutput: RECALL,
			}),
		);
		expect(adapter.payload).toMatchObject({ tool_name: "mcp__other__memory_search" });
		expect(toolEvent?.toolName).toBe("mcp__other__memory_search");
		expect(toolEvent?.toolOutput).toContain(RECALL);
	});
});
