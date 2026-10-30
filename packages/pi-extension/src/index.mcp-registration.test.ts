// Explicit `mcp` at the real session seam: registration gets the target and hooks keep working.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiCodememClient } from "./client.js";
import codememPiExtension, { __setTestExecImpl } from "./index.js";
import { buildViewerIdentityTarget, resolveViewerDbPath } from "./viewer.js";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;
type Registration = { name: string; config: Record<string, unknown> };
type Payload = Record<string, unknown>;

function createMockPi(withMcpApi: boolean | "throws" = true) {
	const handlers = new Map<string, Handler[]>();
	const registrations: Registration[] = [];
	const tools: string[] = [];
	const notices: string[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerTool(def: { name: string }) {
			tools.push(def.name);
		},
		appendEntry() {},
	};
	if (withMcpApi) {
		Object.assign(pi, {
			registerMcpServer(name: string, config: Record<string, unknown>) {
				if (withMcpApi === "throws") throw new Error("invalid codemem server config");
				registrations.push({ name, config });
			},
		});
	}
	return { pi, handlers, registrations, tools, notices };
}

function envOf(registration: Registration | undefined): Record<string, string> {
	return (registration?.config.env ?? {}) as Record<string, string>;
}

function captureIngest(): Payload[] {
	const captured: Payload[] = [];
	vi.spyOn(PiCodememClient.prototype, "ingest").mockImplementation(async (payload) => {
		captured.push({ ...payload });
		return { ok: true, via: "http" };
	});
	return captured;
}

function createHarness(withMcpApi: boolean | "throws" = true) {
	const { pi, handlers, registrations, tools, notices } = createMockPi(withMcpApi);
	const captured = captureIngest();
	codememPiExtension(pi as never);
	return { handlers, registrations, tools, notices, captured };
}

type Harness = ReturnType<typeof createHarness>;

async function emit(
	harness: Harness,
	name: string,
	event: Record<string, unknown>,
	ctx: Record<string, unknown>,
) {
	let last: unknown;
	for (const handler of harness.handlers.get(name) ?? []) {
		last = await handler({ type: name, ...event }, ctx);
	}
	return last;
}

function sessionCtx(cwd: string) {
	return {
		cwd,
		signal: new AbortController().signal,
		sessionManager: {
			getSessionId: () => "sess-mcp",
			getEntries: () => [],
			getLeafEntry: () => null,
			getSessionFile: () => null,
		},
		ui: { notify: (_message: string) => {} },
	};
}

function jsonOk(body: unknown) {
	return {
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	};
}

function servingFetch(cwd: string) {
	return vi.fn(async (input: unknown) => {
		const url = String(input);
		if (url.includes("/api/prompt-pack-profile")) {
			return jsonOk({
				service: "codemem-viewer",
				protocol_version: 1,
				min_supported_protocol_version: 1,
				db_path: resolveViewerDbPath(cwd),
				identity_target: buildViewerIdentityTarget(process.env, cwd),
			});
		}
		if (url.includes("/api/pack")) {
			return jsonOk({ pack_text: "PACK-MARKER", items: [1], metrics: { total_items: 1 } });
		}
		if (url.includes("/api/raw-events/status")) {
			return jsonOk({ ingest: { available: true } });
		}
		return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
	});
}

let tempRoot = "";
function makeTarget(name: string): string {
	const dir = join(tempRoot, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

beforeEach(() => {
	tempRoot = mkdtempSync(join(tmpdir(), "codemem-pi-mcp-reg-"));
	vi.stubEnv("CODEMEM_VIEWER_AUTO", "0");
	vi.stubEnv("CODEMEM_PI_FILE_CONTEXT", "0");
	vi.stubEnv("CODEMEM_PI_TOOLS_MODE", "mcp");
	vi.stubEnv("CODEMEM_PROJECT", "");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("offline");
		}),
	);
	__setTestExecImpl(async () => ({ stdout: JSON.stringify({ inserted: 1 }), stderr: "" }));
});

afterEach(() => {
	__setTestExecImpl(null);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(tempRoot, { recursive: true, force: true });
});

describe("explicit mcp surface", () => {
	it("registers the codemode server from session_start, never from the factory", async () => {
		const harness = createHarness();
		const cwd = makeTarget("plain-target");

		expect(harness.registrations).toEqual([]);
		expect(harness.tools).toEqual([]);

		await emit(harness, "session_start", { reason: "startup" }, sessionCtx(cwd));

		expect(harness.registrations).toHaveLength(1);
		const [registration] = harness.registrations;
		expect(registration?.name).toBe("codemem");
		expect(registration?.config).toMatchObject({
			command: "codemem",
			args: ["mcp", "--db-path", resolveViewerDbPath(cwd)],
			cwd,
			exposure: "codemode",
		});
		expect(envOf(registration).CODEMEM_PROJECT).toBe("plain-target");
	});

	it("keeps direct-tool counts at 15 native, 0 mcp, and 0 mcp-adapter", async () => {
		for (const [mode, direct] of [
			["native", 15],
			["mcp", 0],
			["mcp-adapter", 0],
		] as const) {
			vi.stubEnv("CODEMEM_PI_TOOLS_MODE", mode);
			const harness = createHarness();
			await emit(harness, "session_start", { reason: "startup" }, sessionCtx(makeTarget(mode)));
			expect(harness.tools, mode).toHaveLength(direct);
			expect(harness.registrations, mode).toHaveLength(mode === "mcp" ? 1 : 0);
		}
	});
});

describe("mcp target handoff", () => {
	it("hands the git-root project, session cwd, and resolved database path", async () => {
		vi.stubEnv("CODEMEM_DB", "state/mem.sqlite");
		const repoRoot = makeTarget("scoped-repo");
		const nested = join(repoRoot, "packages", "core");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		const harness = createHarness();
		const ctx = sessionCtx(nested);

		await emit(harness, "session_start", { reason: "startup" }, ctx);
		const config = harness.registrations[0]?.config as Record<string, unknown>;
		expect(config.cwd).toBe(nested);
		expect(config.args).toEqual(["mcp", "--db-path", join(nested, "state", "mem.sqlite")]);
		expect((config.env as Record<string, string>).CODEMEM_PROJECT).toBe("scoped-repo");

		// A changed effective target re-registers; an explicit project still wins.
		vi.stubEnv("CODEMEM_PROJECT", "explicit-project");
		await emit(harness, "session_start", { reason: "resume" }, ctx);
		expect(harness.registrations).toHaveLength(2);
		expect(envOf(harness.registrations[1]).CODEMEM_PROJECT).toBe("explicit-project");
	});

	it("preserves a git-root project with trailing whitespace verbatim", async () => {
		const repoRoot = makeTarget("project ");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		const harness = createHarness();

		await emit(harness, "session_start", { reason: "startup" }, sessionCtx(repoRoot));

		expect(envOf(harness.registrations[0]).CODEMEM_PROJECT).toBe("project ");
	});

	it("does not re-register an unchanged target and registers once per reload", async () => {
		const cwd = makeTarget("stable-target");
		const first = createHarness();
		await emit(first, "session_start", { reason: "startup" }, sessionCtx(cwd));
		await emit(first, "session_start", { reason: "resume" }, sessionCtx(cwd));
		expect(first.registrations).toHaveLength(1);

		const configPath = join(cwd, "codemem.json");
		vi.stubEnv("CODEMEM_CONFIG", configPath);
		const reloaded = createHarness();
		await emit(reloaded, "session_start", { reason: "startup" }, sessionCtx(cwd));
		expect(reloaded.registrations).toHaveLength(1);
		expect(envOf(reloaded.registrations[0]).CODEMEM_CONFIG).toBe(configPath);
	});
});

describe("mcp-mode hook continuity", () => {
	it("reports a host without the registration API and keeps ingesting", async () => {
		const harness = createHarness(false);
		const ctx = sessionCtx(makeTarget("no-api"));
		ctx.ui.notify = (message: string) => harness.notices.push(message);

		await emit(harness, "session_start", { reason: "startup" }, ctx);

		expect(harness.tools).toEqual([]);
		expect(harness.notices.join("\n")).toContain("no MCP registration API");
		expect(harness.notices.join("\n")).toContain('"native"');
		expect(harness.captured.some((payload) => payload.piEvent === "session_start")).toBe(true);
	});

	it("reports a rejected registration at the factory seam and keeps ingesting", async () => {
		const harness = createHarness("throws");
		const ctx = sessionCtx(makeTarget("rejected-api"));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await emit(harness, "session_start", { reason: "startup" }, { ...ctx, ui: undefined });

		expect(harness.tools).toEqual([]);
		expect(warn.mock.calls.flat().join("\n")).toContain(
			"could not register the codemem MCP server",
		);
		expect(harness.captured.some((payload) => payload.piEvent === "session_start")).toBe(true);
	});

	it("keeps injection and recall exclusion active in mcp mode", async () => {
		vi.stubEnv("CODEMEM_PI_INJECT_PROMPTS", "1");
		const cwd = makeTarget("hooks-target");
		vi.stubGlobal("fetch", servingFetch(cwd));
		const harness = createHarness();
		const ctx = sessionCtx(cwd);

		await emit(harness, "session_start", { reason: "startup" }, ctx);

		const messages = [{ role: "user", content: "hello", timestamp: 1_700_000_000_001 }];
		await emit(harness, "context", { messages }, ctx);
		expect(messages[0]?.content).toContain("PACK-MARKER");

		await emit(
			harness,
			"tool_result",
			{
				toolCallId: "recall-1",
				toolName: "mcp__codemem__memory_search",
				input: {},
				isError: false,
				content: [{ type: "text", text: "RECALLED" }],
			},
			ctx,
		);
		const recallPayload = harness.captured.find((payload) => payload.toolCallId === "recall-1");
		expect(recallPayload).toMatchObject({
			piEvent: "tool_result",
			toolName: "codemem_memory_search",
		});
		expect(recallPayload?.toolOutput ?? null).toBeNull();
		expect(JSON.stringify(harness.captured)).not.toContain("RECALLED");
	});
});

describe("default surface", () => {
	it("registers codemem at session_start when no tools mode is configured", async () => {
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		const harness = createHarness();
		const cwd = makeTarget("default-target");

		expect(harness.tools).toEqual([]);
		await emit(harness, "session_start", { reason: "startup" }, sessionCtx(cwd));

		expect(harness.registrations).toHaveLength(1);
		expect(harness.registrations[0]?.config.exposure).toBe("codemode");
	});

	it("reports the missing registration API with no direct-tool fallback by default", async () => {
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		const harness = createHarness(false);
		const ctx = sessionCtx(makeTarget("default-no-api"));
		ctx.ui.notify = (message: string) => harness.notices.push(message);

		await emit(harness, "session_start", { reason: "startup" }, ctx);

		expect(harness.tools).toEqual([]);
		expect(harness.notices.join("\n")).toContain("no MCP registration API");
	});
});
