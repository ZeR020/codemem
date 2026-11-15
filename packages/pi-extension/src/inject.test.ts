import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecCodememFn, PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig, type PiExtensionConfig } from "./config.js";
import { createPiInjector, MCP_DISCOVERY_HINT, type PiContextMessage } from "./inject.js";
import { CODEMEM_MEMORIES_HEADER } from "./payloads.js";
import { createViewerRuntime } from "./viewer.js";

/** A valid renderer fingerprint is sha256-shaped in span validation. */
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

type QueuedResponse = string | Error;

/**
 * Counting CLI spy: each queued response is returned (or thrown) for one pack
 * transport call (`pack --json` or `pi-hook-inject`). Fetch count = number of
 * pack-transport spawns.
 */
function makeExecSpy(queue: QueuedResponse[]) {
	const calls: string[][] = [];
	const execImpl: ExecCodememFn = async (args) => {
		calls.push([...args]);
		const next = queue.shift();
		if (next instanceof Error) throw next;
		if (args[0] === "pack") return { stdout: next ?? "", stderr: "" };
		if (args[0] === "pi-hook-inject") return { stdout: next ?? "", stderr: "" };
		return { stdout: "", stderr: "" };
	};
	const fetchCount = () =>
		calls.filter((args) => args[0] === "pack" || args[0] === "pi-hook-inject").length;
	return { calls, execImpl, fetchCount };
}

/** Memory-decision tests run in native mode so no discovery hint joins the copy; hint tests opt into mcp. */
function makeInjector(execImpl: ExecCodememFn, configOverrides: Partial<PiExtensionConfig> = {}) {
	const config = defaultPiExtensionConfig({
		viewerEnabled: false,
		toolsMode: "native",
		...configOverrides,
	});
	const client = new PiCodememClient(config, createViewerRuntime(), { execImpl });
	let seq = 0;
	const injector = createPiInjector({
		client,
		config,
		discriminator: (message) => {
			const ts = (message as { timestamp?: unknown }).timestamp;
			if (typeof ts === "number" && Number.isFinite(ts)) return ts;
			seq += 1;
			return `n:${seq}`;
		},
	});
	injector.rekey("sess-inject-test");
	return { config, injector };
}

/** Fresh message objects per call — the context event hands the hook a throwaway copy. */
function userMsg(
	text: string | undefined,
	timestamp?: number,
	content?: PiContextMessage["content"],
): PiContextMessage {
	if (content !== undefined)
		return { role: "user", content, ...(timestamp === undefined ? {} : { timestamp }) };
	return timestamp === undefined
		? { role: "user", content: text }
		: { role: "user", content: text, timestamp };
}

/** Fresh copies of a two-message history. */
const turn = (first = "first", second = "second") => [
	userMsg(first, 1_000),
	userMsg(second, 2_000),
];

function spannedPackBody(pack_text: string, items: unknown[]): string {
	return JSON.stringify({
		pack_text,
		rendered_items: items,
		metrics: { total_items: items.length },
	});
}

function latestText(message: PiContextMessage | undefined): string {
	if (!message) throw new Error("expected a context message");
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((block) =>
				typeof block === "object" && block !== null
					? String((block as { text?: unknown }).text ?? "")
					: "",
			)
			.join("\n");
	}
	return "";
}

/** Exact bytes appendBlockToMessage adds for the discovery hint. */
const HINT_BLOCK = `\n\n${MCP_DISCOVERY_HINT}`;

/** Occurrences of the fixed discovery hint in a request-copy message. */
function hintCount(message: PiContextMessage | undefined): number {
	return latestText(message).split(MCP_DISCOVERY_HINT).length - 1;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("createPiInjector replay", () => {
	it("does not contact a live viewer; the CLI spy is the pack transport", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ service: "not-the-viewer" }),
			text: async () => "",
		}));
		vi.stubGlobal("fetch", fetchMock);
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("from cli", [])]);
		const { injector } = makeInjector(execImpl);
		const messages = [userMsg("question", 1_700)];
		await injector.inject(messages);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(fetchCount()).toBe(1);
		expect(latestText(messages[0])).toContain("from cli");
	});

	it("replays identical bytes onto two decided messages and the fetch spy stays at 0", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		// Turn 1: only the first message exists — it gets a decision.
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("pack one");

		// Turn 2: a new message fetches its own pack; the first replays.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		const firstReplay = latestText(secondTurn[0]);
		const secondBlock = latestText(secondTurn[1]);
		expect(firstReplay).toContain("pack one");
		expect(secondBlock).toContain("pack two");

		// Same turn again (next model call): both decided — replay only, zero fetches.
		const thirdTurn = turn();
		await injector.inject(thirdTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(thirdTurn[0])).toBe(firstReplay);
		expect(latestText(thirdTurn[1])).toBe(secondBlock);
	});

	it("appends to string content by concatenation and to array content with one text block", async () => {
		const { execImpl } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		const message = userMsg(undefined, 1_000, [
			{ type: "text", text: "look at this" },
			{ type: "image", data: "img", mimeType: "image/png" },
		]);
		const imagePart = (message.content as Array<Record<string, unknown>>)[1];
		await injector.inject([message]);

		const content = message.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[0]?.type).toBe("text");
		expect(String(content[0]?.text)).toContain("look at this");
		// Image part untouched by identity — never rebuilt.
		expect(content[1]).toBe(imagePart);
		expect(content[2]?.type).toBe("text");
		expect(String(content[2]?.text)).toContain("pack one");

		const stringMessage = userMsg("plain prompt", 2_000);
		await injector.inject([userMsg("plain prompt", 2_000), stringMessage]);
		expect(typeof stringMessage.content).toBe("string");
		expect(String(stringMessage.content)).toContain("pack two");
	});

	it("a missing timestamp injects once and is not cached", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		await injector.inject([userMsg("no timestamp")]);
		expect(fetchCount()).toBe(1);

		// No stable discriminator → the decision is not cached → fetches again.
		await injector.inject([userMsg("no timestamp")]);
		expect(fetchCount()).toBe(2);
	});
});

describe("createPiInjector span dedup", () => {
	it("cuts already-shown items via rendered spans; a fully-retained pack appends nothing and freezes", async () => {
		const item = (id: number, fingerprint: string, packLength: number) => ({
			id,
			fingerprint,
			spans: [{ start: 0, end: packLength }],
		});
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("ITEM A", [item(7, FINGERPRINT_A, 6)]),
			spannedPackBody("ITEM A", [item(7, FINGERPRINT_A, 6)]),
		]);
		const { injector } = makeInjector(execImpl);

		// Turn 1: item A is attached and its fingerprint recorded.
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("ITEM A");

		// Turn 2: the pack only repeats item A → dedup leaves nothing → frozen inject-nothing.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[1])).toBe("second");

		// Frozen: a later call for that message does not fetch again.
		await injector.inject(turn());
		expect(fetchCount()).toBe(2);
	});

	it("malformed spans keep the full pack text and record no fingerprints", async () => {
		// Span end exceeds the pack text length → invalid → full text, no suppression later.
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("short", [
				{ id: 7, fingerprint: FINGERPRINT_A, spans: [{ start: 0, end: 999 }] },
			]),
			spannedPackBody("short again", [
				{ id: 7, fingerprint: FINGERPRINT_A, spans: [{ start: 0, end: 11 }] },
			]),
		]);
		const { injector } = makeInjector(execImpl);

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("short");

		// No fingerprints were recorded, so the same item is eligible again.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[1])).toContain("short again");
	});
});

describe("createPiInjector freeze", () => {
	it("freezes a cascade failure as inject-nothing; a later inject does not fetch", async () => {
		// Every transport in the one-cascade retry chain fails for this fetch.
		const { execImpl, fetchCount } = makeExecSpy([new Error("cli down"), new Error("cli down")]);
		const { injector } = makeInjector(execImpl);

		const message = userMsg("first", 1_000);
		await injector.inject([message]);
		expect(fetchCount()).toBe(2); // pack --json + pi-hook-inject both tried once
		expect(latestText(message)).toBe("first");

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(2);
	});

	it("freezes an empty pack result as inject-nothing; a later inject does not fetch", async () => {
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("", [])]);
		const { injector } = makeInjector(execImpl);

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(1);

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(1);
	});
});

describe("createPiInjector truncation", () => {
	it("appends the capped block, records no fingerprints, and a later pack may still include the items", async () => {
		const item = (packLength: number) => ({
			id: 9,
			fingerprint: FINGERPRINT_B,
			spans: [{ start: 0, end: packLength }],
		});
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("Y".repeat(60), [item(60)]),
			spannedPackBody("Y".repeat(60), [item(60)]),
		]);
		// Budget barely above the header → every pack truncates.
		const { injector } = makeInjector(execImpl, {
			injectMaxChars: CODEMEM_MEMORIES_HEADER.length + 10,
		});

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("[pack truncated]");

		// The truncated turn recorded no fingerprints → the item is not suppressed next turn.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[1])).toContain("YYY");
	});
});

describe("createPiInjector compaction", () => {
	it("compaction is a one-shot replay with no fetch and no new decision; the next inject may fetch", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(1);

		injector.noteCompaction();
		const compactedTurn = [userMsg("first", 1_000)];
		await injector.inject(compactedTurn);
		expect(fetchCount()).toBe(1); // replay only
		expect(latestText(compactedTurn[0])).toContain("pack one");

		// One-shot consumed → the next inject may fetch for the new message.
		const nextTurn = turn();
		await injector.inject(nextTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(nextTurn[1])).toContain("pack two");
	});
	it("a new user message during compaction is not fetched and gets no decision", async () => {
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("should not run", [])]);
		const { injector } = makeInjector(execImpl);
		injector.rekey("sess-inject-test");
		injector.noteCompaction();
		const duringCompact = [userMsg("summarize this", 9_000)];
		await injector.inject(duringCompact);
		expect(fetchCount()).toBe(0);
		expect(latestText(duringCompact[0])).toBe("summarize this");
		const after = [userMsg("summarize this", 9_000)];
		await injector.inject(after);
		expect(fetchCount()).toBe(1);
		expect(latestText(after[0])).toContain("should not run");
	});
});

describe("createPiInjector retained-token ceiling", () => {
	it("with the cap below the already-replayed total, the next inject replays old bytes, fetches nothing, and appends nothing", async () => {
		vi.stubEnv("CODEMEM_INJECT_RETAINED_TOKEN_BUDGET", "200");
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("Z".repeat(400), [])]);
		const { injector } = makeInjector(execImpl);

		// Turn 1 fits under the cap: ~175 estimated tokens for header + pack.
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		const firstBlock = latestText(firstTurn[0]);
		expect(firstBlock).toContain("ZZZ");

		// Turn 2: replayed bytes already exceed the cap → no fetch, nothing new, nothing evicted.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(secondTurn[0])).toBe(firstBlock);
		expect(latestText(secondTurn[1])).toBe("second");
	});

	it("an unset, zero, or invalid cap never restricts injection", async () => {
		for (const value of ["", "0", "-5", "abc", "1.5"]) {
			vi.stubEnv("CODEMEM_INJECT_RETAINED_TOKEN_BUDGET", value);
			const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("pack one", [])]);
			const { injector } = makeInjector(execImpl);

			await injector.inject([userMsg("first", 1_000)]);
			expect(fetchCount()).toBe(1);
			vi.unstubAllEnvs();
		}
	});
});

describe("createPiInjector mcp discovery hint", () => {
	it("latches the first copy's latest user message, precedes the pack, and replays identical bytes", async () => {
		expect(MCP_DISCOVERY_HINT).not.toContain("\n");
		expect(MCP_DISCOVERY_HINT).toContain('searchTools("<query>", {namespace: "mcp__codemem"})');

		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		const firstBytes = latestText(firstTurn[0]);
		expect(firstBytes).toContain(MCP_DISCOVERY_HINT);
		expect(firstBytes.indexOf(MCP_DISCOVERY_HINT)).toBeLessThan(
			firstBytes.indexOf(CODEMEM_MEMORIES_HEADER),
		);

		// A later user message does not move the latched hint or change the carrier's bytes.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[0])).toBe(firstBytes);
		expect(hintCount(secondTurn[0])).toBe(1);
		expect(hintCount(secondTurn[1])).toBe(0);
		expect(latestText(secondTurn[1])).toContain("pack two");

		// Same history again: replay only, exactly one hint, no accumulation.
		const thirdTurn = turn();
		await injector.inject(thirdTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(thirdTurn[0])).toBe(firstBytes);
		expect(hintCount(thirdTurn[0])).toBe(1);
	});

	it("appends to string and array copies without touching the host's messages", async () => {
		const { execImpl } = makeExecSpy([spannedPackBody("", []), spannedPackBody("", [])]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });

		const persistedString = userMsg("plain prompt", 1_000);
		const stringCopy = structuredClone(persistedString);
		await injector.inject([stringCopy]);
		expect(stringCopy.content).toBe(`plain prompt${HINT_BLOCK}`);
		expect(persistedString.content).toBe("plain prompt");

		const persistedArray = userMsg(undefined, 2_000, [
			{ type: "text", text: "look at this" },
			{ type: "image", data: "img", mimeType: "image/png" },
		]);
		const arrayCopy = structuredClone(persistedArray);
		const imagePart = (arrayCopy.content as Array<Record<string, unknown>>)[1];
		await injector.inject([arrayCopy]);
		const content = arrayCopy.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[1]).toBe(imagePart); // image part never rebuilt
		expect(content[2]).toEqual({ type: "text", text: MCP_DISCOVERY_HINT });
		expect((persistedArray.content as unknown[]).length).toBe(2);
	});

	it("still carries the hint when the new pack is fully deduplicated", async () => {
		const item = { id: 7, fingerprint: FINGERPRINT_A, spans: [{ start: 0, end: 6 }] };
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("ITEM A", [item]),
			spannedPackBody("ITEM A", [item]),
		]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);

		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(hintCount(secondTurn[0])).toBe(1);
		expect(latestText(secondTurn[1])).toBe("second"); // dedup leaves no block, no second hint
	});

	it("keeps the hint when both pack transports fail", async () => {
		const { execImpl, fetchCount } = makeExecSpy([new Error("cli down"), new Error("cli down")]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(firstTurn[0])).toBe(`first${HINT_BLOCK}`);

		const replay = userMsg("first", 1_000);
		await injector.inject([replay]);
		expect(fetchCount()).toBe(2);
		expect(latestText(replay)).toBe(`first${HINT_BLOCK}`);
	});

	it("attaches even when the retained-token ceiling stops every fetch", async () => {
		vi.stubEnv("CODEMEM_INJECT_RETAINED_TOKEN_BUDGET", "1");
		const { execImpl, fetchCount } = makeExecSpy([]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });

		const messages = [userMsg("first", 1_000)];
		await injector.inject(messages);
		expect(fetchCount()).toBe(0);
		expect(latestText(messages[0])).toBe(`first${HINT_BLOCK}`);
	});
});

describe("createPiInjector mcp discovery hint lifecycle", () => {
	it("one-shot compaction re-latches to the surviving message without a fetch", async () => {
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("pack one", [])]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });
		await injector.inject([userMsg("first", 1_000)]);

		injector.noteCompaction();
		const compacted = [userMsg("second", 2_000)];
		await injector.inject(compacted);
		expect(fetchCount()).toBe(1); // one-shot: replay only
		expect(latestText(compacted[0])).toBe(`second${HINT_BLOCK}`);
	});

	it("one-shot compaction that keeps the carrier does not duplicate the hint", async () => {
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("pack one", [])]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		const firstBytes = latestText(firstTurn[0]);

		injector.noteCompaction();
		const compacted = turn();
		await injector.inject(compacted);
		expect(fetchCount()).toBe(1);
		expect(latestText(compacted[0])).toBe(firstBytes);
		expect(hintCount(compacted[1])).toBe(0);
	});

	it("re-latches when an ordinary request drops the carrier", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });
		await injector.inject([userMsg("first", 1_000)]);

		const windowed = [userMsg("second", 2_000)];
		await injector.inject(windowed);
		expect(fetchCount()).toBe(2); // ordinary windowing does not arm the compaction skip
		const text = latestText(windowed[0]);
		expect(text.startsWith(`second${HINT_BLOCK}`)).toBe(true);
		expect(hintCount(windowed[0])).toBe(1);
		expect(text).toContain("pack two");
	});

	it("re-keys the latch on session_start even for the same session id", async () => {
		const { execImpl } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
			spannedPackBody("pack three", []),
		]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });
		await injector.inject([userMsg("first", 1_000)]);

		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(hintCount(secondTurn[0])).toBe(1);
		expect(hintCount(secondTurn[1])).toBe(0);

		injector.rekey("sess-inject-test"); // reload/resume: same id, fresh latch
		const reloaded = turn();
		await injector.inject(reloaded);
		expect(hintCount(reloaded[0])).toBe(0);
		expect(hintCount(reloaded[1])).toBe(1);
	});

	it("attaches nothing when the request copy has no user message", async () => {
		const { execImpl, fetchCount } = makeExecSpy([]);
		const { injector } = makeInjector(execImpl, { toolsMode: "mcp" });
		const messages = [{ role: "assistant", content: "hello" }];
		await injector.inject(messages);
		expect(fetchCount()).toBe(0);
		expect(latestText(messages[0])).toBe("hello");
	});

	it("attaches under both mcp exposures and never in native mode", async () => {
		for (const toolExposure of ["hybrid", "codemode"] as const) {
			const { execImpl } = makeExecSpy([spannedPackBody("", [])]);
			const { injector } = makeInjector(execImpl, { toolsMode: "mcp", toolExposure });
			const messages = [userMsg(`q-${toolExposure}`, 1_000)];
			await injector.inject(messages);
			expect(latestText(messages[0]), toolExposure).toBe(`q-${toolExposure}${HINT_BLOCK}`);
		}

		const { execImpl } = makeExecSpy([spannedPackBody("", [])]);
		const { injector } = makeInjector(execImpl);
		const nativeMessages = [userMsg("first", 1_000)];
		await injector.inject(nativeMessages);
		expect(latestText(nativeMessages[0])).toBe("first");
	});
});
