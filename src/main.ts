import {App, Editor, MarkdownView, Modal, Notice, Plugin} from 'obsidian';
import { StateEffect } from "@codemirror/state";
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";
import {registerCodeBlockCollapser} from "./codeBlockCollapser";
import {createEditorCodeBlockCollapserExtension} from "./editorCodeBlockCollapser";
import {CodeBlockSelectionStore} from "./selectionStore";
import {streamDashScope} from "./ai";
import {MemoryService} from "./memoryService";
import {DEFAULT_MEMORY_STATE, sanitizeMemoryState, type MemoryState} from "./memoryTypes";
import {AIPromptSuggest} from "./promptSuggest";

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	memoryState: MemoryState = DEFAULT_MEMORY_STATE;
	memoryService!: MemoryService;
	readonly selectionStore = new CodeBlockSelectionStore();

	async onload() {
		await this.loadSettings();
		this.memoryService = new MemoryService({
			app: this.app,
			pluginId: this.manifest.id,
			getApiKey: () => this.settings.dashScopeApiKey,
			getState: () => this.memoryState,
			saveState: async (memoryState) => {
				this.memoryState = memoryState;
				await this.savePluginData();
			}
		});

		// This creates an icon in the left ribbon.
		this.addRibbonIcon('dice', 'Sample', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status bar text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-modal-simple',
			name: 'Open modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'replace-selected',
			name: 'Replace selected content',
			editorCallback: (editor: Editor) => {
				editor.replaceSelection('Sample editor command');
			}
		});

		this.addCommand({
			id: 'copy-selected-code-block-contexts',
			name: 'Copy selected code block contexts',
			callback: async () => {
				const selectedContexts = this.selectionStore.getSelectedContexts();
				if (selectedContexts.length === 0) {
					new Notice('暂无已选中的代码块');
					return;
				}

				const formattedContexts = selectedContexts
					.map((context, index) => {
						const lineText = context.endLine > context.startLine
							? `${context.startLine + 1}-${context.endLine + 1}`
							: `${context.startLine + 1}`;

						return [
							`[Code Block ${index + 1}]`,
							`File: ${context.sourcePath || 'unknown'}`,
							`Lines: ${lineText}`,
							`Language: ${context.language || 'code'}`,
							context.content,
						].join('\n');
					})
					.join('\n\n---\n\n');

				await navigator.clipboard.writeText(formattedContexts);
				new Notice(`已复制 ${selectedContexts.length} 个代码块上下文`);
			}
		});

		this.addCommand({
			id: 'insert-ai-question-markers',
			name: 'Insert AI Question Markers (////)',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: '/' }],
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				// Insert //// at current cursor position
				editor.replaceRange('////', cursor);
				// Move cursor back by 2 characters to be exactly in the middle: //|//
				editor.setCursor({ line: cursor.line, ch: cursor.ch + 2 });

				// 通过底层 CodeMirror 模拟一次原生打字事件 (userEvent: "input.type") 
				// 从而强行欺骗 Obsidian 的 EditorSuggest 事件监听器将其弹起。
				setTimeout(() => {
					const cm = (editor as any).cm;
					if (cm) {
						const pos = cm.state.selection.main.head;
						cm.dispatch({
							changes: { from: pos, insert: " " },
							selection: { anchor: pos + 1, head: pos + 1 },
							userEvent: "input.type"
						});
						// 紧接着发一个退格事件，将其恢复为最初的光标状态，并且激活弹出查询
						cm.dispatch({
							changes: { from: pos, to: pos + 1 },
							selection: { anchor: pos, head: pos },
							userEvent: "delete.backward"
						});
					}
				}, 50);
			}
		});

		this.addCommand({
			id: 'clear-selected-code-blocks',
			name: 'Clear all selected code blocks',
			hotkeys: [{ modifiers: ['Mod'], key: "'" }], // Ctrl + ' (Windows) / Cmd + ' (Mac)
			callback: () => {
				// 清空缓存
				this.selectionStore.clear();

				// 遍历所有打开的 Markdown 视图并强制重绘
				this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
					const view = leaf.view as MarkdownView;
					// 刷新阅读模式
					if (view.previewMode) {
						view.previewMode.rerender(true);
					}
					// 刷新编辑模式 (Live Preview)
					if (view.editor) {
						const cm = (view.editor as any).cm;
						if (cm) {
							// 定义一个空副作用，强行让 CodeMirror 认为发生了一次 Transaction
							const forceUpdate = StateEffect.define<null>();
							cm.dispatch({
								effects: forceUpdate.of(null)
							});
						}
					}
				});

				new Notice('✓ 已取消并清空所有选中的代码块！');
			}
		});

		this.addCommand({
			id: 'ai-completion',
			name: 'AI Completion (DashScope)',
			hotkeys: [{ modifiers: ['Mod'], key: 'Enter' }], // Mod = Ctrl (Win/Linux) 或者 Cmd (Mac)
			editorCallback: async (editor: Editor) => {
				const cursor = editor.getCursor();
				const line = editor.getLine(cursor.line);
				const match = line.match(/\/\/(.*?)\/\/\s*$/); // 允许尾部有空格

				if (!match || !match[1]) {
					new Notice("未在游标所在行找到以 '//问题//' 格式结尾的问题。");
					return;
				}

				const question = match[1].trim();
				const contexts = this.selectionStore.getSelectedContexts();
				const memoryContext = this.memoryService.buildPromptContext();
				let answerBuffer = "";
				
				// 去除问题前后的 //
				// match.index 是整个 //问题// 开始的位置
				const lineWithoutSlashes = line.substring(0, match.index) + match[1];
				editor.setLine(cursor.line, lineWithoutSlashes);
				const newLineLength = lineWithoutSlashes.length;

				// Move to next line and start writing
				const enableThinking = this.settings.enableThinking;
				if (enableThinking) {
					editor.replaceRange("\n---\n\n```text\n思考过程...\n", { line: cursor.line, ch: newLineLength });
				} else {
					editor.replaceRange("\n---\n\n", { line: cursor.line, ch: newLineLength });
				}
				
				let currentLine = cursor.line + (enableThinking ? 5 : 3);
				let currentCh = 0; 

				let isAnswering = !enableThinking;

				await streamDashScope(
					question, 
					contexts,
					this.settings.dashScopeApiKey,
					enableThinking,
					{
						onReasoning: (chunk) => {
							if (!enableThinking) return;
							
							editor.replaceRange(chunk, { line: currentLine, ch: currentCh });
							
							// Update cursor position tracking
							const lines = chunk.split("\n");
							if (lines.length > 1) {
								currentLine += lines.length - 1;
								const lastLine = lines[lines.length - 1];
								currentCh = lastLine ? lastLine.length : 0;
							} else {
								currentCh += chunk.length;
							}
							
							// 将光标移动到最新位置，确保视图可以向下自动滚动
							editor.setCursor({ line: currentLine, ch: currentCh });
						},
						onContent: (chunk) => {
							answerBuffer += chunk;

							if (!isAnswering && enableThinking) {
								isAnswering = true;
								const endQuote = "\n```\n\n---\n\n";
								editor.replaceRange(endQuote, { line: currentLine, ch: currentCh });
								currentLine += 5;
								currentCh = 0;
							}

							editor.replaceRange(chunk, { line: currentLine, ch: currentCh });

							// Update cursor tracking
							const lines = chunk.split("\n");
							if (lines.length > 1) {
								currentLine += lines.length - 1;
								const lastLine = lines[lines.length - 1];
								currentCh = lastLine ? lastLine.length : 0;
							} else {
								currentCh += chunk.length;
							}

							// 将光标移动到最新位置，确保视图可以向下自动滚动
							editor.setCursor({ line: currentLine, ch: currentCh });
						},
						onError: (error) => {
							new Notice("AI Request Errored: " + error.message);
						},
						onComplete: () => {
							editor.replaceRange("\n\n---\n", { line: currentLine, ch: currentCh });
							void this.memoryService.recordConversation(question, answerBuffer);
							// new Notice("AI 回答已完成！");
						}
					},
					memoryContext
				);
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-modal-complex',
			name: 'Open modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			}
		});

		// 注册 AI 提示词代码提示
		this.registerEditorSuggest(new AIPromptSuggest(this.app));

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// 注册代码块折叠功能
		registerCodeBlockCollapser(this, () => this.settings, this.selectionStore);
		this.registerEditorExtension(
			createEditorCodeBlockCollapserExtension(this.settings, this.selectionStore)
		);

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

	}

	onunload() {
	}

	async loadSettings() {
		const loadedData: unknown = await this.loadData();
		if (hasPersistedPluginFields(loadedData)) {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData.settings);
			this.memoryState = sanitizeMemoryState(loadedData.memoryState);
			return;
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData as Partial<MyPluginSettings>);
		this.memoryState = DEFAULT_MEMORY_STATE;
	}

	async saveSettings() {
		await this.savePluginData();
	}

	private async savePluginData() {
		await this.saveData({
			settings: this.settings,
			memoryState: this.memoryState,
		});
	}
}

function hasPersistedPluginFields(
	value: unknown
): value is { settings?: Partial<MyPluginSettings>; memoryState?: MemoryState } {
	return typeof value === "object" && value !== null &&
		("settings" in value || "memoryState" in value);
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
