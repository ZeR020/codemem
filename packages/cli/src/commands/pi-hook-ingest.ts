/**
 * codemem pi-hook-ingest — read a single pi extension event JSON from stdin
 * and enqueue it for raw-event processing.
 *
 * HTTP-first strategy: POST to the running viewer's /api/pi-hooks endpoint,
 * then fall back to direct raw-event enqueue via the local store when the
 * viewer is unreachable. session_before_compact / session_shutdown trigger a
 * best-effort boundary flush with source "pi".
 *
 * Usage (from the pi extension CLI fallback):
 *   echo '{"piEvent":"session_start","sessionId":"...","cwd":"..."}' \
 *     | codemem pi-hook-ingest
 */
import { readFileSync } from "node:fs";
import {
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromPiEvent,
	connect,
	ensureSchemaBootstrapped,
	flushRawEvents,
	ingestRawEvents,
	loadSqliteVec,
	MemoryStore,
	ObserverClient,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addViewerHostOptions, type DbOpts, resolveDbOpt } from "../shared-options.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";
import {
	drainPiHookSpool,
	hasPiHookSpooledEntries,
	PiHookLockBusyError,
	piHookLockTtlSeconds,
	recoverStalePiHookTmpSpool,
	shouldForcePiBoundaryFlush,
	spoolPiHookPayload,
	withPiHookIngestLock,
} from "./pi-hook-ingest-spool.js";
import { isViewerTargetConflict, rawEventTarget } from "./raw-event-target.js";

type IngestVia = "http" | "direct" | "spool" | "spool_lock_busy";
type IngestResult = { inserted: number; skipped: number; via: IngestVia };
type HttpIngestResult = {
	ok: boolean;
	inserted: number;
	skipped: number;
	targetMismatch?: boolean;
};
type IngestOpts = { host: string; port: string | number } & DbOpts;
type BoundaryFlush = (
	payload: Record<string, unknown>,
	dbPath: string,
) => Promise<boolean | undefined> | boolean | undefined;
type IngestDeps = {
	httpIngest?: typeof tryHttpIngest;
	directIngest?: typeof directEnqueuePiHook;
	resolveDb?: typeof resolveDbPath;
	boundaryFlush?: BoundaryFlush;
};

const DEFAULT_HTTP_TIMEOUT_MS = 5000;

function httpTimeoutMs(): number {
	const parsed = Number.parseInt(process.env.CODEMEM_PI_HOOK_HTTP_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

function emitStructuredError(errorCode: string, message: string): void {
	console.log(JSON.stringify({ error: errorCode, message }));
	process.exitCode = 1;
}

function envTruthyValue(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Try to POST the pi event payload to the running viewer server.
 *
 * Returns `ok: true` whenever the viewer accepts the request and returns a
 * well-shaped JSON body with numeric `inserted` / `skipped` fields — including
 * deterministic skips (unsupported or flush-only events). Retrying those via
 * the direct path would produce the same skip.
 */
async function tryHttpIngest(
	payload: Record<string, unknown>,
	host: string,
	port: number,
): Promise<HttpIngestResult> {
	const url = `http://${host}:${port}/api/pi-hooks`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), httpTimeoutMs());
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			return {
				ok: false,
				inserted: 0,
				skipped: 0,
				targetMismatch: isViewerTargetConflict(res.status, body),
			};
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			logHookEvent("codemem pi-hook-ingest HTTP accepted with invalid response body");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			logHookEvent("codemem pi-hook-ingest HTTP accepted with invalid response type");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		const obj = body as Record<string, unknown>;
		if (typeof obj.inserted !== "number" || typeof obj.skipped !== "number") {
			logHookEvent("codemem pi-hook-ingest HTTP accepted with unexpected response body");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		return { ok: true, inserted: obj.inserted, skipped: obj.skipped };
	} catch {
		return { ok: false, inserted: 0, skipped: 0 };
	} finally {
		clearTimeout(timeout);
	}
}

/** Fall back to direct raw-event enqueue via the local SQLite store. */
export function directEnqueuePiHook(
	payload: Record<string, unknown>,
	dbPath: string,
): { inserted: number; skipped: number } {
	const envelope = buildRawEventEnvelopeFromPiEvent(payload);
	if (!envelope) return { inserted: 0, skipped: 1 };

	// Attribution contract (D3): source is always the envelope's literal
	// "pi" — ingestRawEvents derives it from the envelope, never a default.
	const db = connect(dbPath);
	try {
		try {
			loadSqliteVec(db);
		} catch {
			// sqlite-vec is not required for raw-event enqueue.
		}
		// Auto-bootstrap fresh databases before touching raw_events. The viewer
		// server's MemoryStore constructor normally bootstraps first, but hooks
		// can race its startup (pi-hook-ingest is a separate CLI process).
		ensureSchemaBootstrapped(db);
		const result = ingestRawEvents({ db }, envelope);
		return { inserted: result.inserted, skipped: result.skipped };
	} finally {
		db.close();
	}
}

/**
 * Best-effort boundary flush for session_before_compact / session_shutdown.
 * Always passes source "pi" — never relies on a helper default.
 * Returns false when observer/store/extraction fail so a recovered-boundary
 * retry can keep the spool; live hook callers stay fail-open and ignore it.
 */
async function flushBoundaryRawEvents(
	payload: Record<string, unknown>,
	dbPath: string,
): Promise<boolean> {
	const envelope = buildRawEventEnvelopeFromPiEvent(payload);
	const signal = buildPiFlushSignalFromEvent(payload);
	const sessionId = envelope?.session_stream_id ?? signal?.session_id ?? null;
	if (!sessionId) return true;

	// Explicit source "pi" per attribution-audit.md — never bare defaults.
	const source = "pi" as const;
	const cwd = envelope?.cwd ?? signal?.cwd ?? null;
	const project = envelope?.project ?? signal?.project ?? null;
	const startedAt = envelope?.started_at ?? null;

	let observer: ObserverClient;
	try {
		observer = new ObserverClient();
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush observer init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	let store: MemoryStore;
	try {
		store = new MemoryStore(dbPath);
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush store init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	try {
		await flushRawEvents(
			store,
			{ observer },
			{
				opencodeSessionId: sessionId,
				source,
				cwd,
				project,
				startedAt,
				maxEvents: null,
			},
		);
		return true;
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush raw events failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	} finally {
		store.close();
	}
}

type DirectFallback = { ok: true; result: { inserted: number; skipped: number } } | { ok: false };

function dbPathGetter(resolveDb: typeof resolveDbPath, opts: IngestOpts): () => string {
	let cached: string | null = null;
	return () => {
		if (cached === null) cached = resolveDb(resolveDbOpt(opts));
		return cached;
	};
}

function tryDirectFallback(
	directIngest: typeof directEnqueuePiHook,
	getDbPath: () => string,
	queued: Record<string, unknown>,
): DirectFallback {
	try {
		return { ok: true, result: directIngest(queued, getDbPath()) };
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest direct fallback failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { ok: false };
	}
}

async function flushOnBoundaryIfRequested(
	payload: Record<string, unknown>,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
): Promise<void> {
	if (!shouldForcePiBoundaryFlush(payload)) return;
	try {
		directIngest(payload, getDbPath());
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush direct write failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		await boundaryFlush(payload, getDbPath());
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Replayed-variant of flushOnBoundaryIfRequested used on the spool drain
 * path: a boundary flush that still fails keeps the spooled payload alive
 * (caller reports failure so drainPiHookSpool does not delete the entry).
 * Observes flushBoundaryRawEvents' boolean result — the production helper
 * catches observer/store/extraction errors and returns false without throwing.
 */
async function flushOnBoundaryForRecoveredPayload(
	payload: Record<string, unknown>,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
): Promise<boolean> {
	if (!shouldForcePiBoundaryFlush(payload)) return true;
	try {
		directIngest(payload, getDbPath());
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush direct write failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	try {
		const flushed = await boundaryFlush(payload, getDbPath());
		if (flushed === false) {
			logHookEvent("codemem pi-hook-ingest boundary flush failed; keeping spooled payload");
			return false;
		}
		return true;
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush failed; keeping spooled payload: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

/** Wrap one payload with the db/identity target fields /api/pi-hooks expects. */
function targetedPiPayload(
	payload: Record<string, unknown>,
	getDbPath: () => string,
): Record<string, unknown> {
	return { ...payload, ...rawEventTarget(getDbPath()) };
}

/** Retry HTTP once more unless the first attempt proved a viewer target mismatch. */
async function retryHttpUnlessMismatch(
	first: HttpIngestResult,
	httpIngest: typeof tryHttpIngest,
	httpPayload: Record<string, unknown>,
	host: string,
	port: number,
): Promise<HttpIngestResult> {
	if (first.targetMismatch) return { ok: false, inserted: 0, skipped: 0, targetMismatch: true };
	return httpIngest(httpPayload, host, port);
}

/**
 * Deliver one spooled payload durably, then replay boundary semantics when the
 * payload is session_before_compact / session_shutdown. A boundary spooled
 * while the viewer and DB were down is flush-only: enqueue alone would store
 * nothing (or skip the flush), so durability requires the full boundary path.
 */
async function deliverQueuedPiHook(
	queuedPayload: Record<string, unknown>,
	httpIngest: typeof tryHttpIngest,
	host: string,
	port: number,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
): Promise<boolean> {
	const queuedHttp = await httpIngest(targetedPiPayload(queuedPayload, getDbPath), host, port);
	const delivered = queuedHttp.ok || tryDirectFallback(directIngest, getDbPath, queuedPayload).ok;
	if (!delivered) return false;
	// A recovered boundary whose flush still fails stays spooled (reported as
	// undelivered) so a later invocation can retry the extraction instead of
	// losing it. Non-boundary payloads are done once durably delivered.
	return flushOnBoundaryForRecoveredPayload(queuedPayload, directIngest, boundaryFlush, getDbPath);
}

async function drainBacklogIfPresent(
	httpIngest: typeof tryHttpIngest,
	host: string,
	port: number,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
): Promise<void> {
	if (!hasPiHookSpooledEntries()) return;
	try {
		await withPiHookIngestLock(async () => {
			recoverStalePiHookTmpSpool(piHookLockTtlSeconds());
			await drainPiHookSpool((queuedPayload) =>
				deliverQueuedPiHook(
					queuedPayload,
					httpIngest,
					host,
					port,
					directIngest,
					boundaryFlush,
					getDbPath,
				),
			);
		});
	} catch (err) {
		if (err instanceof PiHookLockBusyError) return;
		logHookEvent(
			`codemem pi-hook-ingest backlog drain failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
async function runLockedPiHookIngest(
	payload: Record<string, unknown>,
	httpPayload: Record<string, unknown>,
	firstHttp: HttpIngestResult,
	host: string,
	port: number,
	httpIngest: typeof tryHttpIngest,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
): Promise<IngestResult> {
	recoverStalePiHookTmpSpool(piHookLockTtlSeconds());
	await drainPiHookSpool((queuedPayload) =>
		deliverQueuedPiHook(
			queuedPayload,
			httpIngest,
			host,
			port,
			directIngest,
			boundaryFlush,
			getDbPath,
		),
	);
	// A target-conflict 409 means the viewer on this port serves a different
	// database/identity: go straight to the direct path instead of retrying.
	const secondHttp = await retryHttpUnlessMismatch(firstHttp, httpIngest, httpPayload, host, port);
	if (secondHttp.ok) {
		await flushOnBoundaryIfRequested(payload, directIngest, boundaryFlush, getDbPath);
		return { inserted: secondHttp.inserted, skipped: secondHttp.skipped, via: "http" };
	}
	const direct = tryDirectFallback(directIngest, getDbPath, payload);
	if (direct.ok) {
		await flushOnBoundaryIfRequested(payload, directIngest, boundaryFlush, getDbPath);
		return { ...direct.result, via: "direct" };
	}
	if (spoolPiHookPayload(payload)) {
		await flushOnBoundaryIfRequested(payload, directIngest, boundaryFlush, getDbPath);
		return { inserted: 0, skipped: 0, via: "spool" };
	}
	logHookEvent("codemem pi-hook-ingest failed: fallback and spool failed");
	throw new Error("pi-hook-ingest: fallback and spool both failed");
}
async function ingestPiHookLockBusyFallback(
	payload: Record<string, unknown>,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
	err: unknown,
): Promise<IngestResult> {
	logHookEvent("codemem pi-hook-ingest lock busy; trying unlocked fallback");
	const direct = tryDirectFallback(directIngest, getDbPath, payload);
	if (direct.ok) {
		await flushOnBoundaryIfRequested(payload, directIngest, boundaryFlush, getDbPath);
		return { ...direct.result, via: "direct" };
	}
	if (spoolPiHookPayload(payload)) {
		await flushOnBoundaryIfRequested(payload, directIngest, boundaryFlush, getDbPath);
		return { inserted: 0, skipped: 0, via: "spool_lock_busy" };
	}
	logHookEvent("codemem pi-hook-ingest failed: unlocked fallback and spool failed");
	throw err;
}

async function ingestLockedPiHookPayload(
	payload: Record<string, unknown>,
	httpPayload: Record<string, unknown>,
	firstHttp: HttpIngestResult,
	host: string,
	port: number,
	httpIngest: typeof tryHttpIngest,
	directIngest: typeof directEnqueuePiHook,
	boundaryFlush: BoundaryFlush,
	getDbPath: () => string,
): Promise<IngestResult> {
	try {
		return await withPiHookIngestLock(() =>
			runLockedPiHookIngest(
				payload,
				httpPayload,
				firstHttp,
				host,
				port,
				httpIngest,
				directIngest,
				boundaryFlush,
				getDbPath,
			),
		);
	} catch (err) {
		if (!(err instanceof PiHookLockBusyError)) throw err;
		return ingestPiHookLockBusyFallback(payload, directIngest, boundaryFlush, getDbPath, err);
	}
}
/**
 * Ingest one pi extension event using the TS contract:
 * HTTP enqueue first, then locked drain + retry + direct fallback +
 * disk spool durability, with boundary flush on compact/shutdown.
 */
export async function ingestPiHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	const httpIngest = deps.httpIngest ?? tryHttpIngest;
	const directIngest = deps.directIngest ?? directEnqueuePiHook;
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const boundaryFlush = deps.boundaryFlush ?? flushBoundaryRawEvents;
	const port = typeof opts.port === "number" ? opts.port : Number.parseInt(opts.port, 10);
	const getDbPath = dbPathGetter(resolveDb, opts);
	// Every HTTP attempt carries the requested db_path + identity_target so the
	// viewer 409-conflicts when it serves a different database — including
	// drained spool payloads, whose target is this invocation's target.
	const httpPayload = targetedPiPayload(payload, getDbPath);
	const httpResult = await httpIngest(httpPayload, opts.host, port);
	if (httpResult.ok) {
		await drainBacklogIfPresent(
			httpIngest,
			opts.host,
			port,
			directIngest,
			boundaryFlush,
			getDbPath,
		);
		await flushOnBoundaryIfRequested(payload, directIngest, boundaryFlush, getDbPath);
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}
	return ingestLockedPiHookPayload(
		payload,
		httpPayload,
		httpResult,
		opts.host,
		port,
		httpIngest,
		directIngest,
		boundaryFlush,
		getDbPath,
	);
}

const piHookCmd = new Command("pi-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest pi extension event: HTTP first, direct DB fallback");

addDbOption(piHookCmd);
addViewerHostOptions(piHookCmd);

export const piHookIngestCommand = piHookCmd.action(
	async (opts: DbOpts & { host: string; port: string }) => {
		// Honor the global plugin-ignore kill switch first so users can
		// disable every codemem hook side effect by exporting
		// CODEMEM_PLUGIN_IGNORE=1 without having to know which subcommand
		// is wired to which hook. Mirrors the inject command.
		if (envTruthyValue(process.env.CODEMEM_PLUGIN_IGNORE)) {
			return;
		}

		// Read payload from stdin
		let raw: string;
		try {
			raw = readFileSync(0, "utf8").trim();
		} catch {
			emitStructuredError("read_error", "failed to read stdin");
			return;
		}
		if (!raw) {
			emitStructuredError("read_error", "empty stdin");
			return;
		}

		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				emitStructuredError("parse_error", "payload must be a JSON object");
				return;
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			emitStructuredError("parse_error", "invalid JSON");
			return;
		}

		try {
			const result = await ingestPiHookPayload(payload, opts);
			console.log(JSON.stringify(result));
		} catch (err) {
			emitStructuredError("ingest_error", err instanceof Error ? err.message : String(err));
		}
	},
);
