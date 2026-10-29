/**
 * Bounded per-session correlation of pi tool calls, so a codemode aggregate that
 * contains codemem recall output keeps that content out of the ingest payload.
 * Fail-closed: bound exhaustion suppresses aggregate content until a safe reset.
 */
import { normalizePiMcpMemoryToolName } from "./payloads.js";

export const CODEMODE_TOOL_NAME = "codemode";
/** Hard bound on retained call nodes; overflow is sticky until a reset. */
export const MAX_CORRELATED_CALLS = 256;

type CorrelatedCall = {
	parentToolCallId: string | null;
	tainted: boolean;
	/** Ever hosted a child call; survives child completion so overflow stays conservative. */
	aggregate: boolean;
	completed: boolean;
	/** Retained direct children keep a completed node alive for late taint. */
	children: number;
};

export type CorrelatedCallStart = {
	toolCallId: string;
	toolName: string;
	parentToolCallId?: string;
};

export class RecallCorrelation {
	private readonly calls = new Map<string, CorrelatedCall>();
	private activeExecutions = 0;
	private pendingReset = false;
	private overflow = false;

	/** pi emits the start before tool_call, so taint is known before any result arrives. */
	noteStart(input: CorrelatedCallStart): void {
		this.activeExecutions += 1;
		const isRecall = normalizePiMcpMemoryToolName(input.toolName) !== null;
		const parentToolCallId = input.parentToolCallId ?? null;
		const node = this.ensure(input.toolCallId);
		if (!node) {
			this.markAggregateParent(parentToolCallId, isRecall);
			return;
		}
		if (parentToolCallId !== null) this.link(input.toolCallId, parentToolCallId);
		if (isRecall) this.taint(input.toolCallId);
	}

	/** Ends also cover blocked/invalid calls that never reach tool_result. */
	noteEnd(toolCallId: string): void {
		this.activeExecutions = Math.max(0, this.activeExecutions - 1);
		const node = this.calls.get(toolCallId);
		if (node) {
			node.completed = true;
			this.prune(toolCallId);
		}
		if (this.activeExecutions === 0 && this.pendingReset) this.reset();
	}

	/** Tainted calls always omit; overflow keeps known aggregates conservative, never clears taint. */
	shouldOmitResult(toolCallId: string, toolName: string): boolean {
		const node = this.calls.get(toolCallId);
		if (node?.tainted === true) return true;
		if (!this.overflow) return false;
		return node?.aggregate === true || toolName === CODEMODE_TOOL_NAME;
	}

	/** Turn boundary and run teardown reset only when no tool execution is outstanding. */
	settle(): void {
		if (this.activeExecutions > 0) {
			this.pendingReset = true;
			return;
		}
		this.reset();
	}

	reset(): void {
		this.calls.clear();
		this.activeExecutions = 0;
		this.pendingReset = false;
		this.overflow = false;
	}

	private ensure(toolCallId: string): CorrelatedCall | null {
		const existing = this.calls.get(toolCallId);
		if (existing) return existing;
		if (this.calls.size >= MAX_CORRELATED_CALLS) {
			this.overflow = true;
			return null;
		}
		const node: CorrelatedCall = {
			parentToolCallId: null,
			tainted: false,
			aggregate: false,
			completed: false,
			children: 0,
		};
		this.calls.set(toolCallId, node);
		return node;
	}

	private markAggregateParent(parentToolCallId: string | null, isRecall: boolean): void {
		if (parentToolCallId === null) return;
		const parent = this.ensure(parentToolCallId);
		if (!parent) return;
		parent.aggregate = true;
		if (isRecall) this.taint(parentToolCallId);
	}

	private link(toolCallId: string, parentToolCallId: string): void {
		if (parentToolCallId === toolCallId) return;
		const node = this.calls.get(toolCallId);
		if (!node || node.parentToolCallId === parentToolCallId) return;
		if (node.parentToolCallId) this.detach(node.parentToolCallId);
		node.parentToolCallId = parentToolCallId;
		const parent = this.ensure(parentToolCallId);
		if (!parent) return;
		parent.aggregate = true;
		parent.children += 1;
		if (node.tainted) this.taint(parentToolCallId);
	}

	private taint(toolCallId: string): void {
		const seen = new Set<string>();
		let current: string | null = toolCallId;
		while (current !== null) {
			if (seen.has(current)) return;
			seen.add(current);
			const node = this.calls.get(current);
			if (!node || node.tainted) return;
			node.tainted = true;
			current = node.parentToolCallId;
		}
	}

	private detach(parentToolCallId: string): void {
		const parent = this.calls.get(parentToolCallId);
		if (!parent) return;
		parent.children = Math.max(0, parent.children - 1);
		this.prune(parentToolCallId);
	}

	private prune(toolCallId: string): void {
		let current: string | null = toolCallId;
		while (current !== null) {
			const node = this.calls.get(current);
			if (!node?.completed || node.children > 0) return;
			this.calls.delete(current);
			current = node.parentToolCallId;
			const parent = current === null ? undefined : this.calls.get(current);
			if (!parent) return;
			parent.children = Math.max(0, parent.children - 1);
		}
	}
}
