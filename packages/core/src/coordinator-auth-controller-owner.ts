import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";

/** Recovery-only root WITH stage: ordinary seed schemas need no V3 tables.
 * Keep the independent provenance expression outside the enrollment/history
 * expression tree to fit D1's depth 100 limit. Both still share one statement.
 */
export const AUTH_CONTROLLER_OWNER_CTE = `controller_owner_connection AS MATERIALIZED (
 SELECT l.coordinator_id,l.identity_id FROM coordinator_auth_account_links l CROSS JOIN snapshot s
 WHERE l.coordinator_id=json_extract(s.value,'$.accountOwnerTarget.coordinatorId')
 AND l.identity_id=json_extract(s.value,'$.accountOwnerTarget.targetIdentityId')
 AND l.issuer=json_extract(s.value,'$.accountOwnerTarget.issuer')
 AND l.link_id=json_extract(s.value,'$.accountOwnerTarget.linkId')
 AND l.auth_config_revision=json_extract(s.value,'$.accountOwnerTarget.authConfigRevision')
 AND l.created_at_ms=json_extract(s.value,'$.accountOwnerTarget.createdAtMs')
 AND ${CONNECTION_NOT_REVOKED_SQL}
 AND ${authAccountLinkProvenanceSql("l", { connections: true })})`;

export const AUTH_CONTROLLER_OWNER_GUARD = `AND EXISTS (
 SELECT 1 FROM controller_owner_connection l
 WHERE NOT EXISTS (SELECT 1 FROM coordinator_auth_device_claims d
 WHERE d.coordinator_id=l.coordinator_id AND (d.device_id=e.device_id OR d.key_id=?)
 AND (d.identity_id<>l.identity_id OR d.group_id<>e.group_id
 OR d.device_id<>e.device_id OR d.public_key<>e.public_key OR d.fingerprint<>e.fingerprint))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations other
 WHERE other.coordinator_id=l.coordinator_id AND other.group_id=e.group_id
 AND other.device_id=e.device_id AND other.fingerprint=e.fingerprint
 AND (other.identity_id<>l.identity_id OR other.public_key<>e.public_key OR other.revoked_at IS NOT NULL))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations other
 WHERE other.coordinator_id=l.coordinator_id AND other.identity_id<>l.identity_id
 AND (other.device_id=e.device_id OR other.public_key=e.public_key
 OR other.public_key IN (SELECT public_key FROM snapshot_history_keys))))`;

/** Retained trusted controller rows are ownership evidence even if their Team or
 * enrollment is gone. Weak historical Team assignments are not consulted here.
 */
export const AUTH_CONTROLLER_SUBJECT_OWNER_CONFLICT_SQL = `WITH owner_subject(value) AS (SELECT ?)
 SELECT 1 AS conflict FROM coordinator_auth_controller_attestations other CROSS JOIN owner_subject s
 WHERE other.coordinator_id=json_extract(s.value,'$.coordinatorId') AND other.identity_id<>?
 AND (other.device_id=json_extract(s.value,'$.deviceId')
 OR other.public_key=json_extract(s.value,'$.publicKey')
 OR other.public_key IN (SELECT json_extract(j.value,'$.public_key') FROM json_each(s.value,'$.keys') j))
 LIMIT 1`;

export interface CoordinatorAuthControllerOwnerSnapshot {
	purpose: "existing_account_owner";
	coordinatorId: string;
	targetIdentityId: string;
	issuer: string;
	linkId: string;
	authConfigRevision: string;
	createdAtMs: number;
}
