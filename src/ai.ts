import { CodeBlockContext } from "./selectionStore";
import type { DocumentContextItem } from "./documentContext/types";

export interface AIStreamCallbacks {
	onReasoning: (chunk: string) => void;
	onContent: (chunk: string) => void;
	onError: (error: Error) => void;
	onComplete: () => void;
}

export interface AIMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

function formatActiveContexts(contexts: CodeBlockContext[]): string {
	if (contexts.length === 0) {
		return "";
	}

	return "以下是用户选中的活动上下文：\n" + contexts.map((ctx, index) => {
		return `[片段 ${index + 1}]\n文件: ${ctx.sourcePath}\n语言: ${ctx.language}\n\`\`\`${ctx.language}\n${ctx.content}\n\`\`\``;
	}).join("\n\n");
}

function formatDocumentContexts(items: DocumentContextItem[]): string {
	if (items.length === 0) {
		return "";
	}

	return "以下是用户选中的文档上下文：\n" + items.map((item, index) => {
		const titlePath = item.titlePath.length > 0 ? item.titlePath.join(" > ") : "当前文档";
		return [
			`[文档 ${index + 1}]`,
			`文件: ${item.filePath}`,
			`标题路径: ${titlePath}`,
			item.content,
		].join("\n");
	}).join("\n\n");
}

function injectPromptSection(template: string, placeholder: string, value: string): string {
	if (template.includes(placeholder)) {
		return template.replace(placeholder, value);
	}

	if (!value) {
		return template;
	}

	return `${template}\n\n${value}`;
}

export async function streamDashScope(
	query: string,
	activeContexts: CodeBlockContext[],
	documentContexts: DocumentContextItem[],
	apiKey: string,
	enableThinking: boolean,
	callbacks: AIStreamCallbacks,
	baseUrl?: string,
	model?: string,
	systemPromptTemplate?: string,
	soulPrompt?: string,
	conversationHistory?: AIMessage[],
	memoryContext?: string
) {
	if (!apiKey) {
		callbacks.onError(new Error("API Key 尚未配置，请在设置中配置。"));
		return;
	}

	const resolvedBaseUrl = baseUrl?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
	const resolvedModel = model?.trim() || 'deepseek-v4-flash';

	try {
		const activeContextStr = formatActiveContexts(activeContexts);
		const documentContextStr = formatDocumentContexts(documentContexts);
		const contextStr = [activeContextStr, documentContextStr].filter(Boolean).join("\n\n");

		let systemPrompt = systemPromptTemplate || "你是一个强大的 AI 助手。\n\n{{CONTEXT}}\n\n请回答用户的问题。要求：\n1. 返回的内容为 Markdown 格式\n2. 最大标题级别为3 (###)";
		
		if (soulPrompt) {
			systemPrompt += "\n\n" + soulPrompt;
		}
		
		// Inject memory context via {{MEMORY}} placeholder
		if (memoryContext) {
			if (systemPrompt.includes("{{MEMORY}}")) {
				systemPrompt = systemPrompt.replace("{{MEMORY}}", memoryContext);
			} else {
				systemPrompt += "\n\n" + memoryContext;
			}
		} else {
			systemPrompt = systemPrompt.replace("{{MEMORY}}", "");
		}

		systemPrompt = injectPromptSection(systemPrompt, "{{ACTIVE_CONTEXT}}", activeContextStr);
		systemPrompt = injectPromptSection(systemPrompt, "{{DOCUMENT_CONTEXT}}", documentContextStr);
		systemPrompt = injectPromptSection(systemPrompt, "{{CONTEXT}}", contextStr);

		const response = await window.fetch(resolvedBaseUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: resolvedModel,
				messages: [
					{ role: 'system', content: systemPrompt },
					...(conversationHistory ?? []),
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

				try {
					const data = JSON.parse(dataStr);
					if (data.choices && data.choices.length > 0) {
						const delta = data.choices[0].delta;
						
						if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
							callbacks.onReasoning(delta.reasoning_content);
						}

						if (delta.content !== undefined && delta.content !== null) {
							callbacks.onContent(delta.content);
						}
					}
				} catch (e) {
					console.error("解析流式 JSON 数据失败", e, dataStr);
				}
			}
		}

		callbacks.onComplete();

	} catch (error) {
		callbacks.onError(error instanceof Error ? error : new Error(String(error)));
	}
}