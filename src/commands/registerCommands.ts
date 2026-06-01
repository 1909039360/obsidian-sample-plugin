import { StateEffect } from "@codemirror/state";
import { App, Editor, MarkdownView, Notice } from "obsidian";
import { streamDashScope } from "../ai";
import { AI_TASK_VIEW_TYPE, AITaskView } from "../aiTaskView";
import { mergeDocumentContexts, resolveDocumentContextsFromLine, stripDocumentMarkersFromText } from "../documentContext/navigation";
import { DocumentContextStore } from "../documentContext/store";
import { MemoryManager } from "../memory/memoryManager";
import { CodeBlockSelectionStore, createCodeBlockContext } from "../selectionStore";
import { MyPluginSettings } from "../settings";

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

			const hasExplicitDocContexts = documentContexts.length > 0;
			const shouldPersistDocumentContexts = hasExplicitDocContexts;

			// 将本次明确使用的文档上下文持久化，便于下次继续沿用或快捷跳转。
			if (shouldPersistDocumentContexts && documentContexts.length > 0) {
				plugin.documentContextStore.setSelectedItems(documentContexts);
				plugin.documentContextStore.setLastConversationSnapshot(documentContexts);
				plugin.settings.lastDocumentContextSnapshot = documentContexts.map((item) => ({ ...item }));
				await plugin.saveSettings();
			}

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

			const outputStart = { line: cursor.line, ch: newLineLength };
			let outputEnd = { ...outputStart };
			let reasoningText = "";
			let answerText = "";
			let streamCompleted = false;

			const getEndPosition = (start: { line: number; ch: number }, text: string) => {
				const lines = text.split("\n");
				const lastLine = lines[lines.length - 1] ?? "";
				return {
					line: start.line + lines.length - 1,
					ch: lines.length === 1 ? start.ch + lastLine.length : lastLine.length,
				};
			};

			const buildOutput = () => {
				const parts: string[] = [prefixText];
				if (enableThinking) {
					const thinkingBody = reasoningText || "思考过程...";
					parts.push(`\`\`\`text\n${thinkingBody}\n\`\`\`\n\n`);
					parts.push("---\n\n");
				}
				parts.push(answerText);
				if (streamCompleted) {
					parts.push("\n\n---\n");
				}
				return parts.join("");
			};

			const renderOutput = () => {
				const nextText = buildOutput();
				editor.replaceRange(nextText, outputStart, outputEnd);
				outputEnd = getEndPosition(outputStart, nextText);
			};

			const setStreamCursor = () => {
				const cm = (editor as any).cm;
				if (cm) {
					const anchor = editor.posToOffset(outputEnd);
					cm.dispatch({
						selection: { anchor, head: anchor },
						scrollIntoView: false,
					});
				} else {
					editor.setCursor(outputEnd);
				}
			};

			renderOutput();

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
						if (!enableThinking) {
							return;
						}

						reasoningText += chunk;
						renderOutput();
					},
					onContent: (chunk) => {
						answerText += chunk;
						renderOutput();
					},
					onError: (error) => {
						new Notice("AI Request Errored: " + error.message);
					},
					onComplete: () => {
						streamCompleted = true;
						renderOutput();
						setStreamCursor();
						void plugin.memoryManager.recordTurn(question, answerText);
						void plugin.memoryManager.appendToHistory(question, answerText, wikiLinksText);
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