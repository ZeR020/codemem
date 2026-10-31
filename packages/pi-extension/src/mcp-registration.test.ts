// Explicit `mcp` handoff; pi template-parses env values, so roundtrip them through its own resolver.
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	codememMcpServerConfig,
	createCodememMcpRegistrar,
	escapeMcpEnvValue,
	type McpTarget,
} from "./mcp-registration.js";

type Registered = { name: string; config: Record<string, unknown> };

type OfficialResolver = {
	resolveConfigValue(value: string, env?: Record<string, string>): string | undefined;
	isCommandConfigValue(value: string): boolean;
};

/** pi's built-in resolver is not in the package export map; load the shipped file directly. */
async function officialResolver(): Promise<OfficialResolver> {
	const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
	const url = new URL("./core/resolve-config-value.js", entry).href;
	return (await import(/* @vite-ignore */ url)) as OfficialResolver;
}

function envOf(call: Registered | undefined): Record<string, string> {
	return (call?.config.env ?? {}) as Record<string, string>;
}

function createMockPi(register: boolean | "throws" = true) {
	const calls: Registered[] = [];
	const pi = {
		registerMcpServer(name: string, config: unknown) {
			calls.push({ name, config: config as Record<string, unknown> });
			if (register === "throws") throw new Error("invalid codemem server config");
		},
	};
	if (register === false) delete (pi as { registerMcpServer?: unknown }).registerMcpServer;
	return { pi: pi as unknown as ExtensionAPI, calls };
}

const TARGET: McpTarget = { cwd: "/work/app", project: "app" };

/** The registration is always stdio; narrow the SDK union before reading its fields. */
function stdioConfig(target: McpTarget, env: NodeJS.ProcessEnv) {
	const config = codememMcpServerConfig(target, env);
	if (!("command" in config)) throw new Error("expected a stdio MCP server config");
	return config;
}

describe("codememMcpServerConfig", () => {
	it("hands pi the codemem stdio server with codemode exposure and the session target", () => {
		const config = stdioConfig(TARGET, {
			HOME: "/home/u",
			CODEMEM_DB: "state/mem.sqlite",
		});

		expect(config).toEqual({
			command: "codemem",
			args: ["mcp", "--db-path", "/work/app/state/mem.sqlite"],
			cwd: "/work/app",
			env: { CODEMEM_PROJECT: "app", HOME: "/home/u" },
			exposure: "codemode",
		});
	});

	it("resolves ~ and relative database paths through the session target", () => {
		const dbArg = (target: McpTarget, env: NodeJS.ProcessEnv) => stdioConfig(target, env).args?.[2];

		expect(dbArg(TARGET, { HOME: "/home/u", CODEMEM_DB: "~/db/mem.sqlite" })).toBe(
			"/home/u/db/mem.sqlite",
		);
		expect(dbArg(TARGET, { HOME: "/home/u", CODEMEM_DB: "state/mem.sqlite" })).toBe(
			"/work/app/state/mem.sqlite",
		);
		expect(stdioConfig({ cwd: "app", project: null }, { HOME: "/home/u" }).cwd).toBe(
			resolve("app"),
		);
	});

	it("inherits identity, config, runtime, and home values exactly", async () => {
		const resolver = await officialResolver();
		const base = {
			HOME: "/home/u",
			XDG_CONFIG_HOME: "",
			CODEMEM_CONFIG: "/cfg/codemem.json",
			CODEMEM_RUNTIME_ROOT: "./runtime",
			CODEMEM_DB: "/db/mem.sqlite",
		};
		const inherited = stdioConfig(TARGET, base).env ?? {};
		expect(inherited.HOME).toBe("/home/u");
		expect(inherited.XDG_CONFIG_HOME).toBe("");
		expect(Object.hasOwn(inherited, "XDG_CONFIG_HOME")).toBe(true);
		expect(inherited.CODEMEM_CONFIG).toBe("/cfg/codemem.json");
		expect(inherited.CODEMEM_RUNTIME_ROOT).toBe("./runtime");
		// Unset stays unset; the database target travels as an argument, not env.
		expect(Object.hasOwn(inherited, "CODEMEM_ACTOR_ID")).toBe(false);
		expect(Object.hasOwn(inherited, "CODEMEM_DB")).toBe(false);

		const emptyActor = stdioConfig(TARGET, { ...base, CODEMEM_ACTOR_ID: "" }).env ?? {};
		expect(emptyActor.CODEMEM_ACTOR_ID).toBe("");
		expect(Object.hasOwn(emptyActor, "CODEMEM_ACTOR_ID")).toBe(true);

		const populated = stdioConfig(TARGET, { ...base, CODEMEM_ACTOR_ID: "actor$1" }).env ?? {};
		const actor = populated.CODEMEM_ACTOR_ID ?? "";
		expect(actor).toBe("actor$$1");
		expect(resolver.resolveConfigValue(actor, {})).toBe("actor$1");
	});

	it("preserves the resolved project verbatim and roundtrips pi's official resolver", async () => {
		const resolver = await officialResolver();
		const project = "project $HOME ";
		const env = stdioConfig({ cwd: "/work/app", project }, { HOME: "/home/u" }).env ?? {};

		const escapedProject = env.CODEMEM_PROJECT ?? "";
		expect(escapedProject).toBe("project $$HOME ");
		expect(resolver.resolveConfigValue(escapedProject, {})).toBe(project);

		for (const value of [
			"plain",
			"a$b",
			"$$",
			"$" + "{HOME}",
			"!echo PWNED",
			"  lead and trail  ",
			"$HOME",
			"!x$" + "{Y}z",
		]) {
			const escaped = escapeMcpEnvValue(value);
			expect(resolver.resolveConfigValue(escaped, {}), value).toBe(value);
			expect(resolver.isCommandConfigValue(escaped), value).toBe(false);
		}
	});
});

describe("createCodememMcpRegistrar", () => {
	it("registers nothing outside explicit mcp mode", () => {
		for (const mode of ["native", "mcp-adapter"] as const) {
			const { pi, calls } = createMockPi();
			expect(createCodememMcpRegistrar(pi, mode, { HOME: "/home/u" })(TARGET)).toBeNull();
			expect(calls, mode).toEqual([]);
		}
	});

	it("registers once and re-registers only on an effective target change", () => {
		const { pi, calls } = createMockPi();
		const register = createCodememMcpRegistrar(pi, "mcp", { HOME: "/home/u" });

		expect(register({ cwd: "/work/a", project: "a" })).toBeNull();
		expect(register({ cwd: "/work/a", project: "a" })).toBeNull();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.name).toBe("codemem");
		expect(calls[0]?.config.exposure).toBe("codemode");

		expect(register({ cwd: "/work/a", project: "b" })).toBeNull();
		expect(calls).toHaveLength(2);
		expect(envOf(calls[1]).CODEMEM_PROJECT).toBe("b");

		expect(register({ cwd: "/work/b", project: "b" })).toBeNull();
		expect(calls).toHaveLength(3);
		expect(calls[2]?.config.cwd).toBe("/work/b");
	});

	it("re-registers when inherited config, runtime, database, or actor values change", () => {
		const { pi, calls } = createMockPi();
		const env: NodeJS.ProcessEnv = { HOME: "/home/u", CODEMEM_DB: "/db/one.sqlite" };
		const register = createCodememMcpRegistrar(pi, "mcp", env);

		expect(register(TARGET)).toBeNull();
		for (const [key, value] of [
			["CODEMEM_DB", "/db/two.sqlite"],
			["CODEMEM_CONFIG", "/cfg/two.json"],
			["CODEMEM_RUNTIME_ROOT", "./runtime-two"],
			["CODEMEM_ACTOR_ID", "actor-2"],
		] as const) {
			env[key] = value;
			expect(register(TARGET)).toBeNull();
		}

		expect(calls).toHaveLength(5);
		expect(calls[4]?.config.args).toContain("/db/two.sqlite");
		expect(envOf(calls[4]).CODEMEM_ACTOR_ID).toBe("actor-2");
	});

	it("reports a host without the registration API instead of direct tools", () => {
		const { pi, calls } = createMockPi(false);
		const error = createCodememMcpRegistrar(pi, "mcp", {})(TARGET);

		expect(error).toContain("no MCP registration API");
		expect(error).toContain('"native"');
		expect(error).toMatch(/no direct tools/i);
		expect(calls).toEqual([]);
	});

	it("reports a rejected registration and retries on the next session", () => {
		const { pi, calls } = createMockPi("throws");
		const register = createCodememMcpRegistrar(pi, "mcp", {});

		const first = register(TARGET);
		expect(first).toContain("could not register the codemem MCP server");
		expect(first).toContain("invalid codemem server config");
		expect(register(TARGET)).toContain("could not register");
		expect(calls).toHaveLength(2);
	});
});
