import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPiExtensionConfig, loadPiExtensionConfig } from "./config.js";

describe("loadPiExtensionConfig", () => {
	const prev = { ...process.env };

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in prev)) delete process.env[key];
		}
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("reads pi.* from config file and allows CODEMEM_PI_* overrides", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-pi-cfg-"));
		const path = join(dir, "config.json");
		writeFileSync(
			path,
			JSON.stringify({
				pi: {
					tools_mode: "native",
					inject_prompts: true,
					file_context: false,
				},
			}),
		);
		process.env.CODEMEM_CONFIG = path;
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		delete process.env.CODEMEM_PI_INJECT_PROMPTS;
		delete process.env.CODEMEM_PI_FILE_CONTEXT;

		const cfg = loadPiExtensionConfig(process.env);
		expect(cfg.toolsMode).toBe("native");
		expect(cfg.injectPrompts).toBe(true);
		expect(cfg.fileContext).toBe(false);

		process.env.CODEMEM_PI_TOOLS_MODE = "mcp-adapter";
		process.env.CODEMEM_PI_FILE_CONTEXT = "1";
		const overridden = loadPiExtensionConfig(process.env);
		expect(overridden.toolsMode).toBe("mcp");
		expect(overridden.toolsModeNotice).toContain("mcp-adapter");
		expect(overridden.fileContext).toBe(true);
	});

	it("defaultPiExtensionConfig merges overrides", () => {
		const cfg = defaultPiExtensionConfig({ toolsMode: "native", injectLimit: 3 });
		expect(cfg.toolsMode).toBe("native");
		expect(cfg.injectLimit).toBe(3);
		expect(cfg.injectPrompts).toBe(true);
	});

	it("selects mcp for absent, empty, or nullish mode and native for unknown or invalid values", () => {
		const path = join(mkdtempSync(join(tmpdir(), "codemem-pi-mode-")), "config.json");
		process.env.CODEMEM_CONFIG = path;
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		const writeMode = (value: unknown) =>
			writeFileSync(path, JSON.stringify({ pi: { tools_mode: value } }));
		const mode = () => loadPiExtensionConfig(process.env).toolsMode;
		const notice = () => loadPiExtensionConfig(process.env).toolsModeNotice;
		writeMode("mcp");
		expect(mode()).toBe("mcp");
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ pi: { tools_mode: "mcp" } }));
		writeMode(" MCP ");
		expect(mode()).toBe("mcp");
		writeMode("");
		expect(mode()).toBe("mcp");
		writeMode("   ");
		expect(mode()).toBe("mcp");
		writeMode("bogus");
		expect(mode()).toBe("native");
		expect(readFileSync(path, "utf8")).toContain("bogus");
		writeMode(null);
		expect(mode()).toBe("mcp");
		writeMode(5);
		expect(mode()).toBe("native");
		writeFileSync(path, JSON.stringify({ pi: {} }));
		expect(mode()).toBe("mcp");
		// tools_mode ?? toolsMode: nullish falls through to the alias, a blank string does not.
		writeFileSync(path, JSON.stringify({ pi: { tools_mode: null, toolsMode: "native" } }));
		expect(mode()).toBe("native");
		writeFileSync(path, JSON.stringify({ pi: { tools_mode: "", toolsMode: "native" } }));
		expect(mode()).toBe("mcp");
		writeFileSync(path, JSON.stringify({ pi: { toolsMode: "mcp-adapter" } }));
		expect(mode()).toBe("mcp");
		expect(notice()).toContain("mcp-adapter");

		process.env.CODEMEM_PI_TOOLS_MODE = "mcp";
		writeMode("");
		expect(mode()).toBe("mcp");
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		writeMode("native");
		expect(mode()).toBe("native");
		process.env.CODEMEM_PI_TOOLS_MODE = "mcp";
		writeMode("mcp-adapter");
		expect(mode()).toBe("mcp");
		expect(notice()).toBeNull();
		process.env.CODEMEM_PI_TOOLS_MODE = "bogus";
		writeMode("mcp");
		expect(mode()).toBe("mcp");
		process.env.CODEMEM_PI_TOOLS_MODE = "native";
		writeMode("mcp");
		expect(mode()).toBe("native");
		expect(defaultPiExtensionConfig().toolsMode).toBe("mcp");
	});
});

describe("legacy adapter tools-mode migration", () => {
	const prev = { ...process.env };

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in prev)) delete process.env[key];
		}
		for (const [key, value] of Object.entries(prev)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("maps legacy adapter tools-mode values to mcp with an actionable notice", () => {
		const path = join(mkdtempSync(join(tmpdir(), "codemem-pi-legacy-")), "config.json");
		process.env.CODEMEM_CONFIG = path;
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		const writePi = (key: string, value: unknown) =>
			writeFileSync(path, JSON.stringify({ pi: { [key]: value } }));

		for (const key of ["tools_mode", "toolsMode"]) {
			for (const value of ["mcp-adapter", "adapter", "mcp_adapter"]) {
				writePi(key, value);
				const cfg = loadPiExtensionConfig(process.env);
				expect(cfg.toolsMode, `${key}=${value}`).toBe("mcp");
				expect(cfg.toolsModeNotice, `${key}=${value}`).toContain("was removed");
				expect(cfg.toolsModeNotice, `${key}=${value}`).toContain('"native"');
				// Legacy values map at read time; the file is never rewritten.
				expect(readFileSync(path, "utf8"), `${key}=${value}`).toContain(String(value));
			}
		}

		for (const value of ["mcp-adapter", "mcp_adapter", "adapter", " MCP-ADAPTER "]) {
			process.env.CODEMEM_PI_TOOLS_MODE = value;
			const cfg = loadPiExtensionConfig(process.env);
			expect(cfg.toolsMode, `env=${value}`).toBe("mcp");
			expect(cfg.toolsModeNotice, `env=${value}`).toContain("was removed");
			expect(cfg.toolsModeNotice, `env=${value}`).toContain('"native"');
		}
		delete process.env.CODEMEM_PI_TOOLS_MODE;
	});

	it("emits no notice for valid, unknown, or unset modes", () => {
		const path = join(mkdtempSync(join(tmpdir(), "codemem-pi-notice-")), "config.json");
		process.env.CODEMEM_CONFIG = path;
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		const writeMode = (value: unknown) =>
			writeFileSync(path, JSON.stringify({ pi: { tools_mode: value } }));
		const notice = () => loadPiExtensionConfig(process.env).toolsModeNotice;

		for (const value of ["native", "mcp", "", "   ", null, "bogus", 5]) {
			writeMode(value);
			expect(notice(), String(value)).toBeNull();
		}
	});
});
