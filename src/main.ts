import {App, Editor, MarkdownView, Modal, Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";
import {registerCodeBlockCollapser} from "./codeBlockCollapser";
import {createEditorCodeBlockCollapserExtension} from "./editorCodeBlockCollapser";
import {CodeBlockSelectionStore} from "./selectionStore";
import {streamDashScope} from "./ai";

// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	readonly selectionStore = new CodeBlockSelectionStore();

	async onload() {
		await this.loadSettings();

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
				
				// Move to next line and start writing
				editor.replaceRange("\n---\n\n> 思考过程...\n> ", { line: cursor.line, ch: line.length });
				let currentLine = cursor.line + 4;
				let currentCh = 2; // "> "

				let isAnswering = false;

				await streamDashScope(
					question, 
					contexts,
					this.settings.dashScopeApiKey,
					{
						onReasoning: (chunk) => {
							// For line breaks in reasoning block, we insert "> " to maintain quote format
							const formattedChunk = chunk.replace(/\n/g, "\n> ");
							editor.replaceRange(formattedChunk, { line: currentLine, ch: currentCh });
							
							// Update cursor position tracking
							const lines = formattedChunk.split("\n");
							if (lines.length > 1) {
								currentLine += lines.length - 1;
								const lastLine = lines[lines.length - 1];
								currentCh = lastLine ? lastLine.length : 0;
							} else {
								currentCh += formattedChunk.length;
							}
							
							// Scroll cursor into view (Optional)
						},
						onContent: (chunk) => {
							if (!isAnswering) {
								isAnswering = true;
								const endQuote = "\n\n---\n\n";
								editor.replaceRange(endQuote, { line: currentLine, ch: currentCh });
								currentLine += 4;
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
						},
						onError: (error) => {
							new Notice("AI Request Errored: " + error.message);
						},
						onComplete: () => {
							editor.replaceRange("\n\n---\n", { line: currentLine, ch: currentCh });
							// new Notice("AI 回答已完成！");
						}
					}
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
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
