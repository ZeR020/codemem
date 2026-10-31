/**
 * `RecallCorrelation` bounds: the published hard bound, sticky overflow,
 * preserved unrelated leaves, and retained known aggregates under overflow.
 */
import { describe, expect, it } from "vitest";
import {
	CODEMODE_TOOL_NAME,
	MAX_CORRELATED_CALLS,
	RecallCorrelation,
} from "./recall-correlation.js";

const RECALL_TOOL = "mcp__codemem__memory_search";
const NON_CODEMODE = "task";

function start(
	recall: RecallCorrelation,
	toolCallId: string,
	toolName = "bash",
	parentToolCallId?: string,
): void {
	recall.noteStart({ toolCallId, toolName, parentToolCallId });
}

/** Retains a non-codemode aggregate with one active child, then fills to the hard bound. */
function saturated(): RecallCorrelation {
	const recall = new RecallCorrelation();
	start(recall, "agg", NON_CODEMODE);
	start(recall, "held-child", "read", "agg");
	for (let index = 0; index < MAX_CORRELATED_CALLS - 2; index += 1) {
		start(recall, `fill-${index}`);
	}
	return recall;
}

describe("recall correlation bounds", () => {
	it("publishes the 256-call hard bound and the codemode fallback name", () => {
		expect(MAX_CORRELATED_CALLS).toBe(256);
		expect(CODEMODE_TOOL_NAME).toBe("codemode");
	});

	it("stays sticky after overflow even when retained calls free slots, until reset", () => {
		const recall = saturated();
		start(recall, "overflowed", CODEMODE_TOOL_NAME);
		expect(recall.shouldOmitResult("overflowed", CODEMODE_TOOL_NAME)).toBe(true);
		for (let index = 0; index < 100; index += 1) recall.noteEnd(`fill-${index}`);
		expect(recall.shouldOmitResult("untracked", CODEMODE_TOOL_NAME)).toBe(true);
		recall.reset();
		expect(recall.shouldOmitResult("untracked", CODEMODE_TOOL_NAME)).toBe(false);
	});

	it("preserves unrelated leaf output and leaves untracked non-codemode wrappers alone", () => {
		const recall = saturated();
		start(recall, "overflowed", CODEMODE_TOOL_NAME);
		expect(recall.shouldOmitResult("held-child", "read")).toBe(false);
		expect(recall.shouldOmitResult("untracked-leaf", "bash")).toBe(false);
		expect(recall.shouldOmitResult("untracked-wrapper", NON_CODEMODE)).toBe(false);
	});
});

describe("recall correlation overflow aggregates", () => {
	it("keeps taint on a retained non-codemode aggregate discovered after overflow", () => {
		const recall = saturated();
		start(recall, "late-recall", RECALL_TOOL, "agg");
		expect(recall.shouldOmitResult("agg", NON_CODEMODE)).toBe(true);
	});

	it("omits a retained known aggregate by its structure, not its tool name", () => {
		const recall = saturated();
		start(recall, "extra-child", "read", "agg");
		expect(recall.shouldOmitResult("agg", NON_CODEMODE)).toBe(true);
	});
});
