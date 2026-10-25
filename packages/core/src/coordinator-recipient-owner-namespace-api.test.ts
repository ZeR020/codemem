import { expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { browserConfig } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";

const NOW = "2026-10-06T00:00:00.000Z";
const SERVER_COORDINATOR = "trusted-server-coordinator";

function apiFixture() {
	const store = new BetterSqliteCoordinatorStore(":memory:");
	const close = vi.spyOn(store, "close").mockResolvedValue();
	// Observe the real consumption transaction rather than replacing its result.
	const consume = vi.spyOn(store, "consumeRecipientInvite");
	const verifier = vi.fn(async () => false);
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	const harness = {
		store,
		input: revocationInput("namespace-api"),
		exec: async (sql: string, ...values: unknown[]) => {
			store.db.prepare(sql).run(...values);
		},
		rows: async (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all(),
	};
	const app = (options: { authConfigured: boolean; recipientInviteCoordinatorId?: string }) =>
		createCoordinatorApp({
			storeFactory: () => store,
			runtime: { adminSecret: () => "synthetic-api-secret", now: () => NOW },
			requestVerifier: verifier,
			recipientInviteCoordinatorId: options.recipientInviteCoordinatorId,
			...(options.authConfigured
				? {
						authLink: {
							config: { ...browserConfig, coordinatorId: SERVER_COORDINATOR, enabled: false },
							storeFactory: () => store,
						},
					}
				: {}),
		});
	return { store, close, consume, verifier, fetch, harness, app };
}

const test = it.extend<{ f: ReturnType<typeof apiFixture> }>({
	f: async ({ task: _task }, use) => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		const f = apiFixture();
		try {
			await use(f);
			expect(f.fetch).not.toHaveBeenCalled();
		} finally {
			f.close.mockRestore();
			await f.store.close();
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	},
});

type InviteInput = Awaited<ReturnType<typeof recipientInvite>>["input"];
function requestBody(input: InviteInput) {
	return {
		token: input.token,
		invite_kind: input.inviteKind,
		identity_id: input.identityId,
		device_id: input.deviceId,
		public_key: input.publicKey,
		fingerprint: input.fingerprint,
	};
}
function post(app: ReturnType<typeof createCoordinatorApp>, body: Record<string, unknown>) {
	return app.request("/v1/join", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

for (const kind of ["team_member", "add_device"] as const) {
	for (const coordinatorId of ["", " ", " namespace ", "foreign-coordinator"]) {
		test(`${kind} HTTP rejects invalid or conflicting server namespace ${JSON.stringify(coordinatorId)}`, async ({
			f,
		}) => {
			const { input } = await recipientInvite(f.harness, kind);
			const before = producerSnapshot(f.store.db);
			const app = f.app({ authConfigured: true, recipientInviteCoordinatorId: coordinatorId });
			const response = await post(app, requestBody(input));
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: OWNED_UNAVAILABLE });
			expect(f.consume).not.toHaveBeenCalled();
			expect(producerSnapshot(f.store.db)).toEqual(before);
		});
	}
	test(`${kind} HTTP accepts matching explicit server and auth-link namespace metadata`, async ({
		f,
	}) => {
		const { input } = await recipientInvite(f.harness, kind);
		const app = f.app({
			authConfigured: true,
			recipientInviteCoordinatorId: SERVER_COORDINATOR,
		});
		const response = await post(app, requestBody(input));
		expect(response.status).toBe(200);
		expect(f.consume).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ coordinatorId: SERVER_COORDINATOR, token: input.token }),
		);
	});
	test(`${kind} HTTP acceptance passes the server namespace and ignores foreign retained ownership`, async ({
		f,
	}) => {
		// Arrange: no coordinator field exists in the public request body.
		const { input } = await recipientInvite(f.harness, kind);
		await retainProducerOwner(
			f.store.db,
			{ ...input, coordinatorId: "foreign-coordinator", ownerIdentityId: "foreign-owner" },
			{ removeSource: true },
		);
		const app = f.app({ authConfigured: true });
		// Act
		const response = await post(app, requestBody(input));
		// Assert: a disabled provider ceremony still supplies server-owned namespace metadata.
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, status: "accepted" });
		expect(f.consume).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				coordinatorId: SERVER_COORDINATOR,
				token: input.token,
				identityId: input.identityId,
			}),
		);
		expect(await f.store.getEnrollment(f.harness.input.groupId, input.deviceId)).toMatchObject({
			identity_id: input.identityId,
			enabled: 1,
		});
		expect(f.verifier).not.toHaveBeenCalled();
	});
	for (const coordinatorId of [SERVER_COORDINATOR, "foreign-coordinator"] as const) {
		test(`${kind} HTTP rejects client coordinator_id=${coordinatorId} before consumption`, async ({
			f,
		}) => {
			// Arrange: matching and foreign client namespaces are both forbidden request fields.
			const { input } = await recipientInvite(f.harness, kind);
			const before = producerSnapshot(f.store.db);
			const app = f.app({ authConfigured: true });
			// Act
			const response = await post(app, { ...requestBody(input), coordinator_id: coordinatorId });
			// Assert: validation must not consume a token or dispatch to the store writer.
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "unexpected_recipient_invite_fields" });
			expect(f.consume).not.toHaveBeenCalled();
			expect(producerSnapshot(f.store.db)).toEqual(before);
			expect(f.verifier).not.toHaveBeenCalled();
		});
	}
}

test("unconfigured HTTP server preserves missing-catalog fact-free legacy acceptance", async ({
	f,
}) => {
	// Arrange
	const { input } = await recipientInvite(f.harness, "add_device");
	f.store.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
	const app = f.app({ authConfigured: false });
	// Act
	const response = await post(app, requestBody(input));
	// Assert: absence of trusted configuration must not invent a namespace.
	expect(response.status).toBe(200);
	expect(await response.json()).toMatchObject({ ok: true, status: "accepted" });
	expect(f.consume).toHaveBeenCalledOnce();
	expect(f.consume.mock.calls[0]?.[0]).not.toHaveProperty("coordinatorId");
	expect(f.verifier).not.toHaveBeenCalled();
});

test("unconfigured HTTP server fails closed on relevant retained facts in any namespace", async ({
	f,
}) => {
	// Arrange: even a same-owner foreign fact cannot supply the missing trusted namespace.
	const { input } = await recipientInvite(f.harness, "add_device");
	await retainProducerOwner(
		f.store.db,
		{ ...input, coordinatorId: "foreign-coordinator", ownerIdentityId: input.identityId },
		{ removeSource: true },
	);
	const before = producerSnapshot(f.store.db);
	const app = f.app({ authConfigured: false });
	// Act
	const response = await post(app, requestBody(input));
	// Assert
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: OWNED_UNAVAILABLE });
	expect(f.consume).toHaveBeenCalledOnce();
	expect(f.consume.mock.calls[0]?.[0]).not.toHaveProperty("coordinatorId");
	expect(producerSnapshot(f.store.db)).toEqual(before);
	expect(f.verifier).not.toHaveBeenCalled();
});
