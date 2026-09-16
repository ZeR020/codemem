import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("runtime import boundaries", () => {
	it("keeps recipient policy onboarding independent of share operations", () => {
		const source = readFileSync(new URL("recipient-policy-onboarding.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from ["']\.\/share-operation\.js["']/);
	});
});
