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
		expect(overridden.toolsMode).toBe("mcp-adapter");
		expect(overridden.fileContext).toBe(true);
	});

	it("defaultPiExtensionConfig merges overrides", () => {
		const cfg = defaultPiExtensionConfig({ toolsMode: "mcp-adapter", injectLimit: 3 });
		expect(cfg.toolsMode).toBe("mcp-adapter");
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
		expect(mode()).toBe("mcp-adapter");

		process.env.CODEMEM_PI_TOOLS_MODE = "mcp";
		writeMode("");
		expect(mode()).toBe("mcp");
		delete process.env.CODEMEM_PI_TOOLS_MODE;
		writeMode("native");
		expect(mode()).toBe("native");
		process.env.CODEMEM_PI_TOOLS_MODE = "mcp";
		writeMode("mcp-adapter");
		expect(mode()).toBe("mcp");
		process.env.CODEMEM_PI_TOOLS_MODE = "bogus";
		writeMode("mcp");
		expect(mode()).toBe("mcp");
		process.env.CODEMEM_PI_TOOLS_MODE = "native";
		writeMode("mcp");
		expect(mode()).toBe("native");
		expect(defaultPiExtensionConfig().toolsMode).toBe("mcp");
	});
});
