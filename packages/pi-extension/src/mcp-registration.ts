// Default or explicit `mcp`: Pi owns transport; we hand it the session target (env is template-parsed once).

import { resolve } from "node:path";
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { PiToolsMode } from "./config.js";
import { resolveViewerDbPath } from "./viewer.js";

const SERVER_NAME = "codemem";

/** Env the codemem child derives its config and identity target from. */
const TARGET_ENV_KEYS = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"CODEMEM_CONFIG",
	"CODEMEM_RUNTIME_ROOT",
	"CODEMEM_ACTOR_ID",
	"CODEMEM_DEVICE_ID",
	"CODEMEM_WORKSPACE_ID",
	"CODEMEM_PACK_COMPRESSION",
	"CODEMEM_EMBEDDING_MODEL",
	"CODEMEM_EMBEDDING_REVISION",
	"CODEMEM_EMBEDDING_DISABLED",
	"CODEMEM_EMBEDDING_OFFLINE",
] as const;

export type McpTarget = { cwd: string; project: string | null };

/** Pi reads `$name` as a variable and a leading `!` as a command. */
export function escapeMcpEnvValue(value: string): string {
	const escaped = value.replaceAll("$", () => "$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export function codememMcpServerConfig(
	target: McpTarget,
	env: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
	const childEnv: Record<string, string> = {};
	const project = target.project;
	if (project) childEnv.CODEMEM_PROJECT = escapeMcpEnvValue(project);
	for (const key of TARGET_ENV_KEYS) {
		if (Object.hasOwn(env, key)) childEnv[key] = escapeMcpEnvValue(env[key] ?? "");
	}
	return {
		command: "codemem",
		args: ["mcp", "--db-path", resolveViewerDbPath(target.cwd, env)],
		cwd: resolve(target.cwd),
		env: childEnv,
		exposure: "codemode",
	};
}

export type CodememMcpRegistrar = (target: McpTarget) => string | null;

/** Re-register only when the effective config changes; a failed attempt retries next session. */
export function createCodememMcpRegistrar(
	pi: ExtensionAPI,
	mode: PiToolsMode,
	env: NodeJS.ProcessEnv = process.env,
): CodememMcpRegistrar {
	let registeredConfig: string | null = null;
	return (target) => {
		if (mode !== "mcp") return null;
		if (typeof pi.registerMcpServer !== "function") {
			return 'codemem: pi.tools_mode is "mcp", but this Pi host has no MCP registration API. Update Pi (1.1.0 or newer) or set pi.tools_mode to "native" explicitly; no direct tools were registered.';
		}
		try {
			const config = codememMcpServerConfig(target, env);
			const signature = JSON.stringify(config);
			if (signature === registeredConfig) return null;
			pi.registerMcpServer(SERVER_NAME, config);
			registeredConfig = signature;
			return null;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			return `codemem: could not register the codemem MCP server: ${detail}. Check /mcp or set pi.tools_mode to "native" explicitly; no direct tools were registered.`;
		}
	};
}
