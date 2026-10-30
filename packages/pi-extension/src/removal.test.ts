// Package-entry removal: pi loads extensions from its `packages` settings, so removing that entry and
// restarting must drop codemem's hooks, tools and MCP registration while user-owned state survives.
// Loader-level coverage: the built-in MCP extension is omitted, so the registration diagnostic proves
// the production registerMcpServer call (not a child process); the real codemem mcp child, codemode
// dispatch and reload lifecycle are covered by the no-model host harness.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, initTestSchema, insertTestSession, MemoryStore } from "@codemem/core";
import {
	createAgentSession,
	createCodemodeExtension,
	createToolSearchExtension,
	DefaultPackageManager,
	DefaultResourceLoader,
	type ExtensionUIContext,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Production extension source: the official loader runs TS through jiti, so no dist is required. */
const EXTENSION_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
// The diagnostic object is JSON-serialized here, so match its unquoted fragments.
const REGISTER_EVENT = '"event":"register_mcp_server"';
const REGISTER_DIAGNOSTIC = "no loaded extension connects MCP servers";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Host = { loader: DefaultResourceLoader; session: Session; errors: unknown[] };
type Fixture = {
	cwd: string;
	agentDir: string;
	packageDir: string;
	settingsPath: string;
	mcpJsonPath: string;
	cliLog: string;
	dbPath: string;
};

const uiContext = {
	notify() {},
	async select() {
		return undefined;
	},
	async confirm() {
		return false;
	},
	async input() {
		return undefined;
	},
} as unknown as ExtensionUIContext;

function createHostEnv(root: string): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("CODEMEM_") || key === "PI_CODING_AGENT_DIR") delete process.env[key];
	}
	Object.assign(process.env, {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "home", ".config"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		CODEMEM_CONFIG: join(root, "config.json"),
		CODEMEM_DB: join(root, "db.sqlite"),
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_EMBEDDING_DISABLED: "1",
		TMPDIR: join(root, "tmp"),
		PATH: `${join(root, "bin")}:${dirname(process.execPath)}`,
	});
}

/** Records the CLI calls the extension makes; drains stdin so the spawn never hits EPIPE. */
function writeCliShim(root: string): string {
	const dir = join(root, "bin");
	mkdirSync(dir, { recursive: true });
	const logPath = join(root, "cli-calls.log");
	const shim = join(dir, "codemem");
	writeFileSync(
		shim,
		`#!/bin/sh\nwhile IFS= read -r _line; do :; done\nprintf '%s\\n' "$*" >> '${logPath}'\nexit 0\n`,
	);
	chmodSync(shim, 0o755);
	return logPath;
}

/** Isolated host tree: a `packages` entry whose `pi.extensions` maps to the production TS entry. */
function prepareFixture(root: string): Fixture {
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const packageDir = join(root, "fixture-package");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(root, "home", ".config"), { recursive: true });
	mkdirSync(join(root, "tmp"), { recursive: true });
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(packageDir, "package.json"),
		JSON.stringify(
			{
				name: "codemem-removal-fixture",
				version: "0.0.0",
				type: "module",
				pi: { extensions: [EXTENSION_ENTRY] },
			},
			null,
			2,
		),
	);
	writeFileSync(join(root, "config.json"), "{}"); // no tools_mode: the default surface
	createHostEnv(root);
	return {
		cwd,
		agentDir,
		packageDir,
		settingsPath: join(agentDir, "settings.json"),
		mcpJsonPath: join(agentDir, "mcp.json"),
		cliLog: writeCliShim(root),
		dbPath: join(root, "db.sqlite"),
	};
}

/** Real schema and memory in the store the host would read; returns the memory id. */
function seedMemory(dbPath: string): number {
	const seedDb = connect(dbPath);
	initTestSchema(seedDb);
	seedDb
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("removal-device", "removal-public", "removal-fingerprint", new Date().toISOString());
	seedDb.close();
	const store = new MemoryStore(dbPath);
	try {
		return store.remember(
			insertTestSession(store.db),
			"decision",
			"removal fixture memory",
			"survives package removal",
			0.9,
		);
	} finally {
		store.close();
	}
}

function cliCalls(logPath: string): string[] {
	try {
		return readFileSync(logPath, "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

async function waitFor(
	predicate: () => boolean,
	description: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`timed out waiting for ${description}`);
}

function directMemoryTools(session: Session): string[] {
	return session
		.getAllTools()
		.map((tool) => tool.name)
		.filter((name) => name.startsWith("memory_"));
}

async function startHost(root: string): Promise<Host> {
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [createCodemodeExtension({ mode: "on" }), createToolSearchExtension()],
	});
	await loader.reload();
	const errors: unknown[] = [];
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({
		mode: "rpc",
		uiContext,
		onError: (error) => {
			errors.push(error);
		},
	});
	return { loader, session, errors };
}

async function shutdown(session: Session): Promise<void> {
	try {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} catch {
		// Cleanup runs from `finally`; it must not hide the assertion that failed.
	} finally {
		session.dispose();
	}
}

describe("pi package-entry removal", () => {
	const prevEnv = { ...process.env };
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codemem-pi-removal-"));
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) if (!(key in prevEnv)) delete process.env[key];
		for (const [key, value] of Object.entries(prevEnv))
			if (value !== undefined) process.env[key] = value;
		rmSync(root, { recursive: true, force: true });
	});

	// Two real loader/session lifecycles plus a seeded store; the default 5s is not enough.
	it("drops every codemem hook, tool and registration after the package entry is removed", {
		timeout: 60_000,
	}, async () => {
		const fixture = prepareFixture(root);
		const memoryId = seedMemory(fixture.dbPath);

		// Install the entry through pi's own settings API, then start the real host.
		const manager = SettingsManager.create(fixture.cwd, fixture.agentDir);
		manager.setPackages([fixture.packageDir]);
		await manager.flush();
		expect(manager.getPackages()).toEqual([fixture.packageDir]);

		const installed = await startHost(root);
		try {
			const extension = installed.loader
				.getExtensions()
				.extensions.find((entry) => entry.path === EXTENSION_ENTRY);
			expect(extension, "package entry loads the production extension source").toBeDefined();
			if (!extension) throw new Error("extension was not loaded from the package entry");
			expect([...extension.handlers.keys()]).toEqual(
				expect.arrayContaining(["session_start", "context", "tool_result", "session_shutdown"]),
			);
			expect(extension.tools.size).toBe(0); // default mcp keeps memory tools out of direct registration
			expect(directMemoryTools(installed.session)).toEqual([]);
			// Omitted built-in MCP: this diagnostic is the registration attempt, not a child process.
			expect(JSON.stringify(installed.errors)).toContain(REGISTER_EVENT);
			expect(JSON.stringify(installed.errors)).toContain(REGISTER_DIAGNOSTIC);
			await waitFor(
				() => cliCalls(fixture.cliLog).some((call) => call.startsWith("pi-hook-ingest")),
				"session_start ingest",
			);
		} finally {
			await shutdown(installed.session);
		}

		const manualMcp = `${JSON.stringify({ mcpServers: { codemem: { command: "codemem", args: ["mcp", "--db-path", fixture.dbPath] } } }, null, 2)}\n`;
		writeFileSync(fixture.mcpJsonPath, manualMcp);
		const manualBytes = readFileSync(fixture.mcpJsonPath, "utf8");

		// The real removal: pi's settings API drops the package entry, then a fresh host starts.
		manager.setPackages([]);
		await manager.flush();
		expect(SettingsManager.create(fixture.cwd, fixture.agentDir).getPackages()).toEqual([]);
		expect(JSON.parse(readFileSync(fixture.settingsPath, "utf8")).packages).toEqual([]);
		const packageManager = new DefaultPackageManager({
			cwd: fixture.cwd,
			agentDir: fixture.agentDir,
			settingsManager: SettingsManager.create(fixture.cwd, fixture.agentDir),
			builtinExtensions: [],
		});
		const resolved = await packageManager.resolve();
		expect(resolved.extensions.some((entry) => entry.path === EXTENSION_ENTRY)).toBe(false);

		const callsBeforeRestart = cliCalls(fixture.cliLog).length;
		const restarted = await startHost(root);
		try {
			expect(
				restarted.loader.getExtensions().extensions.some((entry) => entry.path === EXTENSION_ENTRY),
			).toBe(false);
			expect(directMemoryTools(restarted.session)).toEqual([]);
			expect(JSON.stringify(restarted.errors)).not.toContain(REGISTER_DIAGNOSTIC);
			expect(cliCalls(fixture.cliLog).length).toBe(callsBeforeRestart); // no ingest after removal
			expect(readFileSync(fixture.mcpJsonPath, "utf8")).toBe(manualBytes);
			const reopened = new MemoryStore(fixture.dbPath);
			try {
				expect(reopened.get(memoryId)?.title).toBe("removal fixture memory");
			} finally {
				reopened.close();
			}
		} finally {
			await shutdown(restarted.session);
		}
	});
});
