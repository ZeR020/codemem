import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect, type Database } from "./db.js";
import { buildRawEventEnvelopeFromPiEvent } from "./pi-hooks.js";
import { searchPiSessions } from "./pi-session-search.js";
import { initTestSchema } from "./test-utils.js";

let db: Database;
beforeEach(() => {
	db = connect(":memory:");
	initTestSchema(db);
});
afterEach(() => db.close());

function seedText(sessionId: string, text: string): void {
	const envelope = buildRawEventEnvelopeFromPiEvent({
		piEvent: "message_end",
		sessionId,
		entryId: "m1",
		role: "user",
		text,
		ts: "2026-04-01T12:00:00.000Z",
	});
	if (!envelope) throw new Error("expected message envelope");
	db.prepare(
		"INSERT INTO raw_events(source, stream_id, opencode_session_id, event_id, event_seq, event_type, payload_json, created_at) VALUES ('pi', ?, ?, 'm1', 1, 'pi.hook', ?, '2026-04-01T12:00:00.000Z')",
	).run(sessionId, sessionId, JSON.stringify(envelope.payload));
}

describe("searchPiSessions effective-token bounds", () => {
	it("handles a query above SQLite's expression-depth limit on an empty store", () => {
		const query = Array.from({ length: 1100 }, (_, i) => `token${i}`).join(" ");
		const response = searchPiSessions(db, query);
		expect(response.results).toEqual([]);
		expect(response.total_matches).toBe(0);
		expect(response.query_truncated).toBe(true);
		expect(response.truncated).toBe(true);
		expect(response.query).toBe(query);
	});

	it("matches the 64th effective token but not discarded tokens", () => {
		seedText("retained", "lastincluded");
		seedText("discarded", "discardedneedle");
		const query = [
			"the AND",
			...Array.from({ length: 63 }, (_, i) => `unused${i}`),
			"lastincluded",
			"discardedneedle",
		].join(" ");
		const response = searchPiSessions(db, query);
		expect(response.results.map((match) => match.session_id)).toEqual(["retained"]);
		expect(response.total_matches).toBe(1);
		expect(response.query_truncated).toBe(true);
		expect(response.truncated).toBe(true);
		expect(response.query).toBe(query);
	});

	it("does not mark a query with exactly 64 effective tokens as shortened", () => {
		seedText("retained", "lastincluded");
		const query = [...Array.from({ length: 63 }, (_, i) => `unused${i}`), "lastincluded"].join(" ");
		const response = searchPiSessions(db, query);
		expect(response.returned).toBe(1);
		expect(response.query_truncated).toBe(false);
		expect(response.truncated).toBe(false);
	});
});

describe("searchPiSessions effective-input bounds", () => {
	it.each([false, true])(
		"matches only inside the 8192-character input bound (overflow: %s)",
		(overflow) => {
			seedText("retained", "needle");
			seedText("discarded", "omittedterm");
			const prefix = `${" ".repeat(8186)}needle`;
			const query = overflow ? `${prefix} omittedterm` : prefix;
			const response = searchPiSessions(db, query);
			expect(response.results.map((match) => match.session_id)).toEqual(["retained"]);
			expect(response.total_matches).toBe(1);
			expect(response.query_truncated).toBe(overflow);
			expect(response.truncated).toBe(overflow);
			expect(response.query).toBe(query);
		},
	);

	it("bounds a single token above SQLite's LIKE-pattern limit", () => {
		seedText("retained", "q".repeat(8192));
		const response = searchPiSessions(db, "q".repeat(60_000));
		expect(response.total_matches).toBe(1);
		expect(response.query_truncated).toBe(true);
		expect(response.truncated).toBe(true);
		expect(JSON.stringify(response).length).toBeLessThanOrEqual(50_000);
	});

	it("marks shortened tokenless input separately from its unshortened display echo", () => {
		const query = "\u0000".repeat(8300);
		const response = searchPiSessions(db, query);
		expect(response.results).toEqual([]);
		expect(response.query_truncated).toBe(true);
		expect(response.truncated).toBe(true);
		expect(response.query).toBe(query);
		expect(JSON.stringify(response).length).toBeLessThanOrEqual(50_000);
	});
});
