import { CodeBlockContext } from "./selectionStore";

export interface AIStreamCallbacks {
	onReasoning: (chunk: string) => void;
	onContent: (chunk: string) => void;
	onError: (error: Error) => void;
	onComplete: () => void;
}

export async function streamDashScope(
	query: string,
	contexts: CodeBlockContext[],
	apiKey: string,
	enableThinking: boolean,
	callbacks: AIStreamCallbacks,
	baseUrl?: string,
	model?: string,
	systemPromptTemplate?: string,
	soulPrompt?: string
) {
	if (!apiKey) {
		callbacks.onError(new Error("API Key 尚未配置，请在设置中配置。"));
		return;
	}

	const resolvedBaseUrl = baseUrl?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
	const resolvedModel = model?.trim() || 'deepseek-v4-flash';

	try {
		let contextStr = "";
		if (contexts.length > 0) {
			contextStr = "以下是用户选中的上下文内容：\n" + contexts.map((ctx, index) => {
				return `[片段 ${index + 1}]\n文件: ${ctx.sourcePath}\n语言: ${ctx.language}\n\`\`\`${ctx.language}\n${ctx.content}\n\`\`\``;
			}).join("\n\n");
		}

		let systemPrompt = systemPromptTemplate || "你是一个强大的 AI 助手。\n\n{{CONTEXT}}\n\n请回答用户的问题。要求：\n1. 返回的内容为 Markdown 格式\n2. 最大标题级别为3 (###)";
		
		if (soulPrompt) {
			systemPrompt += "\n\n" + soulPrompt;
		}
		
		if (contextStr) {
			if (systemPrompt.includes("{{CONTEXT}}")) {
				systemPrompt = systemPrompt.replace("{{CONTEXT}}", contextStr);
			} else {
				systemPrompt += "\n\n" + contextStr;
			}
		} else {
			systemPrompt = systemPrompt.replace("{{CONTEXT}}", "");
		}

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