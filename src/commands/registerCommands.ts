import { StateEffect, Annotation } from "@codemirror/state";
import { App, Editor, MarkdownView, Notice } from "obsidian";
import { streamDashScope } from "../ai";
import { AI_TASK_VIEW_TYPE, AITaskView } from "../aiTaskView";
import { mergeDocumentContexts, resolveDocumentContextsFromLine, stripDocumentMarkersFromText } from "../documentContext/navigation";
import { DocumentContextStore } from "../documentContext/store";
import { MemoryManager } from "../memory/memoryManager";
import { CodeBlockSelectionStore, createCodeBlockContext } from "../selectionStore";
import { MyPluginSettings } from "../settings";
import { aiStreamAnnotation } from "../editorCodeBlockCollapser";

interface CommandDefinition {
	id: string;
	name: string;
	hotkeys?: Array<{ modifiers: string[]; key: string }>;
	callback?: () => void | Promise<void>;
	editorCallback?: (editor: Editor, view: MarkdownView) => void | Promise<void>;
	checkCallback?: (checking: boolean) => boolean | void;
}

export interface CommandHost {
	app: App;
	manifest: { id: string };
	settings: MyPluginSettings;
	selectionStore: CodeBlockSelectionStore;
	documentContextStore: DocumentContextStore;
	memoryManager: MemoryManager;
	activateView: () => Promise<void>;
	openSampleModal: () => void;
	saveSettings: () => Promise<void>;
	addCommand: (command: CommandDefinition) => unknown;
}

export function registerPluginCommands(plugin: CommandHost): void {
	plugin.addCommand({
		id: "open-ai-task-view",
		name: "Open AI Task View",
		hotkeys: [{ modifiers: ["Mod", "Shift"], key: "L" }],
		callback: () => {
			void plugin.activateView();
		},
	});

	plugin.addCommand({
		id: "toggle-memory",
		name: "Toggle memory (on/off)",
		hotkeys: [{ modifiers: ["Mod"], key: "m" }],
		callback: async () => {
			const isOn = plugin.memoryManager.toggle();
			plugin.settings.memoryActive = isOn;
			await plugin.saveSettings();
			new Notice(isOn ? "✓ 记忆已开启" : "✗ 记忆已关闭");
		},
	});

	plugin.addCommand({
		id: "toggle-thinking",
		name: "Toggle thinking (on/off)",
		hotkeys: [{ modifiers: ["Mod", "Shift"], key: "m" }],
		callback: async () => {
			plugin.settings.enableThinking = !plugin.settings.enableThinking;
			await plugin.saveSettings();

			plugin.app.workspace.getLeavesOfType(AI_TASK_VIEW_TYPE).forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof AITaskView) {
					view.updateThinkingToggleBtn();
				}
			});

			new Notice(plugin.settings.enableThinking ? "✓ Thinking 模式已开启" : "✗ Thinking 模式已关闭");
		},
	});

	plugin.addCommand({
		id: "open-modal-simple",
		name: "Open modal (simple)",
		callback: () => {
			plugin.openSampleModal();
		},
	});

	plugin.addCommand({
		id: "replace-selected",
		name: "Replace selected content",
		editorCallback: (editor: Editor) => {
			editor.replaceSelection("Sample editor command");
		},
	});

	plugin.addCommand({
		id: "add-selected-text-to-context",
		name: "Add selected text to AI context",
		hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
		editorCallback: async (editor: Editor, view: MarkdownView) => {
			const selection = editor.getSelection();

			if (!selection) {
				try {
					const clipboardText = await navigator.clipboard.readText();
					if (!clipboardText) {
						new Notice("当前没有选中内容，且剪切板为空");
						return;
					}

					const context = createCodeBlockContext({
						sourcePath: "Clipboard",
						startLine: 0,
						endLine: clipboardText.split("\n").length - 1,
						language: "text",
						content: clipboardText,
						mode: "live-preview",
					});

					const isAdded = plugin.selectionStore.toggle(context);
					new Notice(
						isAdded
							? `剪切板内容已加入 AI 上下文（当前共 ${plugin.selectionStore.getSelectedContexts().length} 项）`
							: "已从上下文中移除。"
					);
				} catch (error) {
					new Notice("读取剪切板失败：" + error);
				}
				return;
			}

			const from = editor.getCursor("from");
			const to = editor.getCursor("to");
			const context = createCodeBlockContext({
				sourcePath: view.file?.path || "unknown",
				startLine: from.line,
				endLine: to.line,
				language: "text",
				content: selection,
				mode: "live-preview",
			});

			const isAdded = plugin.selectionStore.toggle(context);
			new Notice(
				isAdded
					? `已加入 AI 上下文队列（当前共 ${plugin.selectionStore.getSelectedContexts().length} 项）`
					: `已从 AI 上下文队列移除（当前共 ${plugin.selectionStore.getSelectedContexts().length} 项）`
			);
		},
	});

	plugin.addCommand({
		id: "copy-selected-code-block-contexts",
		name: "Copy selected code block contexts",
		callback: async () => {
			const selectedContexts = plugin.selectionStore.getSelectedContexts();
			if (selectedContexts.length === 0) {
				new Notice("暂无已选中的代码块");
				return;
			}

			const formattedContexts = selectedContexts
				.map((context, index) => {
					const lineText =
						context.endLine > context.startLine
							? `${context.startLine + 1}-${context.endLine + 1}`
							: `${context.startLine + 1}`;

					return [
						`[Code Block ${index + 1}]`,
						`File: ${context.sourcePath || "unknown"}`,
						`Lines: ${lineText}`,
						`Language: ${context.language || "code"}`,
						context.content,
					].join("\n");
				})
				.join("\n\n---\n\n");

			await navigator.clipboard.writeText(formattedContexts);
			new Notice(`已复制 ${selectedContexts.length} 个代码块上下文`);
		},
	});

	plugin.addCommand({
		id: "insert-ai-question-markers",
		name: "Insert AI Question Markers (////)",
		hotkeys: [{ modifiers: ["Mod", "Shift"], key: "/" }],
		editorCallback: (editor: Editor) => {
			const cursor = editor.getCursor();
			editor.replaceRange("////", cursor);
			editor.setCursor({ line: cursor.line, ch: cursor.ch + 2 });

			setTimeout(() => {
				const cm = (editor as any).cm;
				if (cm) {
					const pos = cm.state.selection.main.head;
					cm.dispatch({
						changes: { from: pos, insert: " " },
						selection: { anchor: pos + 1, head: pos + 1 },
						userEvent: "input.type",
					});
					cm.dispatch({
						changes: { from: pos, to: pos + 1 },
						selection: { anchor: pos, head: pos },
						userEvent: "delete.backward",
					});
				}
			}, 50);
		},
	});

	plugin.addCommand({
		id: "clear-selected-code-blocks",
		name: "Clear all selected code blocks",
		hotkeys: [{ modifiers: ["Mod"], key: "'" }],
		callback: () => {
			plugin.selectionStore.clear();
			plugin.documentContextStore.clear();

			plugin.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
				const view = leaf.view as MarkdownView;
				if (view.previewMode) {
					view.previewMode.rerender(true);
				}
				if (view.editor) {
					const cm = (view.editor as any).cm;
					if (cm) {
						const forceUpdate = StateEffect.define<null>();
						cm.dispatch({ effects: forceUpdate.of(null) });
					}
				}
			});

			new Notice("✓ 已取消并清空所有选中的上下文！");
		},
	});

	plugin.addCommand({
		id: "ai-completion",
		name: "AI Completion (DashScope)",
		hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
		editorCallback: async (editor: Editor, view: MarkdownView) => {
			const tStart = Date.now();
			let tLast = tStart;
			const logTime = (step: string) => {
				const now = Date.now();
				console.log(`[AI-Perf] ${step}: ${now - tLast}ms (Total: ${now - tStart}ms)`);
				tLast = now;
			};

			// 从当前行提取 //问题// 形式的提问内容。
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);
			const match = line.match(/\/\/(.*?)\/\/\s*$/);

			if (!match || !match[1]) {
				new Notice("未在游标所在行找到以 '//问题//' 格式结尾的问题。");
				return;
			}

			if (!view.file) {
				new Notice("当前视图没有关联的 Markdown 文件。");
				return;
			}
			logTime("Regex match completed");

			// 收集两类上下文：显式选中的活动上下文，以及当前行内 @doc 解析出的文档上下文。
			const question = match[1].trim();
			const activeContexts = plugin.selectionStore.getSelectedContexts();
			const inlineDocumentContexts = await resolveDocumentContextsFromLine(
				plugin.app,
				view.file,
				line,
				cursor.line,
				plugin.documentContextStore.getLastConversationSnapshot()
			);
			let documentContexts = mergeDocumentContexts(
				plugin.documentContextStore.getSelectedItems(),
				inlineDocumentContexts
			);
			logTime("resolveDocumentContextsFromLine completed");

			const hasExplicitDocContexts = documentContexts.length > 0;
			const shouldPersistDocumentContexts = hasExplicitDocContexts;

			// 将本次明确使用的文档上下文持久化，便于下次继续沿用或快捷跳转。
			if (shouldPersistDocumentContexts && documentContexts.length > 0) {
				plugin.documentContextStore.setSelectedItems(documentContexts);
				plugin.documentContextStore.setLastConversationSnapshot(documentContexts);
				plugin.settings.lastDocumentContextSnapshot = documentContexts.map((item) => ({ ...item }));
				await plugin.saveSettings();
			}
			logTime("plugin.saveSettings completed");

			// 将原问题行替换成 Markdown 标题，作为本次 AI 问答的标题。
			const normalizedQuestion = stripDocumentMarkersFromText(line.substring(0, match.index) + match[1]);
			const headingLine = `## ${normalizedQuestion}`;
			editor.setLine(cursor.line, headingLine);
			const newLineLength = headingLine.length;

			// 为显式文档上下文生成 wiki-link，方便回答落盘后回溯来源。
			const wikiLinksText = hasExplicitDocContexts
				? documentContexts
						.map((item) => {
							const nameWithoutExt = item.fileName.replace(/\.md$/i, "");
							const heading =
								item.titlePath.length > 0
									? item.titlePath[item.titlePath.length - 1]
									: "";
							return heading ? `[[${nameWithoutExt}#${heading}]]` : `[[${nameWithoutExt}]]`;
						})
						.join("\n") + "\n"
				: "";
			const wikiLinkLineCount = hasExplicitDocContexts ? documentContexts.length : 0;

			const enableThinking = plugin.settings.enableThinking;

			// 构造回答前的元信息块，记录模型、提示词、记忆开关与 thinking 状态。
			const activeSystemPromptName = plugin.settings.savedSystemPrompts?.find(p => p.id === plugin.settings.activeSystemPromptId)?.name ?? '';
			const activeSoulPromptName = plugin.settings.savedSoulPrompts?.find(p => p.id === plugin.settings.activeSoulPromptId)?.name ?? '';
			const memoryStatus = plugin.memoryManager.isActive() ? 'ON' : 'OFF';
			const metaParts: string[] = [
				`>**Model** \`${plugin.settings.aiModel}\` `,
				activeSystemPromptName ? `>**System** \`${activeSystemPromptName}\`` : '',
				activeSoulPromptName ? `>**Soul** \`${activeSoulPromptName}\`` : '',
				`>**Memory** \`${memoryStatus}\``,
				`>**Thinking** \`${enableThinking ? 'ON' : 'OFF'}\``,
			].filter(Boolean) as string[];
			const metaBlock = `${metaParts.join('\n')}\n`;

			// 无论是否开启 thinking，都先把 meta 块（包含引用的 Wiki 链接和模型配置参数）写入到回答前的位置。
			const prefixText = wikiLinkLineCount > 0
				? `\n---\n${wikiLinksText}\n${metaBlock}\n`
				: `\n---\n${metaBlock}\n`;
			
			// 开启 thinking 时在 meta 块之后预留“思考过程”代码块，否则直接进入答案区。
			if (enableThinking) {
				editor.replaceRange(`${prefixText}\`\`\`text\n思考过程...\n`, {
					line: cursor.line,
					ch: newLineLength,
				});
			} else {
				editor.replaceRange(prefixText, {
					line: cursor.line,
					ch: newLineLength,
				});
			}

			// 预设光标向下偏移量以匹配初始插入内容
			// 若有 wikiLinksText -> wikiLinkLineCount + 1行
			// metaBlock -> 约 4-6 行不等，按 '\n' 的个数计算
			const metaLineCount = metaParts.length + 1;
			const prefixLineCount = 3 + (wikiLinkLineCount > 0 ? wikiLinkLineCount + 1 : 0) + metaLineCount;

			let currentLine = cursor.line + prefixLineCount + (enableThinking ? 1 : -1);
			let currentCh = 0;
			let isAnswering = !enableThinking;
			let accumulatedAnswer = "";
			let currentOffset = editor.posToOffset({ line: currentLine, ch: currentCh });

			// RAF 批量写入：把同一帧内所有到来的流式分片攒成一次 dispatch，
			// 将每秒 100+ 次 dispatch 压缩到 ≤60 次，让浏览器有时间在帧间渲染。
			let pendingText = "";
			let rafId: number | null = null;

			const doDispatch = (text: string) => {
				const cm = (editor as any).cm;
				if (cm) {
					cm.dispatch({
						changes: { from: currentOffset, insert: text },
						scrollIntoView: false,
						annotations: aiStreamAnnotation.of(true),
					});
					currentOffset += text.length;
				} else {
					editor.replaceRange(text, { line: currentLine, ch: currentCh });
				}
			};

			const flushPending = () => {
				rafId = null;
				if (!pendingText) return;
				const text = pendingText;
				pendingText = "";
				doDispatch(text);
			};

			// 统一的流式写入函数，兼容 CodeMirror 和普通 editor 接口。
			// cm 路径：将 text 追加到帧缓冲，由 requestAnimationFrame 统一刷写；
			// 非 cm 路径（极少触发）：仍立即写入。
			const insertStreamChunk = (text: string) => {
				const cm = (editor as any).cm;
				if (cm) {
					pendingText += text;
					if (rafId === null) {
						rafId = requestAnimationFrame(flushPending);
					}
				} else {
					editor.replaceRange(text, { line: currentLine, ch: currentCh });
				}
			};

			// 流式结束后把光标定位到最终输出末尾。
			// 先取消挂起的 RAF 并立即将剩余文本刷写入编辑器，再定位光标。
			const setStreamCursor = () => {
				if (rafId !== null) {
					cancelAnimationFrame(rafId);
				}
				flushPending();
				const cm = (editor as any).cm;
				if (cm) {
					cm.dispatch({
						selection: { anchor: currentOffset, head: currentOffset },
						scrollIntoView: false,
					});
				} else {
					editor.setCursor({ line: currentLine, ch: currentCh });
				}
			};

			let firstTokenReceived = false;
			let firstContentReceived = false;
			logTime("Pre-flight sync and UI update completed, calling streamDashScope...");

			// 发起 AI 流式请求，并把 reasoning/content 分片实时写回编辑器。
			await streamDashScope(
				plugin.app,
				question,
				activeContexts,
				documentContexts,
				plugin.settings.dashScopeApiKey,
				enableThinking,
				{
					onReasoning: (chunk) => {
						if (!firstTokenReceived) {
							firstTokenReceived = true;
							logTime("[Reasoning] First reasoning token received");
						}
						// thinking 模式下，先把模型的思考内容写进代码块。
						if (!enableThinking) {
							return;
						}

						insertStreamChunk(chunk);
						const lines = chunk.split("\n");
						if (lines.length > 1) {
							currentLine += lines.length - 1;
							const lastLine = lines[lines.length - 1];
							currentCh = lastLine ? lastLine.length : 0;
						} else {
							currentCh += chunk.length;
						}
					},
					onContent: (chunk) => {
						if (!firstTokenReceived) {
							firstTokenReceived = true;
							logTime("[Content] First content token received (no reasoning phase)");
						}
						if (!firstContentReceived) {
							firstContentReceived = true;
							logTime("[Content] First content token received");
						}
						// 收集最终回答正文，并在首个正文分片到来时关闭思考区、切换到答案区。
						accumulatedAnswer += chunk;

						if (!isAnswering && enableThinking) {
							isAnswering = true;
							
							// 如果之前有输出过 reasoning（也就是当前光标位置已经在思考代码块里），我们需要闭合它；
							// 如果模型压根就没吐出任何 onReasoning 片段（如 qwen3.7-max），直接就来了 content（比如自己吐出了 "思考过程：... \n\n 正文..."），
							// 我们同样需要把最开始预留打开的 ```text 思考过程\n 给闭合掉。
							const thinkingTransition = `\n\`\`\`\n\n---\n\n`;
							insertStreamChunk(thinkingTransition);
							currentLine += 4;
							currentCh = 0;
						}

						insertStreamChunk(chunk);
						const lines = chunk.split("\n");
						if (lines.length > 1) {
							currentLine += lines.length - 1;
							const lastLine = lines[lines.length - 1];
							currentCh = lastLine ? lastLine.length : 0;
						} else {
							currentCh += chunk.length;
						}
					},
					onError: (error) => {
						new Notice("AI Request Errored: " + error.message);
					},
					onComplete: () => {
						// 请求结束后补齐分隔线，并把问答写入短期记忆和历史文件。
						insertStreamChunk("\n\n---\n");
						currentLine += 3;
						currentCh = 0;
						setStreamCursor();
						void plugin.memoryManager.recordTurn(question, accumulatedAnswer);
							void plugin.memoryManager.appendToHistory(question, accumulatedAnswer, wikiLinksText);
					},
				},
				plugin.settings.aiBaseUrl,
				plugin.settings.aiModel,
				plugin.settings.savedSystemPrompts?.find((prompt) => prompt.id === plugin.settings.activeSystemPromptId)?.content || plugin.settings.systemPromptTemplate,
				plugin.settings.savedSoulPrompts?.find((prompt) => prompt.id === plugin.settings.activeSoulPromptId)?.content || "",
				plugin.memoryManager.getConversationHistory(),
				plugin.memoryManager.buildMemoryContext()
			);
		},
	});

	plugin.addCommand({
		id: "clear-memory-session",
		name: "Clear memory session (short-term)",
		callback: () => {
			plugin.memoryManager.clearSession();
			new Notice("✓ 已清空当前会话短期记忆。");
		},
	});

	plugin.addCommand({
		id: "open-modal-complex",
		name: "Open modal (complex)",
		checkCallback: (checking: boolean) => {
			const markdownView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!markdownView) {
				return false;
			}

			if (!checking) {
				plugin.openSampleModal();
			}

			return true;
		},
	});
}