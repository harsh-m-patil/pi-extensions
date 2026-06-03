import {
	buildSessionContext,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { estimateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextCategoryId = "systemPrompt" | "toolDefinitions" | "rules" | "skills" | "conversation";

export interface ContextCategory {
	id: ContextCategoryId;
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	categories: ContextCategory[];
	totalTokens: number;
	contextWindow: number;
	percent: number | null;
	/** Total matches provider usage from the last assistant response. */
	usesProviderTotal: boolean;
}

const CATEGORY_LABELS: Record<ContextCategoryId, string> = {
	systemPrompt: "System prompt",
	toolDefinitions: "Tool definitions",
	rules: "Rules",
	skills: "Skills (index in system prompt)",
	conversation: "Conversation",
};

/** Pi only exposes estimateTokens on AgentMessage — wrap plain text the same way. */
const estimateTextTokens = (text: string): number => {
	if (text.length === 0) {
		return 0;
	}
	const message: AgentMessage = {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
	return estimateTokens(message);
};

const RULES_SECTION_RE = /\n\n<project_context>[\s\S]*?<\/project_context>\n/;

const SKILLS_SECTION_RE =
	/\n\nThe following skills provide[\s\S]*?<\/available_skills>|<available_skills>[\s\S]*?<\/available_skills>/;

const extractSection = (prompt: string, pattern: RegExp): string => prompt.match(pattern)?.[0] ?? "";

const splitSystemPrompt = (
	fullPrompt: string,
): { systemPrompt: string; rules: string; skills: string } => {
	const rules = extractSection(fullPrompt, RULES_SECTION_RE);
	const skills = extractSection(fullPrompt, SKILLS_SECTION_RE);

	let systemPrompt = fullPrompt;
	if (rules.length > 0) {
		systemPrompt = systemPrompt.replace(rules, "");
	}
	if (skills.length > 0) {
		systemPrompt = systemPrompt.replace(skills, "");
	}

	return { systemPrompt, rules, skills };
};

const estimateToolsTokens = (tools: ToolInfo[]): number => {
	if (tools.length === 0) {
		return 0;
	}
	const payload = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	}));
	return estimateTextTokens(JSON.stringify(payload));
};

const estimateConversationTokens = (messages: AgentMessage[]): number => {
	let total = 0;
	for (const message of messages) {
		total += estimateTokens(message);
	}
	return total;
};

const scalePartsToTotal = (parts: Record<ContextCategoryId, number>, total: number): Record<ContextCategoryId, number> => {
	const sum = Object.values(parts).reduce((a, b) => a + b, 0);
	if (sum <= 0) {
		return parts;
	}
	const scale = total / sum;
	const scaled = { ...parts };
	for (const key of Object.keys(scaled) as ContextCategoryId[]) {
		scaled[key] = Math.round(scaled[key] * scale);
	}
	const roundedSum = Object.values(scaled).reduce((a, b) => a + b, 0);
	const drift = total - roundedSum;
	if (drift !== 0) {
		const largest = (Object.keys(scaled) as ContextCategoryId[]).reduce((best, id) =>
			scaled[id] > scaled[best] ? id : best,
		);
		scaled[largest] += drift;
	}
	return scaled;
};

export const formatTokenCount = (tokens: number): string => {
	if (tokens < 1000) {
		return `${tokens}`;
	}
	if (tokens < 100_000) {
		return `${(tokens / 1000).toFixed(1)}K`;
	}
	return `${Math.round(tokens / 1000)}K`;
};

export const computeContextBreakdown = (input: {
	getBranch: () => SessionEntry[];
	getAllTools: () => ToolInfo[];
	getContextUsage: () => { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	getSystemPrompt: () => string;
}): ContextBreakdown => {
	const { messages } = buildSessionContext(input.getBranch());
	const usage = input.getContextUsage();
	const contextWindow = usage?.contextWindow ?? 0;
	const contextEstimate = estimateContextTokens(messages);

	const { systemPrompt, rules, skills } = splitSystemPrompt(input.getSystemPrompt());

	const rawParts: Record<ContextCategoryId, number> = {
		systemPrompt: estimateTextTokens(systemPrompt),
		toolDefinitions: estimateToolsTokens(input.getAllTools()),
		rules: estimateTextTokens(rules),
		skills: estimateTextTokens(skills),
		conversation: estimateConversationTokens(messages),
	};

	const providerTotal = usage?.tokens ?? null;
	const usesProviderTotal = providerTotal !== null;

	const totalTokens = providerTotal ?? contextEstimate.tokens;
	const parts = usesProviderTotal ? scalePartsToTotal(rawParts, providerTotal) : rawParts;

	const percent =
		usage?.percent ?? (contextWindow > 0 ? (totalTokens / contextWindow) * 100 : null);

	const categories: ContextCategory[] = (
		[
			["systemPrompt", parts.systemPrompt],
			["toolDefinitions", parts.toolDefinitions],
			["rules", parts.rules],
			["skills", parts.skills],
			["conversation", parts.conversation],
		] as const
	)
		.filter(([, tokens]) => tokens > 0)
		.map(([id, tokens]) => ({
			id,
			label: CATEGORY_LABELS[id],
			tokens,
		}));

	return {
		categories,
		totalTokens,
		contextWindow,
		percent,
		usesProviderTotal,
	};
};

const formatEstimateNote = (breakdown: ContextBreakdown): string => {
	if (breakdown.usesProviderTotal) {
		return "Note: Total from provider usage (footer). Category breakdown is estimated and scaled to that total.";
	}
	return "Note: All figures estimated — no provider usage yet (send a message or wait for a reply after compaction).";
};

export const formatBreakdownText = (breakdown: ContextBreakdown): string => {
	const pct =
		breakdown.percent !== null
			? Math.round(breakdown.percent)
			: Math.round((breakdown.totalTokens / breakdown.contextWindow) * 100);

	const header = `${pct}% full · ~${formatTokenCount(breakdown.totalTokens)} / ${formatTokenCount(breakdown.contextWindow)} tokens`;

	const rows = breakdown.categories.map(
		(category) => `  ${category.label}: ${formatTokenCount(category.tokens)}`,
	);

	return [header, ...rows, "", formatEstimateNote(breakdown)].join("\n");
};
