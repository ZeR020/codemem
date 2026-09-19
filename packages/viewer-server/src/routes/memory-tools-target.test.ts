/**
 * Viewer identity targeting for the memory tool-support HTTP twins used by
 * the pi extension's native tools (kunickiaj/codemem#1778 review).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTestSchema, insertTestSession, MemoryStore } from "@codemem/core";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../index.js";
import { currentIdentityTarget } from "./target-validation.js";

let savedEmbeddingDisabled: string | undefined;
beforeAll(() => {
	savedEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
});
afterAll(() => {
	if (savedEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = savedEmbeddingDisabled;
});

function createTestStore(): { store: MemoryStore; cleanup: () => void } {
	const tmpDir = mkdtempSync(join(tmpdir(), "codemem-memory-target-test-"));
	const dbPath = join(tmpDir, "test.sqlite");
	const rawDb = new Database(dbPath);
	initTestSchema(rawDb);
	rawDb
		.prepare(
			"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run("test-device-001", "test-public-key", "test-fingerprint", new Date().toISOString());
	rawDb.close();
	const store = new MemoryStore(dbPath);
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(tmpDir, { recursive: true, force: true });
		},
	};
}

function createTestApp() {
	let store: MemoryStore | null = null;
	let storeCleanup: (() => void) | null = null;
	const staticDir = mkdtempSync(join(tmpdir(), "codemem-memory-target-static-"));
	writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>test</title>");
	const previousStaticDir = process.env.CODEMEM_VIEWER_STATIC_DIR;
	process.env.CODEMEM_VIEWER_STATIC_DIR = staticDir;
	const storeFactory = () => {
		if (!store) {
			const created = createTestStore();
			store = created.store;
			storeCleanup = created.cleanup;
		}
		return store;
	};
	const app = createApp({ storeFactory, sweeper: null });
	return {
		app,
		ensureStore: () => storeFactory(),
		cleanup: () => {
			storeCleanup?.();
			store = null;
			storeCleanup = null;
			if (previousStaticDir == null) delete process.env.CODEMEM_VIEWER_STATIC_DIR;
			else process.env.CODEMEM_VIEWER_STATIC_DIR = previousStaticDir;
			rmSync(staticDir, { recursive: true, force: true });
		},
	};
}

function jsonHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Origin: "http://127.0.0.1:38888",
	};
}

function seedMemories(store: MemoryStore): { sessionId: number; ids: number[] } {
	const sessionId = insertTestSession(store.db);
	store.db.prepare("UPDATE sessions SET project = ? WHERE id = ?").run("test-project", sessionId);
	const ids = [
		store.remember(
			sessionId,
			"discovery",
			"Database migration guide",
			"How to run migrations",
			0.9,
		),
		store.remember(sessionId, "feature", "Auth system", "JWT tokens and refresh flow", 0.8),
	];
	return { sessionId, ids };
}

describe("returns 409 and does not write when db_path mismatches", () => {
	it("remember", async () => {
		const { app, ensureStore, cleanup } = createTestApp();
		try {
			const store = ensureStore();
			const before = store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as {
				n: number;
			};
			const query = new URLSearchParams({ db_path: `${store.dbPath}.other` });
			const res = await app.request(`/api/memories/remember?${query}`, {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({
					kind: "decision",
					title: "Should not land",
					body: "Wrong viewer db",
				}),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "viewer_db_mismatch" },
			});
			const after = store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as {
				n: number;
			};
			expect(after.n).toBe(before.n);
		} finally {
			cleanup();
		}
	});
});

describe("returns 409 and does not write when identity_target mismatches", () => {
	it("remember", async () => {
		const { app, ensureStore, cleanup } = createTestApp();
		try {
			const store = ensureStore();
			const before = store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as {
				n: number;
			};
			const query = new URLSearchParams({
				db_path: store.dbPath,
				identity_target: JSON.stringify({ ...currentIdentityTarget(), device_id: "other-device" }),
			});
			const res = await app.request(`/api/memories/remember?${query}`, {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({
					kind: "decision",
					title: "Should not land",
					body: "Wrong viewer identity",
				}),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "viewer_identity_mismatch" },
			});
			const after = store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as {
				n: number;
			};
			expect(after.n).toBe(before.n);
		} finally {
			cleanup();
		}
	});
});

describe("returns 409 when db_path mismatches", () => {
	it("expand", async () => {
		const { app, ensureStore, cleanup } = createTestApp();
		try {
			const store = ensureStore();
			const { ids } = seedMemories(store);
			const query = new URLSearchParams({ db_path: `${store.dbPath}.other` });
			const res = await app.request(`/api/memories/expand?${query}`, {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({ ids: [ids[0]] }),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "viewer_db_mismatch" },
			});
		} finally {
			cleanup();
		}
	});
});

describe("returns not_found and does not forget when kind/project filters miss", () => {
	it("forget", async () => {
		const { app, ensureStore, cleanup } = createTestApp();
		try {
			const store = ensureStore();
			const { ids } = seedMemories(store);
			const memoryId = ids[0];
			const res = await app.request("/api/memories/forget", {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({
					memory_id: memoryId,
					kind: "decision",
					project: "missing-project",
				}),
			});
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: "not_found" });
			expect(store.get(memoryId)?.active).toBe(1);
		} finally {
			cleanup();
		}
	});
});

describe("returns 409 and does not forget when db_path mismatches", () => {
	it("forget", async () => {
		const { app, ensureStore, cleanup } = createTestApp();
		try {
			const store = ensureStore();
			const { ids } = seedMemories(store);
			const memoryId = ids[0];
			const query = new URLSearchParams({ db_path: `${store.dbPath}.other` });
			const res = await app.request(`/api/memories/forget?${query}`, {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({ memory_id: memoryId }),
			});
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({
				error: { code: "viewer_db_mismatch" },
			});
			expect(store.get(memoryId)?.active).toBe(1);
		} finally {
			cleanup();
		}
	});
});
