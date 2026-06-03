import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { computeContextBreakdown, formatBreakdownText } from "./tokens.js";

export default function contextDetailsExtension(pi: ExtensionAPI) {
	const showContextDetails = async (ctx: ExtensionCommandContext) => {
		await ctx.waitForIdle();

		const breakdown = computeContextBreakdown({
			getBranch: () => ctx.sessionManager.getBranch(),
			getAllTools: () => pi.getAllTools(),
			getContextUsage: () => ctx.getContextUsage(),
			getSystemPrompt: () => ctx.getSystemPrompt(),
		});

		if (breakdown.contextWindow <= 0) {
			if (ctx.hasUI) {
				ctx.ui.notify("No model context window available", "warning");
			}
			return;
		}

		const text = formatBreakdownText(breakdown);
		if (ctx.hasUI) {
			ctx.ui.notify(text, "info");
		} else {
			console.log(text);
		}
	};

	pi.registerCommand("context", {
		description: "Show context token breakdown",
		handler: async (_args, ctx) => {
			await showContextDetails(ctx);
		},
	});

	pi.registerShortcut("ctrl+shift+c", {
		description: "Show context token breakdown",
		handler: async (ctx) => {
			await showContextDetails(ctx);
		},
	});
}
