import type { App } from "obsidian";
import { CodeBlockContext } from "./selectionStore";
import type { DocumentContextItem } from "./documentContext/types";
import { appendAILog } from "./memory/aiLogger";

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

// 将用户主动选中的代码块上下文整理成一段可直接注入 system prompt 的文本。
// 输出格式带有片段编号、来源文件、语言和 fenced code block，便于模型识别结构。
function formatActiveContexts(contexts: CodeBlockContext[]): string {
	if (contexts.length === 0) {
		return "";
	}

	return "以下是用户选中的活动上下文：\n" + contexts.map((ctx, index) => {
		return `[片段 ${index + 1}]\n文件: ${ctx.sourcePath}\n语言: ${ctx.language}\n\`\`\`${ctx.language}\n${ctx.content}\n\`\`\``;
	}).join("\n\n");
}

// 将文档上下文整理成可注入的纯文本块。
// 与活动上下文不同，这里更强调“文件路径 + 标题路径 + 内容正文”，
// 方便模型知道这段内容来自哪篇文档的哪个章节。
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

// 如果模板里显式声明了占位符，就做替换；
// 否则在模板末尾追加对应段落。
// 这个函数更偏“宽松兼容”，适合用于历史 prompt 模板向新占位符格式过渡。
function injectPromptSection(template: string, placeholder: string, value: string): string {
	if (template.includes(placeholder)) {
		return template.replace(placeholder, value);
	}

	if (!value) {
		return template;
	}

	return `${template}\n\n${value}`;
}

// 用 split/join 替换全部同名占位符，而不是只替换第一个。
// 这样即使用户在模板里写了多个相同占位符，也能一次性全部展开。
function replacePromptPlaceholder(template: string, placeholder: string, value: string): string {
	return template.split(placeholder).join(value);
}

// 统一处理上下文注入逻辑。
// 这里要解决两个问题：
// 1. 新模板可能使用 {{CONTEXT}} / {{ACTIVE_CONTEXT}} / {{DOCUMENT_CONTEXT}} 三种占位符中的任意一种；
// 2. 老模板可能完全没有占位符，此时仍要把上下文追加进去，但不能重复追加。
//
// 当前策略：
// - 如果模板显式包含某种占位符，就只做替换；
// - 如果模板不包含占位符，就在末尾追加尚未被 {{CONTEXT}} 覆盖的上下文；
// - 如果模板里用了 {{CONTEXT}}，就不再额外追加 active/document context，避免重复注入。
function injectContextsIntoPrompt(
	template: string,
	activeContextStr: string,
	documentContextStr: string,
	contextStr: string
): string {
	const hasContextPlaceholder = template.includes("{{CONTEXT}}");
	const hasActiveContextPlaceholder = template.includes("{{ACTIVE_CONTEXT}}");
	const hasDocumentContextPlaceholder = template.includes("{{DOCUMENT_CONTEXT}}");

	let prompt = template;

	if (hasContextPlaceholder) {
		prompt = replacePromptPlaceholder(prompt, "{{CONTEXT}}", contextStr);
	} else {
		prompt = replacePromptPlaceholder(prompt, "{{CONTEXT}}", "");
	}

	if (hasActiveContextPlaceholder) {
		prompt = replacePromptPlaceholder(prompt, "{{ACTIVE_CONTEXT}}", activeContextStr);
	} else {
		prompt = replacePromptPlaceholder(prompt, "{{ACTIVE_CONTEXT}}", "");
	}

	if (hasDocumentContextPlaceholder) {
		prompt = replacePromptPlaceholder(prompt, "{{DOCUMENT_CONTEXT}}", documentContextStr);
	} else {
		prompt = replacePromptPlaceholder(prompt, "{{DOCUMENT_CONTEXT}}", "");
	}

	if (!hasContextPlaceholder && !hasActiveContextPlaceholder && activeContextStr) {
		prompt = injectPromptSection(prompt, "{{ACTIVE_CONTEXT}}", activeContextStr);
	}

	if (!hasContextPlaceholder && !hasDocumentContextPlaceholder && documentContextStr) {
		prompt = injectPromptSection(prompt, "{{DOCUMENT_CONTEXT}}", documentContextStr);
	}

	return prompt;
}

// 发起一次面向 DashScope/OpenAI-compatible 接口的流式 AI 请求。
// 这是当前插件的 AI 出口：
// - 负责把活动上下文、文档上下文、记忆上下文和提示词合成为最终 messages；
// - 负责解析服务端返回的 SSE 数据流；
// - 通过 callbacks 将“思考过程”和“回答正文”持续回传给上层 UI；
// - 无论成功还是失败，都会把请求与响应写入日志，便于排障。
export async function streamDashScope(
	app: App,
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

	// 统一兜底，避免调用方传空字符串时把请求打到无效地址或空模型。
	const resolvedBaseUrl = baseUrl?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
	const resolvedModel = model?.trim() || 'deepseek-v4-flash';
	// requestMessages 会被直接发送给模型，同时也会原样写入日志文件。
	const requestMessages: AIMessage[] = [];
	// 这两个累积变量既用于最终日志落盘，也能帮助定位流式响应中断在什么阶段。
	let accumulatedReasoning = "";
	let accumulatedContent = "";

	try {
		// 先分别格式化两类上下文，再组合成一个总上下文字符串。
		// 这样做的好处是：
		// - prompt 模板若只想用活动上下文，可用 {{ACTIVE_CONTEXT}}
		// - 只想用文档上下文，可用 {{DOCUMENT_CONTEXT}}
		// - 想一次性注入全部上下文，可用 {{CONTEXT}}
		const activeContextStr = formatActiveContexts(activeContexts);
		const documentContextStr = formatDocumentContexts(documentContexts);
		const contextStr = [activeContextStr, documentContextStr].filter(Boolean).join("\n\n");

		// 如果调用方没有传自定义系统提示词，则使用一个最小默认模板。
		let systemPrompt = systemPromptTemplate || "你是一个强大的 AI 助手。\n\n{{CONTEXT}}\n\n请回答用户的问题。要求：\n1. 返回的内容为 Markdown 格式\n2. 最大标题级别为3 (###)";
		
		// soulPrompt 用来补充回答风格，例如“用幽默语言回答”。
		// 它不是独立 message，而是直接拼到 system prompt 末尾。
		if (soulPrompt) {
			systemPrompt += "\n\n" + soulPrompt;
		}
		
		// 记忆上下文支持两种方式：
		// - 推荐：模板里显式放置 {{MEMORY}}，由这里替换；
		// - 兼容：模板未声明 {{MEMORY}} 时，直接追加到 system prompt 末尾。
		// 如果本轮没有记忆上下文，则主动清除模板中的 {{MEMORY}}，避免占位符残留给模型看见。
		if (memoryContext) {
			if (systemPrompt.includes("{{MEMORY}}")) {
				systemPrompt = systemPrompt.replace("{{MEMORY}}", memoryContext);
			} else {
				systemPrompt += "\n\n" + memoryContext;
			}
		} else {
			systemPrompt = systemPrompt.replace("{{MEMORY}}", "");
		}

		// 在这里完成上下文注入，兼容新旧模板，并避免同一段上下文被重复拼接。
		systemPrompt = injectContextsIntoPrompt(systemPrompt, activeContextStr, documentContextStr, contextStr);

		// 最终消息顺序固定为：
		// 1. system prompt
		// 2. 历史对话（如果记忆系统开启）
		// 3. 当前用户问题
		// 这样模型能先看到全局规则，再看到上下文历史，最后处理本轮问题。
		requestMessages.push(
			{ role: 'system', content: systemPrompt },
			...(conversationHistory ?? []),
			{ role: 'user', content: query }
		);

		// 使用浏览器原生 fetch 发起流式请求。
		// 当前接口遵循 OpenAI-compatible 格式，因此 body 中使用 messages / stream / model 等字段。
		const response = await window.fetch(resolvedBaseUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: resolvedModel,
				messages: requestMessages,
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

		// 进入标准 SSE 读取流程：
		// - reader 按字节流读取响应体
		// - decoder 把 Uint8Array 解码成 UTF-8 文本
		// - buffer 负责缓存未完整接收的一行，避免 JSON 被拆半时解析失败
		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			// 追加本次收到的数据，并按换行拆分成若干 SSE 事件行。
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			// 最后一项可能是不完整的一行，先缓存到下一轮继续拼接。
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmedLine = line.trim();
				// SSE 中只处理 data: 开头的行，其它空行或控制行直接跳过。
				if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

				const dataStr = trimmedLine.slice("data: ".length);
				// OpenAI-compatible 流的结束标记。
				if (dataStr === "[DONE]") continue;

				try {
					const data = JSON.parse(dataStr);
					if (data.choices && data.choices.length > 0) {
						const delta = data.choices[0].delta;
						
						// 某些模型会把“思考过程”放在 reasoning_content 字段里；
						// 上层可以按需决定是否显示这部分内容。
						if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
							accumulatedReasoning += delta.reasoning_content;
							callbacks.onReasoning(delta.reasoning_content);
						}

						// 正常回答正文通常在 content 字段里，直接回调给编辑器流式渲染。
						if (delta.content !== undefined && delta.content !== null) {
							accumulatedContent += delta.content;
							callbacks.onContent(delta.content);
						}
					}
				} catch (e) {
					// 单条分片解析失败时不中断整次请求，避免某个脏分片导致整段回答丢失。
					console.error("解析流式 JSON 数据失败", e, dataStr);
				}
			}
		}

		// 成功结束后，把请求参数和完整响应落日志，方便对照线上问题。
		await appendAILog(app, {
			source: "streamDashScope",
			request: {
				baseUrl: resolvedBaseUrl,
				model: resolvedModel,
				enableThinking,
				activeContextCount: activeContexts.length,
				documentContextCount: documentContexts.length,
				messages: requestMessages,
			},
			response: {
				reasoning: accumulatedReasoning,
				content: accumulatedContent,
			},
		});

		// 只有在完整完成后才通知上层 onComplete，避免上层过早收尾。
		callbacks.onComplete();

	} catch (error) {
		// 失败时同样记录已累计到的 reasoning/content，便于判断是请求失败、网络中断还是解析中断。
		await appendAILog(app, {
			source: "streamDashScope",
			request: {
				baseUrl: resolvedBaseUrl,
				model: resolvedModel,
				enableThinking,
				activeContextCount: activeContexts.length,
				documentContextCount: documentContexts.length,
				messages: requestMessages,
			},
			response: {
				reasoning: accumulatedReasoning,
				content: accumulatedContent,
			},
			error: error instanceof Error ? error.stack ?? error.message : String(error),
		});
		// 统一转成 Error 对象后回传给调用方，由 UI 决定如何提示用户。
		callbacks.onError(error instanceof Error ? error : new Error(String(error)));
	}
}