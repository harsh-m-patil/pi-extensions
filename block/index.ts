import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { resolve } from "path";

const HOME = homedir();

const blockedPathRules = [
	/(^|\/)\.ssh(\/|$)/,
	/(^|\/)\.aws(\/|$)/,
	/(^|\/)\.env$/,
	/(^|\/)\.env\.[^/]+$/,
	/(^|\/)\.envrc$/,
	/(^|\/)\.dev\.vars$/,
	/(^|\/)secrets(\/|$)/,
	/\.pem$/i,
	/\.key$/i,
	/\/\.local\/share\/opencode\/mcp-auth\.json$/i,
];

const blockedCommandRules = [
	/^\s*printenv(?:\s|$)/i,
	/^\s*env(?:\s|$)/i,
	/^\s*export(?:\s|$)/i,
	/^\s*gh\s+auth(?:\s|$)/i,

	/^\s*cat\b.*(?:^|[\s"'`])\.env(?:\.[^\s"'`]+)?(?:$|[\s"'`])/i,
	/^\s*cat\b.*(?:^|[\s"'`])\.envrc(?:$|[\s"'`])/i,
	/^\s*cat\b.*(?:^|[\s"'`])\.dev\.vars(?:$|[\s"'`])/i,
	/^\s*cat\b.*\.(?:pem|key)(?:$|[\s"'`])/i,
	/^\s*cat\b.*(?:\/\.aws\/|\/\.ssh\/)/i,
];

function normalizePath(rawPath: string, cwd: string) {
	const expanded = rawPath.startsWith("~/") ? resolve(HOME, rawPath.slice(2)) : rawPath;
	return resolve(cwd, expanded).replace(/\\/g, "/");
}

function blockedPath(rawPath: string, cwd: string) {
	const abs = normalizePath(rawPath, cwd);
	return blockedPathRules.some((r) => r.test(abs)) ? abs : null;
}

function blockedCommand(command: string) {
	return blockedCommandRules.some((r) => r.test(command));
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as any).command ?? "");
			if (blockedCommand(command)) {
				if (ctx.hasUI) ctx.ui.notify(`Blocked bash: ${command}`, "warning");
				return { block: true, reason: "Blocked by policy" };
			}
		}

		if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
			const rawPath = String((event.input as any).path ?? "");
			const hit = blockedPath(rawPath, ctx.cwd);
			if (hit) {
				if (ctx.hasUI) ctx.ui.notify(`Blocked ${event.toolName}: ${rawPath}`, "warning");
				return { block: true, reason: `Blocked path: ${hit}` };
			}
		}

		return undefined;
	});

	pi.on("user_bash", (event, ctx) => {
		if (!blockedCommand(event.command)) return undefined;

		if (ctx.hasUI) ctx.ui.notify(`Blocked user bash: ${event.command}`, "warning");
		return {
			result: {
				output: `Blocked by policy: ${event.command}`,
				exitCode: 126,
				cancelled: false,
				truncated: false,
			},
		};
	});
}
