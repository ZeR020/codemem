import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	type NegativeOwnerConsistency,
	prepareNegativeOwnerConsistency,
	prepareUnknownNamespaceOwnerConsistency,
	withNegativeOwnerWrite,
} from "./coordinator-owner-negative-consistency.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";

export function validateRecipientOwnerInput(input: CoordinatorConsumeRecipientInviteInput): void {
	if (
		!input.identityId ||
		!input.deviceId ||
		!input.publicKey ||
		!input.fingerprint ||
		input.identityId !== input.identityId.trim() ||
		input.deviceId !== input.deviceId.trim() ||
		input.identityId.length > 256 ||
		input.deviceId.length > 256 ||
		/[\p{Cc}\p{Cf}]/u.test(input.identityId) ||
		/[\p{Cc}\p{Cf}]/u.test(input.deviceId)
	)
		throw new Error("invite_identity_conflict");
}

export function prepareRecipientOwnerConsistency(
	backend: Pick<AuthLinkBackend, "first" | "all">,
	input: CoordinatorConsumeRecipientInviteInput,
): Promise<NegativeOwnerConsistency | null> {
	if (input.coordinatorId === undefined)
		return prepareUnknownNamespaceOwnerConsistency(backend, input);
	if (!isAuthControllerId(input.coordinatorId)) return Promise.resolve(null);
	return prepareNegativeOwnerConsistency(backend, {
		coordinatorId: input.coordinatorId,
		ownerIdentityId: input.identityId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	});
}

export async function assertRecipientOwnerConsistency(
	backend: Pick<AuthLinkBackend, "first">,
	predicate: AuthLinkStatement | null,
): Promise<void> {
	if (!predicate || (await backend.first<{ matches: number }>(predicate))?.matches !== 1)
		throw new Error("device_ownership_authorization_unavailable");
}

export function recipientOwnerWriteSql(sql: string, predicate: AuthLinkStatement): string {
	return withNegativeOwnerWrite({ sql, values: [] }, predicate).sql;
}
