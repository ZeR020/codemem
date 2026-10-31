/**
 * `RecallCorrelation` graph semantics: linking, taint propagation to ancestors,
 * completion ordering, and settle/reset boundaries.
 */
import { describe, expect, it } from "vitest";
import { RecallCorrelation } from "./recall-correlation.js";

const RECALL_TOOL = "mcp__codemem__memory_search";
const CODEMODE = "codemode";

function start(
	recall: RecallCorrelation,
	toolCallId: string,
	toolName = "bash",
	parentToolCallId?: string,
): void {
	recall.noteStart({ toolCallId, toolName, parentToolCallId });
}

describe("recall correlation graph", () => {
	it("taints the recall call and its codemode parent", () => {
		const recall = new RecallCorrelation();
		start(recall, "p", CODEMODE);
		start(recall, "c", RECALL_TOOL, "p");
		expect(recall.shouldOmitResult("c", RECALL_TOOL)).toBe(true);
		expect(recall.shouldOmitResult("p", CODEMODE)).toBe(true);
	});

	it("propagates taint through nested ancestors", () => {
		const recall = new RecallCorrelation();
		start(recall, "g", CODEMODE);
		start(recall, "p", CODEMODE, "g");
		start(recall, "c", RECALL_TOOL, "p");
		expect(recall.shouldOmitResult("c", RECALL_TOOL)).toBe(true);
		expect(recall.shouldOmitResult("p", CODEMODE)).toBe(true);
		expect(recall.shouldOmitResult("g", CODEMODE)).toBe(true);
	});

	it("links a parent placeholder created by a child start", () => {
		const recall = new RecallCorrelation();
		start(recall, "c", RECALL_TOOL, "late-parent");
		expect(recall.shouldOmitResult("late-parent", CODEMODE)).toBe(true);
		start(recall, "late-parent", CODEMODE);
		expect(recall.shouldOmitResult("late-parent", CODEMODE)).toBe(true);
	});
});

describe("recall correlation completion", () => {
	it("keeps a completed parent tainted while a child is active so later recall reaches ancestors", () => {
		const recall = new RecallCorrelation();
		start(recall, "g", CODEMODE);
		start(recall, "p", CODEMODE, "g");
		start(recall, "hold", "read", "p");
		recall.noteEnd("p");
		start(recall, "late", RECALL_TOOL, "p");
		expect(recall.shouldOmitResult("p", CODEMODE)).toBe(true);
		expect(recall.shouldOmitResult("g", CODEMODE)).toBe(true);
		recall.noteEnd("hold");
		recall.noteEnd("late");
		recall.noteEnd("g");
		expect(recall.shouldOmitResult("g", CODEMODE)).toBe(false);
	});

	it("clears a blocked call that ends without a result", () => {
		const recall = new RecallCorrelation();
		start(recall, "blocked", RECALL_TOOL);
		expect(recall.shouldOmitResult("blocked", RECALL_TOOL)).toBe(true);
		recall.noteEnd("blocked");
		expect(recall.shouldOmitResult("blocked", RECALL_TOOL)).toBe(false);
		expect(recall.shouldOmitResult("fresh", CODEMODE)).toBe(false);
	});
});

describe("recall correlation settle", () => {
	it("defers a turn reset while a tool execution is active", () => {
		const recall = new RecallCorrelation();
		start(recall, "g", CODEMODE);
		start(recall, "c", "read", "g");
		start(recall, "r", RECALL_TOOL, "c");
		recall.noteEnd("r");
		recall.settle();
		expect(recall.shouldOmitResult("g", CODEMODE)).toBe(true);
		recall.noteEnd("c");
		recall.noteEnd("g");
		expect(recall.shouldOmitResult("g", CODEMODE)).toBe(false);
	});

	it("hard-resets retained taint immediately on an explicit reset", () => {
		const recall = new RecallCorrelation();
		start(recall, "r", RECALL_TOOL);
		expect(recall.shouldOmitResult("r", RECALL_TOOL)).toBe(true);
		recall.reset();
		expect(recall.shouldOmitResult("r", RECALL_TOOL)).toBe(false);
	});
});
