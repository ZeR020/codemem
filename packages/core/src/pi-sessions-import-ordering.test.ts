/**
 * Unsafe pi JSONL overlap stays status "error" / partial_import: and leaves the
 * captured snapshot unchanged on the first import and the retry.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildTranscript, normalizeAdapterEvents } from "./ingest-transcript.js";
import { buildRawEventEnvelopeFromPiEvent } from "./pi-hooks.js";
import {
	importPiSessions,
	type PiImportProgress,
	stablePiMessageEntryId,
} from "./pi-sessions-import.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const SESSION_ID = "01a09a64-85ff-7444-9201-c22f263f3819";
const WALL = "2020-01-01T00:00:00.000Z";
const ORDERED = "User: earlier prompt\n\nAssistant: later reply";
const MESSAGES = [
	{ role: "user", text: "earlier prompt", timestamp: 1 },
	{ role: "assistant", text: "later reply", timestamp: 2 },
	{ role: "user", text: "followup", timestamp: 3 },
] as const;
type Fixture = { store: MemoryStore; dbPath: string; agentDir: string };
const cleanups: Array<{ store: MemoryStore; dir: string }> = [];

function messageAt(index: number) {
	const message = MESSAGES[index];
	if (!message) throw new Error(`bad index ${index}`);
	return message;
}

function setup(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "codemem-pi-order-"));
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	const agentDir = join(dir, "agent");
	mkdirSync(join(agentDir, "sessions"), { recursive: true });
	const store = new MemoryStore(dbPath);
	cleanups.push({ store, dir });
	return { store, dbPath, agentDir };
}

function ingest(fx: Fixture, payload: Record<string, unknown>, label: string): void {
	const built = buildRawEventEnvelopeFromPiEvent(payload);
	if (built === null) throw new Error(`expected ${label} envelope`);
	const seeded = ingestRawEvents({ db: fx.store.db }, built);
	if (seeded.inserted !== 1) throw new Error(`${label} seed failed`);
}

function capture(fx: Fixture, index: number): void {
	const message = messageAt(index);
	ingest(
		fx,
		{
			piEvent: "message_end",
			sessionId: SESSION_ID,
			entryId: stablePiMessageEntryId(SESSION_ID, message.role, message.text, message.timestamp),
			role: message.role,
			text: message.text,
			ts: WALL,
			cwd: "/tmp/repo",
		},
		"message",
	);
}

function shutdown(fx: Fixture): void {
	ingest(
		fx,
		{
			piEvent: "session_shutdown",
			sessionId: SESSION_ID,
			reason: "idle",
			ts: WALL,
			cwd: "/tmp/repo",
		},
		"shutdown",
	);
}

function markFlushed(fx: Fixture): void {
	fx.store.db
		.prepare(
			`UPDATE raw_event_sessions
			 SET last_flushed_event_seq = last_received_event_seq
			 WHERE source = 'pi' AND stream_id = ?`,
		)
		.run(SESSION_ID);
}

function writeSession(fx: Fixture, indexes: readonly number[]): void {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: SESSION_ID,
		timestamp: WALL,
		cwd: "/tmp/repo",
	});
	const lines = indexes.map((index) => {
		const message = messageAt(index);
		return JSON.stringify({
			type: "message",
			id: `m${index}`,
			timestamp: WALL,
			message: {
				role: message.role,
				content: [{ type: "text", text: message.text }],
				timestamp: message.timestamp,
			},
		});
	});
	writeFileSync(join(fx.agentDir, "sessions", "session.jsonl"), [header, ...lines].join("\n"));
}

function snapshot(fx: Fixture) {
	const flush = fx.store.rawEventFlushState(SESSION_ID, "pi");
	const events = fx.store.rawEventsSinceBySeq(SESSION_ID, "pi", -1);
	const pending = fx.store.rawEventsSinceBySeq(SESSION_ID, "pi", flush);
	return {
		seqs: events.map((event) => Number(event.event_seq)),
		pendingSeqs: pending.map((event) => Number(event.event_seq)),
		transcript: buildTranscript(normalizeAdapterEvents(events)),
		flush,
		session: fx.store.db.prepare("SELECT * FROM raw_event_sessions").all(),
		importRows: fx.store.db.prepare("SELECT * FROM pi_import_state").all(),
	};
}

function runImport(fx: Fixture) {
	const progress: PiImportProgress[] = [];
	const summary = importPiSessions({
		dbPath: fx.dbPath,
		agentDir: fx.agentDir,
		onProgress: (item) => progress.push(item),
	});
	const item = progress[0];
	return {
		status: item?.status ?? null,
		error: item?.error ?? null,
		inserted: summary.inserted,
		skipped: summary.skipped,
		filesErrored: summary.filesErrored,
		filesImported: summary.filesImported,
	};
}

const REJECTED = {
	status: "error",
	inserted: 0,
	skipped: 0,
	filesErrored: 1,
	filesImported: 0,
	error: expect.stringMatching(/^partial_import:/),
};

function expectRejectedUnchanged(fx: Fixture, before: ReturnType<typeof snapshot>): void {
	const first = runImport(fx);
	const afterFirst = snapshot(fx);
	const retry = runImport(fx);
	expect({ first, afterFirst, retry, afterRetry: snapshot(fx) }).toEqual({
		first: REJECTED,
		afterFirst: before,
		retry: REJECTED,
		afterRetry: before,
	});
}

afterEach(() => {
	for (const item of cleanups.splice(0)) {
		item.store.close();
		rmSync(item.dir, { recursive: true, force: true });
	}
});

describe("unsafe pi import overlap", () => {
	it.each(["pending", "flushed"] as const)("rejects missing earlier user when %s", (cursor) => {
		const fx = setup();
		capture(fx, 1);
		if (cursor === "flushed") markFlushed(fx);
		writeSession(fx, [0, 1]);
		expectRejectedUnchanged(fx, snapshot(fx));
	});

	it("rejects reversed stored duplicates before a new suffix", () => {
		const fx = setup();
		capture(fx, 1);
		capture(fx, 0);
		writeSession(fx, [0, 1, 2]);
		expectRejectedUnchanged(fx, snapshot(fx));
	});

	it("rejects a new suffix when live session_shutdown is the stored tail", () => {
		const fx = setup();
		capture(fx, 0);
		shutdown(fx);
		writeSession(fx, [0, 1]);
		expectRejectedUnchanged(fx, snapshot(fx));
	});

	it("rejects full history after purge leaves only the session high-water", () => {
		const fx = setup();
		capture(fx, 0);
		capture(fx, 1);
		markFlushed(fx);
		expect(fx.store.purgeRawEvents(1)).toBe(2);
		const before = snapshot(fx);
		expect(before.pendingSeqs).toEqual([]);
		expect(before.session).toMatchObject([
			{ last_received_event_seq: 1, last_flushed_event_seq: 1 },
		]);
		writeSession(fx, [0, 1]);
		expectRejectedUnchanged(fx, before);
	});

	it("rejects a new message between stored duplicates", () => {
		const fx = setup();
		capture(fx, 0);
		capture(fx, 2);
		writeSession(fx, [0, 1, 2]);
		expectRejectedUnchanged(fx, snapshot(fx));
	});

	it("rejects import below a metadata-only flush cursor", () => {
		const fx = setup();
		fx.store.updateRawEventFlushState(SESSION_ID, 1, "pi");
		const before = snapshot(fx);
		expect(before.seqs).toEqual([]);
		expect(before.session).toMatchObject([
			{ last_received_event_seq: -1, last_flushed_event_seq: 1 },
		]);
		writeSession(fx, [0, 1]);
		expectRejectedUnchanged(fx, before);
	});
});

describe("safe pi import order", () => {
	it("imports a fresh file in file order", () => {
		const fx = setup();
		writeSession(fx, [0, 1]);
		expect(runImport(fx)).toMatchObject({
			status: "imported",
			inserted: 2,
			skipped: 0,
			filesErrored: 0,
		});
		const after = snapshot(fx);
		expect(after.seqs).toEqual([0, 1]);
		expect(after.transcript).toBe(ORDERED);
	});

	it.each(["pending", "flushed"] as const)(
		"appends assistant after a captured user prefix when %s",
		(cursor) => {
			const fx = setup();
			capture(fx, 0);
			if (cursor === "flushed") markFlushed(fx);
			writeSession(fx, [0, 1]);
			expect(runImport(fx)).toMatchObject({
				status: "imported",
				inserted: 1,
				skipped: 1,
				filesErrored: 0,
			});
			const after = snapshot(fx);
			expect(after.seqs).toEqual([0, 1]);
			expect(after.transcript).toBe(ORDERED);
			expect(after.pendingSeqs).toEqual(cursor === "flushed" ? [1] : [0, 1]);
		},
	);
});
