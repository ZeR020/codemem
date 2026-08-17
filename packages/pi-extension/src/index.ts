/**
 * @codemem/pi-extension — pi coding-agent extension factory.
 *
 * Lifecycle (pi enforced):
 *   - Factory body wires handlers only. No sockets/timers/watchers/child processes.
 *   - Viewer auto-start begins on session_start (or first need).
 *   - Idempotent cleanup on session_shutdown.
 *   - Re-key session state from ctx.sessionManager.getSessionId() every session_start.
 *   - Durable ingest cursors via pi.appendEntry.
 *
 * Surfaces:
 *   - Ingest → POST /api/pi-hooks → CLI pi-hook-ingest
 *   - Injection → before_agent_start systemPrompt append only (never message)
 *   - Native memory tools are not registered in this slice

 *   - session_before_compact → flush signal only (never return compaction)
 */

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
	CLI_PACK_TIMEOUT_MS,
	type ExecCodememFn,
	type IngestOutcome,
	type PackFetch,
	PiCodememClient,
} from "./client.js";
import { loadPiExtensionConfig, type PiExtensionConfig } from "./config.js";
import {
	buildBeforeCompactPayload,
	buildMessageEndPayload,
	buildSessionShutdownPayload,
	buildSessionStartPayload,
	buildToolCallPayload,
	buildToolResultPayload,
	extractMessageRole,
	extractMessageText,
	formatPiInjectionBlock,
	type PiHookPayload,
	serializeToolOutput,
	stableMessageEntryId,
} from "./payloads.js";
import { createViewerRuntime, stopViewerTracking, type ViewerRuntime } from "./viewer.js";

/** Test-only CLI override. Null in production. */
let testExecImpl: ExecCodememFn | null = null;

/** @internal test helper — inject codemem CLI behavior without spawning. */
export function __setTestExecImpl(fn: ExecCodememFn | null): void {
	testExecImpl = fn;
}

const CURSOR_CUSTOM_TYPE = "codemem.cursor";
const CURSOR_VERSION = 1;

/** Flush-only signals — never durable-deduped; unique per firing. */
const PI_FLUSH_ONLY_EVENTS = new Set(["session_before_compact"]);

type CursorState = {
	sessionId: string;
	seenEventKeys: string[];
};

type SessionState = {
	sessionId: string | null;
	cwd: string;
	project: string | null;
	active: boolean;
	seenEventKeys: Set<string>;
	/** Monotonic counter for unique flush-only compact entry ids. */
	compactSeq: number;
	/**
	 * Monotonic counter for message_end entry ids when the ending message has no
	 * usable timestamp. Distinguishes intentional identical prompts in-session.
	 * Never a content-only hash — always paired with a discriminator.
	 */
	messageSeq: number;
	/** toolCallId → { toolName, input } for pairing results */
	toolCalls: Map<string, { toolName: string; input: Record<string, unknown> }>;
};

function createSessionState(): SessionState {
	return {
		sessionId: null,
		cwd: process.cwd(),
		project: null,
		active: false,
		seenEventKeys: new Set(),
		compactSeq: 0,
		messageSeq: 0,
		toolCalls: new Map(),
	};
}

function isFlushOnlyPayload(payload: PiHookPayload): boolean {
	const piEvent = typeof payload.piEvent === "string" ? payload.piEvent.trim() : "";
	return PI_FLUSH_ONLY_EVENTS.has(piEvent);
}

function eventKey(payload: PiHookPayload): string {
	const sessionId = String(payload.sessionId ?? "");
	const piEvent = String(payload.piEvent ?? "");
	const entryId = String(payload.entryId ?? "");
	const toolCallId = String(payload.toolCallId ?? "");
	const role = String(payload.role ?? "");
	return `${sessionId}|${piEvent}|${entryId}|${toolCallId}|${role}`;
}

function loadCursorsFromSession(ctx: ExtensionContext, sessionId: string): Set<string> {
	const seen = new Set<string>();
	try {
		const entries = ctx.sessionManager.getEntries();
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			const custom = entry as { customType?: string; data?: unknown };
			if (custom.customType !== CURSOR_CUSTOM_TYPE) continue;
			const data = custom.data as CursorState | undefined;
			if (!data || data.sessionId !== sessionId) continue;
			if (Array.isArray(data.seenEventKeys)) {
				for (const key of data.seenEventKeys) {
					if (typeof key === "string" && key) seen.add(key);
				}
			}
		}
	} catch {
		// getEntries may throw on ephemeral sessions
	}
	return seen;
}

function persistCursor(pi: ExtensionAPI, sessionId: string, seenEventKeys: Set<string>): void {
	// Cap growth — keep the most recent keys only.
	const keys = [...seenEventKeys];
	const trimmed = keys.length > 500 ? keys.slice(keys.length - 500) : keys;
	try {
		pi.appendEntry(CURSOR_CUSTOM_TYPE, {
			v: CURSOR_VERSION,
			sessionId,
			seenEventKeys: trimmed,
			ts: new Date().toISOString(),
		});
	} catch {
		// best-effort persistence
	}
}

async function safeIngest(
	client: PiCodememClient,
	payload: PiHookPayload,
	state: SessionState,
	pi: ExtensionAPI,
	signal?: AbortSignal,
): Promise<void> {
	if (!state.active || !state.sessionId) return;
	const flushOnly = isFlushOnlyPayload(payload);
	const key = eventKey(payload);
	// Flush signals fire every compaction — never suppress via seen cursor.
	if (!flushOnly && state.seenEventKeys.has(key)) return;
	try {
		const outcome: IngestOutcome = await client.ingest(payload, signal);
		// Mark seen + durable cursor ONLY after successful delivery. A failed
		// attempt must remain unmarked so the next delivery (or session_start
		// resume without a stale cursor entry) can retry.
		if (!outcome.ok) return;
		if (flushOnly) return;
		state.seenEventKeys.add(key);
		persistCursor(pi, state.sessionId, state.seenEventKeys);
	} catch {
		// fail-open: never break the pi session; leave unseen on throw
	}
}

function resolveProject(cwd: string, envProject?: string | null): string | null {
	const fromEnv = envProject?.trim() || process.env.CODEMEM_PROJECT?.trim();
	if (fromEnv) return fromEnv;
	return PiCodememClient.projectFromCwd(cwd);
}

function readPathFromToolInput(input: Record<string, unknown>): string | null {
	for (const key of ["path", "file_path", "filePath"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

/**
 * Extension factory. Default export required by pi package loader.
 */
export default function codememPiExtension(pi: ExtensionAPI): void {
	const config: PiExtensionConfig = loadPiExtensionConfig();
	const runtime: ViewerRuntime = createViewerRuntime();
	const state = createSessionState();
	const client = new PiCodememClient(config, runtime, {
		cwd: state.cwd,
		project: state.project,
		sessionId: state.sessionId,
		execImpl: testExecImpl,
	});

	// ---- session_start ----
	pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const cwd = ctx.cwd || process.cwd();
		const project = resolveProject(cwd);

		state.sessionId = sessionId;
		state.cwd = cwd;
		state.project = project;
		state.active = true;
		state.toolCalls.clear();
		state.seenEventKeys = loadCursorsFromSession(ctx, sessionId);
		client.rekey(sessionId, cwd, project);

		// Start viewer on first session need (not in factory).
		void client.ensureViewer(ctx.signal).catch(() => {});

		const payload = buildSessionStartPayload({
			sessionId,
			cwd,
			project,
			reason: event.reason,
		});
		await safeIngest(client, payload, state, pi, ctx.signal);
	});

	// ---- session_shutdown ----
	pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
		const sessionId = state.sessionId ?? ctx.sessionManager.getSessionId();
		if (sessionId) {
			const payload = buildSessionShutdownPayload({
				sessionId,
				cwd: state.cwd || ctx.cwd,
				project: state.project,
				reason: event.reason,
			});
			await safeIngest(client, payload, { ...state, active: true, sessionId }, pi, ctx.signal);
		}
		state.active = false;
		state.toolCalls.clear();
		stopViewerTracking(runtime);
	});

	// ---- message_end (user → prompt, assistant → assistant) ----
	pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (!state.active || !state.sessionId) return;
		const role = extractMessageRole(event.message);
		if (role !== "user" && role !== "assistant") return;
		const text = extractMessageText(event.message);
		if (!text) return;

		// Identity for message_end (pi-ai 0.84.x):
		// UserMessage/AssistantMessage expose role/content/timestamp only — no id or
		// index field. message_end also fires BEFORE the message is persisted, so
		// sessionManager.getLeafEntry() is the PREVIOUS entry (often a tool result or
		// our own codemem.cursor custom entry from persistCursor) and must never be
		// used as identity.
		//
		// entryId = stableMessageEntryId(sessionId, role, text, discriminator):
		//   1. message.timestamp — retry-stable (same logical message keeps the same
		//      timestamp across handler retries; distinct across turns)
		//   2. else per-session monotonic messageSeq (fresh discriminator per firing)
		// Content hash alone is never an id on its own.
		const msg = event.message as { timestamp?: unknown };
		let discriminator: string | number;
		if (typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp)) {
			discriminator = msg.timestamp;
		} else {
			state.messageSeq += 1;
			discriminator = `n:${state.messageSeq}`;
		}
		const entryId = stableMessageEntryId(state.sessionId, role, text, discriminator);

		const payload = buildMessageEndPayload({
			sessionId: state.sessionId,
			cwd: state.cwd || ctx.cwd,
			project: state.project,
			entryId,
			role,
			text,
		});
		if (!payload) return;
		await safeIngest(client, payload, state, pi, ctx.signal);
	});

	// ---- tool_call (ingest + track; file_context is applied on tool_result) ----
	pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
		if (!state.active || !state.sessionId) return;
		const toolName = event.toolName;
		const toolCallId = event.toolCallId;
		const toolInput =
			event.input != null && typeof event.input === "object"
				? (event.input as Record<string, unknown>)
				: {};
		state.toolCalls.set(toolCallId, { toolName, input: toolInput });

		const payload = buildToolCallPayload({
			sessionId: state.sessionId,
			cwd: state.cwd || ctx.cwd,
			project: state.project,
			toolCallId,
			toolName,
			toolInput,
		});
		await safeIngest(client, payload, state, pi, ctx.signal);
		// Do not block or mutate — return undefined.
	});

	// ---- tool_result (ingest + optional file-context append for read) ----
	pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
		if (!state.active || !state.sessionId) return;
		const tracked = state.toolCalls.get(event.toolCallId);
		const toolName = event.toolName;
		const toolInput =
			event.input != null && typeof event.input === "object"
				? (event.input as Record<string, unknown>)
				: (tracked?.input ?? {});
		state.toolCalls.delete(event.toolCallId);

		const payload = buildToolResultPayload({
			sessionId: state.sessionId,
			cwd: state.cwd || ctx.cwd,
			project: state.project,
			toolCallId: event.toolCallId,
			toolName,
			toolInput,
			toolOutput: serializeToolOutput(event.content),
			isError: Boolean(event.isError),
			error: event.isError ? serializeToolOutput(event.content) : null,
		});
		await safeIngest(client, payload, state, pi, ctx.signal);

		// File-context: attach relevant memories when read completes (fail-open).
		if (config.fileContext && toolName === "read" && !event.isError) {
			const path = readPathFromToolInput(toolInput);
			if (path) {
				try {
					const fileCtx = await fetchFileContextBlock(client, path, ctx.signal);
					if (fileCtx.text.trim()) {
						const block = fileCtx.preformatted
							? fileCtx.text
							: formatPiInjectionBlock(fileCtx.text, 4_000);
						const existing = Array.isArray(event.content) ? [...event.content] : [];
						return {
							content: [...existing, { type: "text" as const, text: `\n\n${block}` }],
						};
					}
				} catch {
					// fail-open
				}
			}
		}
	});

	// ---- session_before_compact: flush only, NEVER return compaction ----
	pi.on(
		"session_before_compact",
		async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
			if (!state.sessionId) return;
			// Unique per firing so repeated compactions are not collapsed by keying.
			state.compactSeq += 1;
			const payload = buildBeforeCompactPayload({
				sessionId: state.sessionId,
				cwd: state.cwd || ctx.cwd,
				project: state.project,
				reason: event.reason,
				entryId: `session_before_compact:${state.compactSeq}`,
			});
			// Flush-only: CLI path (HTTP cannot flush). Not durable-deduped.
			// Observe-only — never return { compaction }.
			await safeIngest(client, payload, state, pi, event.signal ?? ctx.signal);
		},
	);

	// ---- before_agent_start: systemPrompt append only (D4) ----
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
		if (!config.injectPrompts) return;
		try {
			const prompt = typeof event.prompt === "string" ? event.prompt : "";
			if (!prompt.trim()) return;

			const packFetch = await client.fetchPackText(prompt, ctx.signal);
			if (!packFetch.text.trim()) return;

			// pi-hook-inject already returns the full ## block (preformatted);
			// HTTP pack / pack --json return bare text that must be framed here.
			const block = packFetch.preformatted
				? packFetch.text
				: formatPiInjectionBlock(packFetch.text, config.injectMaxChars);
			if (!block.trim()) return;

			const base = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
			return {
				systemPrompt: base ? `${base}\n\n${block}` : block,
			};
		} catch {
			// fail-open: no mutation
			return;
		}
	});
}

/**
 * Best-effort file context via claude-hook-file-context CLI (same store query)
 * or a small pack keyed on the path.
 */
async function fetchFileContextBlock(
	client: PiCodememClient,
	filePath: string,
	signal?: AbortSignal,
): Promise<PackFetch> {
	try {
		const { stdout } = await client.execCodemem(["claude-hook-file-context"], {
			stdin: JSON.stringify({
				tool_input: { file_path: filePath },
				cwd: client.cwd,
			}),
			signal,
			timeoutMs: CLI_PACK_TIMEOUT_MS,
		});
		const trimmed = stdout.trim();
		if (trimmed) {
			try {
				const parsed = JSON.parse(trimmed) as {
					hookSpecificOutput?: { additionalContext?: string };
				};
				const ctx = parsed.hookSpecificOutput?.additionalContext?.trim();
				if (ctx) return { text: ctx, preformatted: false };
			} catch {
				// not JSON
			}
		}
	} catch {
		// fall through
	}

	try {
		return await client.fetchPackText(filePath, signal);
	} catch {
		return { text: "", preformatted: false };
	}
}

export { errorResult, jsonResult, PiCodememClient, textResult } from "./client.js";
// Named exports for tests / advanced hosts.
export { defaultPiExtensionConfig, loadPiExtensionConfig } from "./config.js";
export { MEMORY_LEARN_PAYLOAD } from "./learn.js";
export {
	buildBeforeCompactPayload,
	buildMessageEndPayload,
	buildSessionShutdownPayload,
	buildSessionStartPayload,
	buildToolCallPayload,
	buildToolResultPayload,
	CODEMEM_MEMORIES_HEADER,
	extractMessageRole,
	extractMessageText,
	formatPiInjectionBlock,
	stableMessageEntryId,
} from "./payloads.js";
