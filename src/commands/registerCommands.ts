import { StateEffect } from "@codemirror/state";
import { Editor, MarkdownView, Notice } from "obsidian";
import { streamDashScope } from "../ai";
import { createCodeBlockContext } from "../selectionStore";
import { CodeBlockSelectionStore } from "../selectionStore";
import { MyPluginSettings } from "../settings";
import { MemoryManager } from "../memory/memoryManager";
import { AI_TASK_VIEW_TYPE, AITaskView } from "../aiTaskView";

interface CommandDefinition {
	id: string;
	name: string;
	hotkeys?: Array<{ modifiers: string[]; key: string }>;
	callback?: () => void | Promise<void>;
	editorCallback?: (editor: Editor, view: MarkdownView) => void | Promise<void>;
	checkCallback?: (checking: boolean) => boolean | void;
}

export interface CommandHost {
	app: {
		workspace: {
			getActiveViewOfType: (type: typeof MarkdownView) => MarkdownView | null;
			getLeavesOfType: (type: string) => Array<{ view: unknown }>;
		};
	};
	manifest: { id: string };
	settings: MyPluginSettings;
	selectionStore: CodeBlockSelectionStore;
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
		callback: () => {
			const isOn = plugin.memoryManager.toggle();
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
					if (isAdded) {
						new Notice(
							`剪切板内容已加入 AI 上下文（当前共 ${plugin.selectionStore.getSelectedContexts().length} 项）`
						);
					} else {
						new Notice("已从上下文中移除。");
					}
				} catch (e) {
					new Notice("读取剪切板失败：" + e);
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
			if (isAdded) {
				new Notice(
					`已加入 AI 上下文队列（当前共 ${plugin.selectionStore.getSelectedContexts().length} 项）`
				);
			} else {
				new Notice(
					`已从 AI 上下文队列移除（当前共 ${plugin.selectionStore.getSelectedContexts().length} 项）`
				);
			}
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

			plugin.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
				const view = leaf.view as MarkdownView;
				if (view.previewMode) {
					view.previewMode.rerender(true);
				}
				if (view.editor) {
					const cm = (view.editor as any).cm;
					if (cm) {
						const forceUpdate = StateEffect.define<null>();
						cm.dispatch({
							effects: forceUpdate.of(null),
						});
					}
				}
			});

			new Notice("✓ 已取消并清空所有选中的代码块！");
		},
	});

	plugin.addCommand({
		id: "ai-completion",
		name: "AI Completion (DashScope)",
		hotkeys: [{ modifiers: ["Mod"], key: "Enter" }],
		editorCallback: async (editor: Editor) => {
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);
			const match = line.match(/\/\/(.*?)\/\/\s*$/);

			if (!match || !match[1]) {
				new Notice("未在游标所在行找到以 '//问题//' 格式结尾的问题。");
				return;
			}

			const question = match[1].trim();
			const contexts = plugin.selectionStore.getSelectedContexts();
			const lineWithoutSlashes = line.substring(0, match.index) + match[1];
			editor.setLine(cursor.line, lineWithoutSlashes);
			const newLineLength = lineWithoutSlashes.length;

			const enableThinking = plugin.settings.enableThinking;
			if (enableThinking) {
				editor.replaceRange("\n---\n\n```text\n思考过程...\n", {
					line: cursor.line,
					ch: newLineLength,
				});
			} else {
				editor.replaceRange("\n---\n\n", {
					line: cursor.line,
					ch: newLineLength,
				});
			}

			let currentLine = cursor.line + (enableThinking ? 5 : 3);
			let currentCh = 0;
			let isAnswering = !enableThinking;
			let accumulatedAnswer = "";

			await streamDashScope(
				question,
				contexts,
				plugin.settings.dashScopeApiKey,
				enableThinking,
				{
					onReasoning: (chunk) => {
						if (!enableThinking) return;

						editor.replaceRange(chunk, { line: currentLine, ch: currentCh });

						const lines = chunk.split("\n");
						if (lines.length > 1) {
							currentLine += lines.length - 1;
							const lastLine = lines[lines.length - 1];
							currentCh = lastLine ? lastLine.length : 0;
						} else {
							currentCh += chunk.length;
						}

						editor.setCursor({ line: currentLine, ch: currentCh });
					},
					onContent: (chunk) => {
						accumulatedAnswer += chunk;

						if (!isAnswering && enableThinking) {
							isAnswering = true;
							const endQuote = "\n```\n\n---\n\n";
							editor.replaceRange(endQuote, {
								line: currentLine,
								ch: currentCh,
							});
							currentLine += 5;
							currentCh = 0;
						}

						editor.replaceRange(chunk, { line: currentLine, ch: currentCh });

						const lines = chunk.split("\n");
						if (lines.length > 1) {
							currentLine += lines.length - 1;
							const lastLine = lines[lines.length - 1];
							currentCh = lastLine ? lastLine.length : 0;
						} else {
							currentCh += chunk.length;
						}

						editor.setCursor({ line: currentLine, ch: currentCh });
					},
					onError: (error) => {
						new Notice("AI Request Errored: " + error.message);
					},
					onComplete: () => {
						editor.replaceRange("\n\n---\n", {
							line: currentLine,
							ch: currentCh,
						});
						// Record turn in memory system (fire-and-forget)
						void plugin.memoryManager.recordTurn(question, accumulatedAnswer);
					},
				},
				plugin.settings.aiBaseUrl,
				plugin.settings.aiModel,
				plugin.settings.savedSystemPrompts?.find(
					(p) => p.id === plugin.settings.activeSystemPromptId
				)?.content || plugin.settings.systemPromptTemplate,
				plugin.settings.savedSoulPrompts?.find(
					(p) => p.id === plugin.settings.activeSoulPromptId
				)?.content || "",
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
			if (markdownView) {
				if (!checking) {
					plugin.openSampleModal();
				}

				return true;
			}
			return false;
		},
	});
}