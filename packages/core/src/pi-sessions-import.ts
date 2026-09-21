/**
 * Historical pi session JSONL import (design D2/D3).
 *
 * Reads pi coding-agent session files (`<pi-agent-dir>/sessions/<project>/*.jsonl`,
 * honoring PI_CODING_AGENT_DIR via resolvePiAgentDir) and backfills their
 * user/assistant text messages into the standard raw-event pipeline with
 * source "pi" — the same ingestRawEvents path the viewer route and CLI
 * spool flush use for live events.
 *
 * Dedup contract: each message is ingested as a `message_end` pi hook
 * payload — the exact shape packages/pi-extension emits live — so
 * mapPiEventPayload derives the identical `pi_evt_` id and the raw_events
 * unique index (source, stream_id, event_id) collapses re-imports into
 * live captures. entryId mirrors stableMessageEntryId in
 * packages/pi-extension/src/payloads.ts (core cannot depend on the
 * extension package; keep the two formulas in sync).
 */

import { createHash } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { connect, type Database } from "./db.js";
import { atomicReplaceConfigFile } from "./observer-config.js";
import { buildRawEventEnvelopeFromPiEvent, type PiHookRawEventEnvelope } from "./pi-hooks.js";
import { resolvePiAgentDir } from "./pi-observer-config.js";
import { ingestRawEvents } from "./raw-event-ingest.js";

/** A user/assistant text message extracted from a session JSONL entry. */
export interface PiSessionMessage {
	role: "user" | "assistant";
	text: string;
	/** Entry-level ISO timestamp; null when the entry carries none. */
	ts: string | null;
	/** Persisted message.timestamp (epoch ms) — the live entryId discriminator. */
	discriminator: string | number | null;
}

/** Parsed session file: header identity plus importable messages. */
export interface ParsedPiSession {
	sessionId: string;
	cwd: string | null;
	messages: PiSessionMessage[];
}

export interface PiImportProgress {
	file: string;
	status: "imported" | "unchanged" | "empty" | "error";
	inserted: number;
	skipped: number;
	error: string | null;
}

export interface PiImportSummary {
	filesScanned: number;
	filesImported: number;
	filesUnchanged: number;
	filesEmpty: number;
	filesErrored: number;
	inserted: number;
	skipped: number;
}

export interface ImportPiSessionsOptions {
	dbPath: string;
	/** Pi agent dir override; defaults to resolvePiAgentDir() (PI_CODING_AGENT_DIR / ~/.pi/agent). */
	agentDir?: string;
	/** Import state file override; defaults to a JSON file beside the database. */
	statePath?: string;
	/** Called once per scanned file so the CLI can surface progress. */
	onProgress?: (progress: PiImportProgress) => void;
}

interface PiImportStateEntry {
	size: number;
	mtimeMs: number;
}

type PiImportState = Record<string, PiImportStateEntry>;

/**
 * Mirror of stableMessageEntryId (packages/pi-extension/src/payloads.ts):
 * sha256 of (sessionId \0 role \0 text [\0 discriminator]) → `msg-` + 24 hex.
 * Must stay byte-identical to the extension's live formula so imported
 * message ids collide with live event ids by design (D2).
 */
export function stablePiMessageEntryId(
	sessionId: string,
	role: string,
	text: string,
	discriminator?: string | number | null,
): string {
	const hash = createHash("sha256")
		.update(sessionId, "utf8")
		.update("\0")
		.update(role, "utf8")
		.update("\0")
		.update(text, "utf8");
	if (discriminator != null && String(discriminator) !== "") {
		hash.update("\0").update(String(discriminator), "utf8");
	}
	return `msg-${hash.digest("hex").slice(0, 24)}`;
}

/** Mirror of the extension's extractMessageText: text blocks only, "\n"-joined, trimmed. */
function extractPiMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block == null || typeof block !== "object") continue;
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			const t = b.text.trim();
			if (t) parts.push(t);
		}
	}
	return parts.join("\n").trim();
}

/**
 * Coerce one JSONL entry to an importable message. Returns null for
 * non-message entries, non-user/assistant roles (toolResult), and
 * messages without text blocks (thinking/toolCall/toolResult only).
 */
function coercePiSessionMessage(entry: Record<string, unknown>): PiSessionMessage | null {
	const rawMessage = entry.message;
	if (rawMessage == null || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
		return null;
	}
	const message = rawMessage as Record<string, unknown>;
	const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
	if (role !== "user" && role !== "assistant") return null;
	const text = extractPiMessageText(message);
	if (!text) return null;
	const rawTs = entry.timestamp;
	const ts = typeof rawTs === "string" && rawTs.trim() ? rawTs.trim() : null;
	const rawDiscriminator = message.timestamp;
	const discriminator =
		typeof rawDiscriminator === "number" && Number.isFinite(rawDiscriminator)
			? rawDiscriminator
			: null;
	return { role, text, ts, discriminator };
}

/**
 * Parse pi session JSONL content. Returns null when no session header
 * (type:"session" with id) is present — the id is required to derive
 * event ids. Malformed lines and unsupported entries are skipped.
 */
function parsePiSessionLine(
	record: Record<string, unknown>,
	messages: PiSessionMessage[],
): { id: string; cwd: string | null } | null {
	if (record.type === "session") {
		const id = record.id;
		if (typeof id === "string" && id.trim()) {
			const rawCwd = record.cwd;
			return {
				id: id.trim(),
				cwd: typeof rawCwd === "string" && rawCwd.trim() ? rawCwd.trim() : null,
			};
		}
		return null;
	}
	if (record.type !== "message") return null;
	const message = coercePiSessionMessage(record);
	if (message) messages.push(message);
	return null;
}

export function parsePiSessionJsonl(content: string): ParsedPiSession | null {
	let sessionId: string | null = null;
	let cwd: string | null = null;
	const messages: PiSessionMessage[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const header = parsePiSessionLine(entry as Record<string, unknown>, messages);
		if (header) {
			sessionId = header.id;
			if (header.cwd) cwd = header.cwd;
		}
	}
	if (!sessionId) return null;
	return { sessionId, cwd, messages };
}

/** Build the live-shaped message_end hook payload for one imported message. */
function piImportPayload(
	parsed: ParsedPiSession,
	message: PiSessionMessage,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		piEvent: "message_end",
		sessionId: parsed.sessionId,
		entryId: stablePiMessageEntryId(
			parsed.sessionId,
			message.role,
			message.text,
			message.discriminator,
		),
		role: message.role,
		text: message.text,
	};
	if (message.ts) payload.ts = message.ts;
	if (parsed.cwd) payload.cwd = parsed.cwd;
	return payload;
}

/**
 * Ingest one parsed session through the standard pipeline: envelopes built
 * by buildRawEventEnvelopeFromPiEvent (identical ids/attribution to live),
 * batched into a single ingestRawEvents transaction for the file.
 */
function ingestPiSessionFile(
	db: Database,
	parsed: ParsedPiSession,
): { inserted: number; skipped: number; count: number } {
	const envelopes: PiHookRawEventEnvelope[] = [];
	let first: PiHookRawEventEnvelope | null = null;
	for (const message of parsed.messages) {
		const envelope = buildRawEventEnvelopeFromPiEvent(piImportPayload(parsed, message));
		if (!envelope) continue;
		envelopes.push(envelope);
		first = first ?? envelope;
	}
	if (!first) return { inserted: 0, skipped: 0, count: 0 };
	const result = ingestRawEvents(
		{ db },
		{
			source: "pi",
			session_stream_id: parsed.sessionId,
			session_id: parsed.sessionId,
			opencode_session_id: parsed.sessionId,
			cwd: first.cwd,
			project: first.project,
			events: envelopes.map((envelope) => ({
				event_type: envelope.event_type,
				event_id: envelope.event_id,
				payload: envelope.payload,
				ts_wall_ms: envelope.ts_wall_ms,
				cwd: envelope.cwd,
				project: envelope.project,
			})),
		},
	);
	return { inserted: result.inserted, skipped: result.skipped, count: envelopes.length };
}

/** Recursively list *.jsonl files under the sessions dir (project subdirs included). */
function listPiSessionFiles(sessionsDir: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
		}
	};
	walk(sessionsDir);
	return files.sort();
}

function loadPiImportState(statePath: string): PiImportState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(statePath, "utf-8"));
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		return parsed as PiImportState;
	} catch {
		return {};
	}
}

function savePiImportState(statePath: string, state: PiImportState): void {
	mkdirSync(dirname(statePath), { recursive: true });
	atomicReplaceConfigFile(statePath, JSON.stringify(state), undefined);
}

function isUnchanged(state: PiImportState, file: string, stat: Stats): boolean {
	const entry = state[file];
	return entry != null && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs;
}

/**
 * Import one session file. Stat is taken BEFORE reading so a file appended
 * mid-import always records a stale (smaller) size and is reprocessed —
 * never skipped with unread tail lines.
 */
function importPiSessionFile(db: Database, file: string, state: PiImportState): PiImportProgress {
	let stat: Stats;
	try {
		stat = statSync(file);
	} catch (error) {
		return {
			file,
			status: "error",
			inserted: 0,
			skipped: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (isUnchanged(state, file, stat)) {
		return { file, status: "unchanged", inserted: 0, skipped: 0, error: null };
	}
	try {
		const parsed = parsePiSessionJsonl(readFileSync(file, "utf-8"));
		if (!parsed || parsed.messages.length === 0) {
			state[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
			return { file, status: "empty", inserted: 0, skipped: 0, error: null };
		}
		const result = ingestPiSessionFile(db, parsed);
		state[file] = { size: stat.size, mtimeMs: stat.mtimeMs };
		return {
			file,
			status: "imported",
			inserted: result.inserted,
			skipped: result.skipped,
			error: null,
		};
	} catch (error) {
		return {
			file,
			status: "error",
			inserted: 0,
			skipped: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Default persisted size/mtime state location: a JSON file beside the database. */
function defaultPiImportStatePath(dbPath: string): string {
	return join(dirname(dbPath), "pi-import-sessions.json");
}

/**
 * Import all pi session files under the resolved sessions dir. Idempotent:
 * unchanged files (size/mtime) are skipped via the persisted state, and
 * reprocessed files dedupe by deterministic event id in the raw_events
 * unique index. Returns a summary; per-file progress flows through onProgress.
 */
export function importPiSessions(options: ImportPiSessionsOptions): PiImportSummary {
	const piDir = options.agentDir
		? resolvePiAgentDir({ piDir: options.agentDir })
		: resolvePiAgentDir();
	const sessionsDir = join(piDir, "sessions");
	const statePath = options.statePath ?? defaultPiImportStatePath(options.dbPath);
	const state = loadPiImportState(statePath);
	const files = listPiSessionFiles(sessionsDir);
	const summary: PiImportSummary = {
		filesScanned: files.length,
		filesImported: 0,
		filesUnchanged: 0,
		filesEmpty: 0,
		filesErrored: 0,
		inserted: 0,
		skipped: 0,
	};
	const db = connect(options.dbPath);
	try {
		for (const file of files) {
			const progress = importPiSessionFile(db, file, state);
			if (progress.status === "imported") summary.filesImported += 1;
			else if (progress.status === "unchanged") summary.filesUnchanged += 1;
			else if (progress.status === "empty") summary.filesEmpty += 1;
			else summary.filesErrored += 1;
			summary.inserted += progress.inserted;
			summary.skipped += progress.skipped;
			options.onProgress?.(progress);
		}
	} finally {
		db.close();
	}
	savePiImportState(statePath, state);
	return summary;
}
