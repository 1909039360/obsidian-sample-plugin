import type { CodeBlockContext } from "./selectionStore";
import type {
	LongTermMemoryEntry,
	MemoryRound,
	UserProfileEntry,
} from "./memoryTypes";

export interface AIStreamCallbacks {
	onReasoning: (chunk: string) => void;
	onContent: (chunk: string) => void;
	onError: (error: Error) => void;
	onComplete: () => void;
}

export interface MemoryCompressionResult {
	shortTermSummary: string;
	longTermMemories: Array<{ key: string; summary: string }>;
	userProfile: Array<{ key: string; summary: string; confidence: number }>;
}

interface MemoryCompressionRequest {
	apiKey: string;
	previousSummary: string;
	rounds: MemoryRound[];
	longTermMemories: LongTermMemoryEntry[];
	userProfile: UserProfileEntry[];
}

interface DashScopeStreamChunk {
	choices?: Array<{
		delta?: {
			reasoning_content?: string;
			content?: string;
		};
	}>;
}

interface DashScopeCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}

function parseJsonObject<T>(value: string): T | null {
	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function extractJsonPayload(content: string): string {
	const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i);
	if (fencedMatch?.[1]) {
		return fencedMatch[1].trim();
	}

	return content.trim();
}

function sanitizeCompressionResult(value: unknown): MemoryCompressionResult {
	const record =
		typeof value === "object" && value !== null
			? (value as Record<string, unknown>)
			: {};
	const shortTermSummary =
		typeof record.shortTermSummary === "string" ? record.shortTermSummary.trim() : "";
	const longTermMemories = Array.isArray(record.longTermMemories)
		? record.longTermMemories
			.map((entry) => {
				if (typeof entry !== "object" || entry === null) {
					return null;
				}

				const candidate = entry as Record<string, unknown>;
				const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
				const summary =
					typeof candidate.summary === "string" ? candidate.summary.trim() : "";
				if (!key || !summary) {
					return null;
				}

				return { key, summary };
			})
			.filter((entry): entry is { key: string; summary: string } => entry !== null)
		: [];
	const userProfile = Array.isArray(record.userProfile)
		? record.userProfile
			.map((entry) => {
				if (typeof entry !== "object" || entry === null) {
					return null;
				}

				const candidate = entry as Record<string, unknown>;
				const key = typeof candidate.key === "string" ? candidate.key.trim() : "";
				const summary =
					typeof candidate.summary === "string" ? candidate.summary.trim() : "";
				const confidence =
					typeof candidate.confidence === "number" ? candidate.confidence : -1;
				if (!key || !summary || confidence < 0) {
					return null;
				}

				return { key, summary, confidence };
			})
			.filter(
				(entry): entry is { key: string; summary: string; confidence: number } =>
					entry !== null,
			)
		: [];

	return {
		shortTermSummary,
		longTermMemories,
		userProfile,
	};
}

function buildMemorySection(memoryContext: string): string {
	if (!memoryContext.trim()) {
		return "";
	}

	return `\n\n以下是云端记忆系统提供的上下文，请在回答时优先复用这些信息，并保持与其一致：\n${memoryContext.trim()}`;
}

export async function streamDashScope(
	query: string,
	contexts: CodeBlockContext[],
	apiKey: string,
	enableThinking: boolean,
	callbacks: AIStreamCallbacks,
	memoryContext = "",
) {
	if (!apiKey) {
		callbacks.onError(new Error("DashScope API Key 尚未配置，请在设置中配置。"));
		return;
	}

	try {
		let systemPrompt = "你是一个强大的 AI 助手。";
		if (contexts.length > 0) {
			systemPrompt += "\n\n以下是用户选中的代码段：\n" + contexts.map((ctx, index) => {
				return `[代码段 ${index + 1}]\n文件: ${ctx.sourcePath}\n语言: ${ctx.language}\n\`\`\`${ctx.language}\n${ctx.content}\n\`\`\``;
			}).join("\n\n");
		}
		systemPrompt += buildMemorySection(memoryContext);
		systemPrompt += "\n\n请回答用户的问题。要求：\n1. 返回的内容为 Markdown 格式\n2. 最大标题级别为3 (###)\n";

		const response = await window.fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				// model: 'deepseek-v4-pro', // 也许后期变成可配置的
				model: 'deepseek-v4-flash', 
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: query }
				],
				enable_thinking: enableThinking,
				stream: true
			})
		});

		if (!response.ok) {
			throw new Error(`API 请求失败: ${response.status} ${response.statusText}`);
		}

		if (!response.body) {
			throw new Error("响应没有 body 数据不合法");
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmedLine = line.trim();
				if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

				const dataStr = trimmedLine.slice("data: ".length);
				if (dataStr === "[DONE]") continue;

				const data = parseJsonObject<DashScopeStreamChunk>(dataStr);
				const delta = data?.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}

				if (typeof delta.reasoning_content === "string") {
					callbacks.onReasoning(delta.reasoning_content);
				}

				if (typeof delta.content === "string") {
					callbacks.onContent(delta.content);
				}
			}
		}

		callbacks.onComplete();

	} catch (error) {
		callbacks.onError(error instanceof Error ? error : new Error(String(error)));
	}
}

export async function compressDashScopeMemory(
	request: MemoryCompressionRequest,
): Promise<MemoryCompressionResult> {
	const response = await window.fetch(
		"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${request.apiKey}`,
			},
			body: JSON.stringify({
				model: "deepseek-v4-flash",
				messages: [
					{
						role: "system",
						content: [
							"你负责维护一个 AI 助手的云端记忆系统。",
							"请基于输入内容输出严格 JSON，不要输出额外解释。",
							'JSON 结构必须为 {"shortTermSummary": string, "longTermMemories": [{"key": string, "summary": string}], "userProfile": [{"key": string, "summary": string, "confidence": number}]}。',
							"要求：",
							"1. shortTermSummary 用于承接被压缩的历史对话。",
							"2. longTermMemories 只保留跨任务仍有价值的稳定信息。",
							"3. userProfile 只记录稳定偏好，并为每项给出 0 到 1 的 confidence。",
							"4. 若没有对应内容，返回空数组或空字符串。",
						].join("\n"),
					},
					{
						role: "user",
						content: JSON.stringify(
							{
								previousSummary: request.previousSummary,
								roundsToCompress: request.rounds,
								existingLongTermMemories: request.longTermMemories,
								existingUserProfile: request.userProfile,
							},
							null,
							2,
						),
					},
				],
				stream: false,
			}),
		},
	);

	if (!response.ok) {
		throw new Error(`记忆压缩请求失败: ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as DashScopeCompletionResponse;
	const content = payload.choices?.[0]?.message?.content;
	if (!content) {
		throw new Error("记忆压缩响应为空");
	}

	const parsed = parseJsonObject<unknown>(extractJsonPayload(content));
	if (!parsed) {
		throw new Error("记忆压缩响应不是合法 JSON");
	}

	return sanitizeCompressionResult(parsed);
}
