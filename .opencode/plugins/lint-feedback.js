import LintFeedbackPlugin from "../../packages/opencode-plugin/src/lint-feedback.ts";
import LintFeedbackV2Plugin from "../../packages/opencode-plugin/src/lint-feedback-v2.ts";

export default Object.freeze({
	id: "codemem-lint-feedback",
	server: LintFeedbackPlugin,
	setup: LintFeedbackV2Plugin.setup,
});
