import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";

const extractAssistantText = (content: AssistantMessage["content"] | string) => {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
};

const getLastAssistantText = (branch: SessionEntry[]) => {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") {
			continue;
		}

		const { message } = entry;
		if (message.role !== "assistant") {
			continue;
		}

		const text = extractAssistantText(message.content).trim();
		if (text) {
			return text;
		}

		if (message.stopReason === "aborted") {
			continue;
		}
	}

	return undefined;
};

const extractCodeBlocks = (markdown: string) => {
	const blocks = [];
	const fenceRegex = /```([^\n`]*)\n([\s\S]*?)```/g;

	for (const match of markdown.matchAll(fenceRegex)) {
		const language = match[1].trim() || undefined;
		let content = match[2];
		if (content.endsWith("\n")) {
			content = content.slice(0, -1);
		}

		const firstLine = content.split("\n")[0] ?? "";
		const preview = firstLine.length > 0 ? firstLine : content.slice(0, 60);

		blocks.push({ language, content, preview });
	}

	return blocks;
};

const formatBlockLabel = (block: ReturnType<typeof extractCodeBlocks>[number], index: number) => {
	const lang = block.language ?? "plain";
	const preview = block.preview.replace(/\s+/g, " ").trim();
	const truncated = preview.length > 55 ? `${preview.slice(0, 55)}…` : preview;
	return `${index + 1}. [${lang}] ${truncated}`;
};

const CLIPBOARD_TOOLS = ["wl-copy", "xclip", "pbcopy", "xsel", "termux-clipboard-set"] as const;

const hasClipboardTool = async (pi: ExtensionAPI) => {
	for (const tool of CLIPBOARD_TOOLS) {
		const result = await pi.exec("which", [tool], { timeout: 1000 });
		if (result.code === 0) {
			return true;
		}
	}
	return false;
};

const showInEditor = async (
	ctx: ExtensionCommandContext,
	block: ReturnType<typeof extractCodeBlocks>[number],
	reason: string,
) => {
	const lang = block.language ?? "plain";
	ctx.ui.notify(reason, "warning");
	await ctx.ui.editor(`Code block (${lang}) — select and copy manually:`, block.content);
};

export default function copyCodeExtension(pi: ExtensionAPI) {
	pi.registerCommand("copy-code", {
		description: "Copy a code block from the last assistant message",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const text = getLastAssistantText(ctx.sessionManager.getBranch());
			if (!text) {
				ctx.ui.notify("No assistant message found", "warning");
				return;
			}

			const blocks = extractCodeBlocks(text);
			if (blocks.length === 0) {
				ctx.ui.notify("No code blocks in last assistant message", "warning");
				return;
			}

			let selectedBlock = blocks[0];
			if (blocks.length > 1) {
				const choice = await ctx.ui.select(
					"Select code block to copy:",
					blocks.map(formatBlockLabel),
				);
				if (!choice) {
					return;
				}

				const index = Number.parseInt(choice.split(".")[0] ?? "", 10) - 1;
				if (index < 0 || index >= blocks.length) {
					return;
				}
				selectedBlock = blocks[index];
			}

			const lang = selectedBlock.language ?? "plain";
			const lineCount = selectedBlock.content.split("\n").length;

			if (!(await hasClipboardTool(pi))) {
				await showInEditor(
					ctx,
					selectedBlock,
					"No clipboard tool found (please install one). Showing code for manual copy.",
				);
				return;
			}

			try {
				await copyToClipboard(selectedBlock.content);
				ctx.ui.notify(`Copied ${lang} code block (${lineCount} lines)`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				await showInEditor(ctx, selectedBlock, `Clipboard copy failed (${message}). Showing code for manual copy.`);
			}
		},
	});
}
