import {App, Modal, Notice, Plugin, WorkspaceLeaf} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";
import {registerCodeBlockCollapser} from "./codeBlockCollapser";
import {createEditorCodeBlockCollapserExtension} from "./editorCodeBlockCollapser";
import {CodeBlockSelectionStore} from "./selectionStore";
import {AIPromptSuggest} from "./promptSuggest";
import {AITaskView, AI_TASK_VIEW_TYPE} from "./aiTaskView";
import {registerPluginCommands} from "./commands/registerCommands";

// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	readonly selectionStore = new CodeBlockSelectionStore();

	async onload() {
		await this.loadSettings();

		// Register View
		this.registerView(
			AI_TASK_VIEW_TYPE,
			(leaf) => new AITaskView(leaf, this.selectionStore, () => this.settings, this)
		);

		registerPluginCommands(this);

		// This creates an icon in the left ribbon.
		this.addRibbonIcon('dice', 'Sample', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status bar text');



		// 注册 AI 提示词代码提示
		this.registerEditorSuggest(new AIPromptSuggest(this.app, () => this.settings));

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// 注册代码块折叠功能
		registerCodeBlockCollapser(this, () => this.settings, this.selectionStore);
		this.registerEditorExtension(
			createEditorCodeBlockCollapserExtension(this.settings, this.selectionStore)
		);

		// 注册右键菜单
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				const selection = editor.getSelection();
				if (selection) {
					menu.addItem((item) => {
						item
							.setTitle('Add selected text to AI context')
							.setIcon('plus-circle')
							.onClick(() => {
								// @ts-ignore
								this.app.commands.executeCommandById(this.manifest.id + ':add-selected-text-to-context');
							});
					});
				}

				menu.addItem((item) => {
					item
						.setTitle('Clear all selected contexts')
						.setIcon('x-circle')
						.onClick(() => {
							// @ts-ignore
							this.app.commands.executeCommandById(this.manifest.id + ':clear-selected-code-blocks');
						});
				});
			})
		);

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(AI_TASK_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0] as WorkspaceLeaf;
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			const rleaf = workspace.getRightLeaf(false);
			if (rleaf) {
				await rleaf.setViewState({ type: AI_TASK_VIEW_TYPE, active: true });
				leaf = rleaf;
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	openSampleModal() {
		new SampleModal(this.app).open();
	}

	onunload() {
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
		
		// Ensure default system prompt is added if empty
		if (!this.settings.savedSystemPrompts || this.settings.savedSystemPrompts.length === 0) {
			this.settings.savedSystemPrompts = DEFAULT_SETTINGS.savedSystemPrompts;
			// If we default the list, let's also select it if nothing is active
			if (!this.settings.activeSystemPromptId) {
				this.settings.activeSystemPromptId = DEFAULT_SETTINGS.activeSystemPromptId;
			}
		}
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
