import { createHash } from "node:crypto";

export function managedProjectScopeId(
	coordinatorGroupId: string,
	canonicalProjectIdentity: string,
): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([coordinatorGroupId, canonicalProjectIdentity]))
		.digest("hex");
	return `managed-project:${digest}`;
}
