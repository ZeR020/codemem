# @codemem/pi-extension

Pi coding-agent extension for [codemem](https://github.com/kunickiaj/codemem): session ingest and turn-local memory injection.

## Install

Requires Pi 1.1.0 or newer, below 2.0. Upgrade an older host with `pi update` (`pi update --extensions` reconciles installed packages, not the host).

```bash
npm i -g codemem
codemem setup --pi-only
```

Restart Pi after setup. `codemem setup --pi-only` configures only Pi. A fresh setup adds `npm:@codemem/pi-extension@<version>` to `settings.json` `packages` (`PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`); an existing configured dev path may be retained. Useful flags:

| Flag | Purpose |
| --- | --- |
| `--pi-only` | Only configure pi |
| `--pi-mcp` | Opt into MCP via third-party `pi-mcp-adapter` (writes `mcp.json` only when detected) |
| `--pi-extension-path <path>` | Dev: write a local-path `packages` entry instead of the npm pin |

Dev / local-path install (equivalent to `--pi-extension-path`):

```json
{
  "packages": ["/absolute/path/to/codemem/packages/pi-extension"]
}
```

Build first so `dist/index.js` exists (`pnpm --filter @codemem/pi-extension build`).

**Uninstall:** remove the `@codemem/pi-extension` packages entry and restart Pi. This disables its capture/injection hooks, direct tools and extension-owned MCP registration in that Pi instance. Stored memories remain intact; manual `mcp.json` entries remain user-owned and can still expose tools independently.

## What it does

- **Ingest** — ordinary session events (`session_start`, user/assistant messages, tool calls/results) prefer `POST /api/pi-hooks` (`source: "pi"`), with `codemem pi-hook-ingest` CLI fallback (spool on failure). Boundary events (`session_before_compact`, `session_shutdown`) always attempt the CLI path so a flush can run; failure is fail-open.
- **MCP recall safety** — excludes result/error bodies from the exact `mcp__codemem__memory_*` namespace and containing codemode aggregates in the ingest copy, without changing the result delivered to Pi or the model. See [Pi recall-feedback exclusion](https://github.com/kunickiaj/codemem/blob/main/docs/architecture.md#pi-recall-feedback-exclusion).
- **Injection** — on pi's `context` event, appends a `## codemem memories` block to the latest user message of the **request copy** (never the system prompt, never the saved session). Older user messages replay the exact bytes already injected for them, and a new pack is fetched only for the latest undecided message, so the provider's prefix cache stays stable. Already-shown items are cut from new packs when the pack response carries renderer spans. A contract-valid HTTP or `pack --json` response, including a zero-item pack, ends that fetch; `{}` and error-shaped bodies fall through. Those span-bearing successes log `inject.pack.ok source=pi` to the plugin log, the same line `pi-hook-inject` writes when it is the fallback. Decisions live in memory: a restart fetches again.
- **File context** — after a successful built-in `read`, related memories may be appended to that tool result. Failed reads and other tools are skipped.
- **Tools** — by default registers the existing `codemem mcp` server with Pi, exposing all 15 `memory_*` tools through codemode, including `memory_session_search`. No adapter or MCP file is required. Explicit `native` registers 15 direct tools (HTTP preferred, CLI fallback); explicit `mcp-adapter` leaves delivery to the legacy adapter. Native HTTP proves the viewer serves this process's database and identity before sending requests; an unproven/stale viewer or 409 falls back to the targeted CLI. Non-idempotent `memory_remember` does not replay ambiguous HTTP failures. MCP session search runs against the server's own store with the same bounds and raw user/assistant-text privacy; it is not visibility-filtered memory search.
- **Compaction** — `session_before_compact` attempts a flush only and never returns a custom summary. `session_compact` skips one new fetch only when `willRetry` is set and `reason` is not `manual`. Failed compaction, `agent_settled`, manual compaction, and a later user message clear that skip. A threshold compact skips only if that same guard matches.
- **Fork/resume** — re-keys stream identity on every `session_start`. Ingest cursor metadata persists via `pi.appendEntry` (`codemem.cursor`). Recall decisions stay in memory and are cleared on `session_start`; a restart refetches.
- **Cross-agent** — one shared, project-scoped store. Memories from OpenCode/Claude/Codex inject into pi and the reverse.
- **Dashboard** — pi rows appear in the source-agnostic feed/sessions/projects tabs with no extra setup.

Tool purposes and troubleshooting: [Pi extension](https://github.com/kunickiaj/codemem/blob/main/docs/plugin-reference.md#pi-extension).

## Observer derivation (v1)

Setup can fill unset `observer_*` keys from pi's API-key providers (cheap-model-first). Credentials stay in memory only and are never written to codemem config. `unconfigured (oauth-only)` is an auto-derivation status when only OAuth credentials are available, not the state of every observer connection. Configure observer credentials or the connection separately, with provider or model overrides as needed ([observer auth](https://github.com/kunickiaj/codemem/blob/main/docs/user-guide.md#observer-auth-configuration)). Explicit `observer_*` config/env always wins.

## Configuration

Read from `CODEMEM_CONFIG` when set, otherwise `$XDG_CONFIG_HOME/codemem` or `~/.config/codemem`, using an existing `config.json` then `config.jsonc`. Pi keys live under the `pi` object, with `CODEMEM_PI_*` env overrides.

| Key / env | Default | Meaning |
| --- | --- | --- |
| `pi.tools_mode` / `CODEMEM_PI_TOOLS_MODE` | `mcp` | `mcp`: Pi-managed MCP with codemode exposure; `native`: 15 direct tools; `mcp-adapter`: independently configured adapter |
| `pi.inject_prompts` / `CODEMEM_PI_INJECT_PROMPTS` | `true` | Attach the memory pack to the latest user message on each model request |
| `pi.file_context` / `CODEMEM_PI_FILE_CONTEXT` | `true` | Append related memories to successful built-in read results when available |

Shared viewer / inject knobs (same as other clients):

| Env | Default | Meaning |
| --- | --- | --- |
| `CODEMEM_VIEWER_HOST` | `127.0.0.1` | Viewer host |
| `CODEMEM_VIEWER_PORT` | `38888` | Viewer port |
| `CODEMEM_VIEWER` | `1` | Enable viewer use |
| `CODEMEM_VIEWER_AUTO` | `1` | Auto-start `codemem serve start` when needed |
| `CODEMEM_RAW_EVENTS_BACKOFF_MS` | `10000` | Backoff after HTTP stream failure before retrying |
| `CODEMEM_INJECT_LIMIT` | `8` | Pack item limit |
| `CODEMEM_INJECT_TOKEN_BUDGET` | `800` | Pack token budget |
| `CODEMEM_INJECT_MAX_CHARS` | `16000` | Max injection block chars |
| `CODEMEM_INJECT_RETAINED_TOKEN_BUDGET` | uncapped | Optional approximate token ceiling for blocks already injected in the session (estimated as `ceil(chars / 4)`). Unset, zero, negative, and invalid values mean no cap; when enabled, a full ceiling attaches nothing new, fetches nothing, and never removes or truncates blocks already attached |
| `CODEMEM_PI_HOOK_HTTP_TIMEOUT_MS` | `5000` | Ingest and native-tool HTTP timeout (ms). Does not set the pack-fetch timeout |

Example config:

```json
{
  "pi": {
    "tools_mode": "mcp",
    "inject_prompts": true,
    "file_context": true
  }
}
```

### Built-in MCP default and migration

Absent/empty mode selects `mcp`, and fresh setup writes `mcp`. Older setups that recorded `native` remain native: setup preserves explicit `native`, `mcp` and `mcp-adapter` choices rather than automatically migrating them. Set `pi.tools_mode` to `"mcp"` (or `CODEMEM_PI_TOOLS_MODE=mcp`) and reload Pi to switch; set `"native"` and reload to roll back. The existing `toolsMode` alias is also preserved; `tools_mode` wins unless nullish. A recognized environment value overrides the file. `--pi-mcp` remains the legacy adapter flag, not a requirement for built-in MCP.

In `mcp`, Pi starts `codemem mcp` with the session cwd, resolved database and project, and inherited environment/identity. All 15 tools, including session search, are discoverable through codemode's `searchTools()` without 15 direct model declarations. Ingest, injection and recall-feedback protection stay enabled. No `mcp.json` is created or edited.

User controls still win: `--no-mcp`, tool exclusions and `autoEnableCodemode: false` are not overridden. A same-name `mcp.json` entry overrides the extension registration and can set `enabled`, `exposure` or `toolExposure`. An adapter owning `/mcp` displaces built-in MCP; remove/disable it to use built-in delivery. Check Pi's `/mcp` diagnostics and [precedence guidance](https://github.com/kunickiaj/codemem/blob/main/docs/plugin-reference.md#mcp-default-and-precedence). Registration errors never silently enable direct tools; fix the reported cause or explicitly select `native` and reload.

## Lifecycle

Per pi extension rules: the factory only wires handlers. Viewer auto-start and other session resources begin on `session_start` and clean up idempotently on `session_shutdown`. Session state is re-keyed from `ctx.sessionManager.getSessionId()` on every `session_start`; durable ingest cursors persist via `pi.appendEntry` (`codemem.cursor`). Recall decisions are not session entries.

## Peer dependencies

- `@earendil-works/pi-coding-agent` `>=1.1.0 <2` (declared host peer)
- `typebox` (tool parameter schemas)

No `@codemem/core` or native modules load inside the pi process.
