import {
	buildSessionContext,
	convertToLlm,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import type { SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { estimateContextTokens, type AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextCategoryId =
	| "systemPrompt"
	| "toolDefinitions"
	| "rules"
	| "skills"
	| "userMessages"
	| "assistantMessages"
	| "toolCalls"
	| "toolResults";

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
	userMessages: "User messages",
	assistantMessages: "Assistant messages",
	toolCalls: "Tool calls",
	toolResults: "Tool results",
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

const splitTotalByWeights = (total: number, weights: number[]): number[] => {
	const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
	if (weightSum <= 0) {
		return weights.map((_weight, index) => (index === 0 ? total : 0));
	}

	const scaled = weights.map((weight) => Math.round((total * weight) / weightSum));
	const roundedSum = scaled.reduce((sum, value) => sum + value, 0);
	const drift = total - roundedSum;
	if (drift !== 0) {
		let largestIndex = 0;
		for (let i = 1; i < scaled.length; i++) {
			if (scaled[i] > scaled[largestIndex]) {
				largestIndex = i;
			}
		}
		scaled[largestIndex] += drift;
	}
	return scaled;
};

const estimateAssistantTextTokens = (message: Extract<ReturnType<typeof convertToLlm>[number], { role: "assistant" }>): number => {
	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += estimateTextTokens(block.text);
		} else if (block.type === "thinking") {
			total += estimateTextTokens(block.thinking);
		}
	}
	return total;
};

const estimateAssistantToolCallTokens = (
	message: Extract<ReturnType<typeof convertToLlm>[number], { role: "assistant" }>,
): number => {
	const toolCalls = message.content.filter((block) => block.type === "toolCall");
	if (toolCalls.length === 0) {
		return 0;
	}
	return estimateTextTokens(JSON.stringify(toolCalls));
};

const estimateConversationBreakdown = (messages: AgentMessage[]): Record<
	Extract<ContextCategoryId, "userMessages" | "assistantMessages" | "toolCalls" | "toolResults">,
	number
> => {
	const breakdown = {
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
	};

	for (const message of convertToLlm(messages)) {
		if (message.role === "user") {
			breakdown.userMessages += estimateTokens(message);
			continue;
		}

		if (message.role === "toolResult") {
			breakdown.toolResults += estimateTokens(message);
			continue;
		}

		const totalTokens = estimateTokens(message);
		const assistantTextTokens = estimateAssistantTextTokens(message);
		const toolCallTokens = estimateAssistantToolCallTokens(message);
		const [assistantTokens, splitToolCallTokens] = splitTotalByWeights(totalTokens, [
			assistantTextTokens,
			toolCallTokens,
		]);

		breakdown.assistantMessages += assistantTokens;
		breakdown.toolCalls += splitToolCallTokens;
	}

	return breakdown;
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
	const conversationBreakdown = estimateConversationBreakdown(messages);

	const rawParts: Record<ContextCategoryId, number> = {
		systemPrompt: estimateTextTokens(systemPrompt),
		toolDefinitions: estimateToolsTokens(input.getAllTools()),
		rules: estimateTextTokens(rules),
		skills: estimateTextTokens(skills),
		userMessages: conversationBreakdown.userMessages,
		assistantMessages: conversationBreakdown.assistantMessages,
		toolCalls: conversationBreakdown.toolCalls,
		toolResults: conversationBreakdown.toolResults,
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
			["userMessages", parts.userMessages],
			["assistantMessages", parts.assistantMessages],
			["toolCalls", parts.toolCalls],
			["toolResults", parts.toolResults],
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
