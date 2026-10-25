import { createHash } from "node:crypto";
import { type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function insert(
	f: LinkFixture,
	table:
		| "coordinator_auth_link_attempts"
		| "coordinator_auth_browser_transactions"
		| "coordinator_auth_device_claims",
	row: Record<string, string | number | null>,
) {
	const entries = Object.entries(row);
	f.db
		.prepare(
			`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		)
		.run(...entries.map(([, value]) => value));
}

// Same finalized DEVICE_CLAIM birth as the accepted linked-owner fixtures, local
// to core's compilation boundary. Synthetic persisted proof, not provider login.
export async function seedLinkedOwnerBirth(f: LinkFixture) {
	await f.store.createGroup("group-a");
	await f.store.enrollDevice("group-a", {
		deviceId: "device-a",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
	});
	const browser = hash("device-claim-fixture:completed-attempt");
	const common = {
		coordinator_id: f.cfg.coordinatorId,
		identity_id: "identity-a",
		group_id: "group-a",
		device_id: "device-a",
		fingerprint: "a".repeat(64),
		controller_attestation_id: null,
		auth_config_revision: f.cfg.revision,
		authority_kind: "device_claim",
	};
	insert(f, "coordinator_auth_link_attempts", {
		...common,
		attempt_id: "completed-attempt",
		public_key: CANONICAL_PUBLIC_KEY,
		controller_review_receipt_id: null,
		controller_revision: null,
		issuer: f.cfg.issuer,
		runtime_verifier_hash: hash(`${browser}:runtime`),
		loopback_redirect: "http://127.0.0.1:4567/complete",
		state: "finalized",
		browser_transaction_hash: browser,
		account_subject: "private-claim-subject",
		completion_secret_hash: hash(`${browser}:completion`),
		link_id: "claim-a",
		browser_start_hash: hash(`${browser}:start`),
		created_at_ms: NOW - 100,
		expires_at_ms: NOW + 599900,
		claimed_at_ms: NOW - 80,
		oidc_verified_at_ms: NOW - 60,
		confirmed_at_ms: NOW - 40,
		finalized_at_ms: NOW,
	});
	seedBrowserProof(f, browser);
	seedClaim(f);
}

function seedBrowserProof(f: LinkFixture, browser: string) {
	insert(f, "coordinator_auth_browser_transactions", {
		coordinator_id: f.cfg.coordinatorId,
		browser_transaction_hash: browser,
		purpose: "link",
		attempt_id: "completed-attempt",
		state_hash: hash(`${browser}:state`),
		binder_hash: hash(`${browser}:binder`),
		issuer: f.cfg.issuer,
		auth_config_revision: f.cfg.revision,
		redirect_uri: "https://coordinator.example.test/auth/callback",
		state: "consumed",
		nonce: null,
		pkce_verifier: null,
		claim_token: hash(`${browser}:claim`),
		created_at_ms: NOW - 90,
		expires_at_ms: NOW + 599910,
		consumed_at_ms: NOW - 70,
	});
}

function seedClaim(f: LinkFixture) {
	insert(f, "coordinator_auth_device_claims", {
		claim_id: "claim-a",
		coordinator_id: f.cfg.coordinatorId,
		identity_id: "identity-a",
		group_id: "group-a",
		device_id: "device-a",
		public_key: CANONICAL_PUBLIC_KEY,
		fingerprint: "a".repeat(64),
		key_id: EXPECTED_KEY_ID,
		attempt_id: "completed-attempt",
		issuer: f.cfg.issuer,
		auth_config_revision: f.cfg.revision,
		created_at_ms: NOW,
	});
}
