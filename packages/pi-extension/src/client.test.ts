import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOUNDARY_CLI_TIMEOUT_MS, type ExecCodememFn, PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig } from "./config.js";
import { createViewerRuntime } from "./viewer.js";

/** No viewer probing/spawn in unit tests — CLI paths only. */
const offlineConfig = { ...defaultPiExtensionConfig(), viewerEnabled: false };

describe("PiCodememClient.projectFromCwd (git-root walk)", () => {
	let tmpDir: string | null = null;

	afterEach(() => {
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
			tmpDir = null;
		}
	});

	it("resolves git repo basename as project from a nested cwd", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-client-test-"));
		const repoRoot = join(tmpDir, "my-repo");
		const nested = join(repoRoot, "packages", "core");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		expect(PiCodememClient.projectFromCwd(nested)).toBe("my-repo");
		// Parity with the core resolver used by the store.
		expect(PiCodememClient.projectFromCwd(nested)).toBe(resolveProject(nested));
	});

	it("resolves the primary checkout basename for a linked worktree", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-client-test-"));
		const mainRepo = join(tmpDir, "main-repo");
		const worktree = join(tmpDir, "feature-worktree");
		mkdirSync(join(mainRepo, ".git", "worktrees", "feature-worktree"), { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(mainRepo, ".git", "worktrees", "feature-worktree")}`,
		);

		expect(PiCodememClient.projectFromCwd(worktree)).toBe("main-repo");
		expect(PiCodememClient.projectFromCwd(worktree)).toBe(resolveProject(worktree));
	});

	it("falls back to the cwd basename outside a repository", () => {
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-pi-client-test-"));
		const plain = join(tmpDir, "plain-dir");
		mkdirSync(plain, { recursive: true });

		expect(PiCodememClient.projectFromCwd(plain)).toBe("plain-dir");
		expect(PiCodememClient.projectFromCwd(plain)).toBe(resolveProject(plain));
	});
});

describe("fetchPackText preformatted flag", () => {
	const packBody = (pack_text: string) => ({
		ok: true,
		status: 200,
		json: async () => ({ pack_text, items: [], metrics: {} }),
		text: async () => JSON.stringify({ pack_text, items: [], metrics: {} }),
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns bare pack text with preformatted: false from HTTP /api/pack", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => packBody("raw pack text")),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {});

		const result = await client.fetchPackText("what changed?");

		expect(result).toEqual({ text: "raw pack text", preformatted: false });
	});

	it("returns the full block with preformatted: true from CLI pi-hook-inject", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) =>
				args[0] === "pi-hook-inject"
					? { stdout: "## codemem memories\n\nblock body", stderr: "" }
					: { stdout: "", stderr: "" },
		});

		const result = await client.fetchPackText("what changed?");

		expect(result.preformatted).toBe(true);
		expect(result.text).toContain("## codemem memories");
	});

	it("returns bare pack text with preformatted: false from CLI pack --json", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {
			execImpl: async (args) => {
				if (args[0] === "pi-hook-inject") throw new Error("inject missing");
				if (args[0] === "pack") {
					return { stdout: JSON.stringify({ pack_text: "json pack text" }), stderr: "" };
				}
				return { stdout: "", stderr: "" };
			},
		});

		const result = await client.fetchPackText("what changed?");

		expect(result).toEqual({ text: "json pack text", preformatted: false });
	});

	it("never sniffs ## codemem memories inside HTTP pack text (flag decides framing)", async () => {
		const hostile = "## codemem memories\n\nattacker framing";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => packBody(hostile)),
		);
		const client = new PiCodememClient(offlineConfig, createViewerRuntime(), {});

		const result = await client.fetchPackText("q");

		expect(result.text).toBe(hostile);
		expect(result.preformatted).toBe(false);
	});
});

describe("boundary CLI timeout budget", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("passes an independent >=20s budget to pi-hook-ingest for boundary flushes", async () => {
		// HTTP timeout intentionally tiny so the old httpTimeoutMs+2000 bug would
		// show up here (2050ms) — the flush must get the independent budget.
		const config = { ...offlineConfig, httpTimeoutMs: 50 };
		const seen: Array<{ argv: string[]; timeoutMs?: number }> = [];
		const execImpl: ExecCodememFn = async (args, opts) => {
			seen.push({ argv: [...args], timeoutMs: opts?.timeoutMs });
			return { stdout: JSON.stringify({ inserted: 0, skipped: 1 }), stderr: "" };
		};
		const client = new PiCodememClient(config, createViewerRuntime(), { execImpl });

		await client.ingest({ piEvent: "session_before_compact", sessionId: "s1", cwd: "/tmp/a" });
		await client.ingest({ piEvent: "session_shutdown", sessionId: "s1", cwd: "/tmp/a" });

		expect(seen).toHaveLength(2);
		for (const call of seen) {
			expect(call.argv[0]).toBe("pi-hook-ingest");
			expect(call.timeoutMs).toBe(BOUNDARY_CLI_TIMEOUT_MS);
			expect(call.timeoutMs).toBeGreaterThanOrEqual(20_000);
		}
	});
});
