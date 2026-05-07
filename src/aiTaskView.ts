import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import { CodeBlockSelectionStore, createCodeBlockContext } from "./selectionStore";
import { MyPluginSettings } from "./settings";

import MyPlugin from "./main";

export const AI_TASK_VIEW_TYPE = "ai-task-view";

export class AITaskView extends ItemView {
	store: CodeBlockSelectionStore;
	settings: () => MyPluginSettings;
	plugin: MyPlugin;
	unsubscribeStore: () => void;

	contextContainer: HTMLElement;

	constructor(leaf: WorkspaceLeaf, store: CodeBlockSelectionStore, settings: () => MyPluginSettings, plugin: MyPlugin) {
		super(leaf);
		this.store = store;
		this.settings = settings;
		this.plugin = plugin;
	}

	getViewType() {
		return AI_TASK_VIEW_TYPE;
	}

	getDisplayText() {
		return "AI Tasks";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		if (!container) return;
		container.empty();
		container.addClass("ai-task-view");

		container.createEl("h3", { text: "AI Context Manager" });

		const toolbar = container.createEl("div", { cls: "ai-task-toolbar" });

		// Clear all button
		const clearBtn = toolbar.createEl("button", { text: "Clear All Contexts", cls: "ai-clear-btn" });
		clearBtn.onclick = () => {
			this.store.clear();
		};

		// Clipboard paste button
		const clipboardBtn = toolbar.createEl("button", { text: "Paste Clipboard", cls: "ai-clipboard-btn" });
		clipboardBtn.onclick = async () => {
			try {
				const text = await navigator.clipboard.readText();
				if (!text) {
					new Notice("剪切板为空");
					return;
				}
				const timestamp = Date.now();
				const context = createCodeBlockContext({
					sourcePath: 'Clipboard',
					startLine: timestamp,
					endLine: timestamp,
					language: 'text',
					content: text,
					mode: 'live-preview'
				});
				this.store.toggle(context);
				new Notice("已从剪切板导入内容");
			} catch(e) {
				new Notice("无法读取剪切板");
			}
		};

		// Context items list
		this.contextContainer = container.createEl("div", { cls: "ai-context-container" });

		// Subscribe to store changes to re-render context list
		this.unsubscribeStore = this.store.subscribe(() => {
			this.renderContexts();
		});

		this.renderContexts();
	}

	async onClose() {
		if (this.unsubscribeStore) {
			this.unsubscribeStore();
		}
	}

	renderContexts() {
		this.contextContainer.empty();
		const contexts = this.store.getSelectedContexts();

		this.contextContainer.createEl("h4", { text: "Active Contexts" });

		if (contexts.length === 0) {
			this.contextContainer.createEl("p", { text: "No contexts selected.", cls: "text-muted" });
		} else {
			contexts.forEach((ctx, idx) => {
				const itemDiv = this.contextContainer.createEl("div", { cls: "ai-context-item" });

				const info = itemDiv.createEl("div");
				info.createEl("strong", { text: `[${idx+1}] ${ctx.language}` });
				info.createEl("br");

				const fileInfo = ctx.sourcePath;
				const linesInfo = ctx.endLine > ctx.startLine ? `L${ctx.startLine + 1}-L${ctx.endLine + 1}` : `L${ctx.startLine + 1}`;
				const previewText = ctx.content.length > 30 ? ctx.content.replace(/\s+/g, ' ').substring(0, 30) + "..." : ctx.content;

				info.createEl("small", { text: fileInfo !== 'Clipboard' ? `${fileInfo} (${linesInfo})` : fileInfo, cls: "text-muted" });
				info.createEl("br");
				info.createEl("span", { text: previewText, cls: "text-muted ai-context-preview" });

				const removeBtn = itemDiv.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove" } });
				setIcon(removeBtn, "trash");
				removeBtn.onclick = () => {
					this.store.remove(ctx.id);
				};
			});
		}

		// Render History
		const history = this.store.getHistory();
		if (history.length > 0) {
			this.contextContainer.createEl("hr", { cls: "ai-context-divider" });
			this.contextContainer.createEl("h4", { text: "History (Last 5)" });
			
			history.forEach((ctx, idx) => {
				const itemDiv = this.contextContainer.createEl("div", { cls: "ai-context-history-item" });

				const info = itemDiv.createEl("div");
				const previewText = ctx.content.length > 30 ? ctx.content.replace(/\s+/g, ' ').substring(0, 30) + "..." : ctx.content;
				info.createEl("small", { text: ctx.sourcePath !== 'Clipboard' ? `${ctx.sourcePath} (${ctx.language})` : 'Clipboard' });
				info.createEl("br");
				info.createEl("span", { text: previewText, cls: "ai-context-preview" });

				const restoreBtn = itemDiv.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Restore" } });
				setIcon(restoreBtn, "plus-with-circle");
				restoreBtn.onclick = () => {
					this.store.toggle(ctx); // Adds it back and removes from history
				};
			});
		}

		// Prompts config container
		this.contextContainer.createEl("hr", { cls: "ai-prompt-divider" });
		this.renderPromptConfig("System Prompt", "savedSystemPrompts", "activeSystemPromptId");
		this.contextContainer.createEl("hr", { cls: "ai-prompt-divider" });
		this.renderPromptConfig("Soul Prompt (回答个性)", "savedSoulPrompts", "activeSoulPromptId");
	}

	private renderPromptConfig(
		title: string, 
		listKey: "savedSystemPrompts" | "savedSoulPrompts", 
		activeKey: "activeSystemPromptId" | "activeSoulPromptId"
	) {
		const settings = this.settings();
		const list = settings[listKey];
		
		const headerDiv = this.contextContainer.createEl("div", { cls: "ai-prompt-header" });
		headerDiv.createEl("h4", { text: title, cls: "ai-prompt-title" });

		const newBtn = headerDiv.createEl("button", { text: "+ New", cls: "ai-prompt-new-btn" });
		newBtn.onclick = async () => {
			const id = Date.now().toString();
			list.push({ id, name: "New Prompt", content: "" });
			settings[activeKey] = id;
			await this.plugin.saveSettings();
			this.renderContexts();
		};

		if (list.length === 0) {
			this.contextContainer.createEl("p", { text: "未配置任何提示词。", cls: "text-muted" });
			return;
		}

		const selectDiv = this.contextContainer.createEl("div", { cls: "ai-prompt-select-row" });
		
		const select = selectDiv.createEl("select", { cls: "dropdown ai-prompt-select" });
		
		// Add an empty option for Soul Prompts if none active
		if (activeKey === "activeSoulPromptId") {
			select.createEl("option", { text: "None / Default", value: "" });
		}

		list.forEach(p => {
			const opt = select.createEl("option", { text: p.name, value: p.id });
			if (settings[activeKey] === p.id) {
				opt.selected = true;
			}
		});

		select.onchange = async () => {
			settings[activeKey] = select.value;
			await this.plugin.saveSettings();
			this.renderContexts();
		};

		const activePrompt = list.find(p => p.id === settings[activeKey]);
		
		if (activePrompt) {
			const deleteBtn = selectDiv.createEl("button", { cls: "clickable-icon ai-prompt-delete-btn" });
			setIcon(deleteBtn, "trash");
			deleteBtn.onclick = async () => {
				settings[listKey] = list.filter((p: any) => p.id !== activePrompt.id) as any;
				settings[activeKey] = "";
				await this.plugin.saveSettings();
				this.renderContexts();
			};

			const nameInput = this.contextContainer.createEl("input", { type: "text" });
			nameInput.addClass("ai-prompt-name-input");
			nameInput.value = activePrompt.name;
			nameInput.placeholder = "Prompt Name";
			nameInput.onchange = async () => {
				activePrompt.name = nameInput.value;
				await this.plugin.saveSettings();
				this.renderContexts();
			};

			const textInput = this.contextContainer.createEl("textarea");
			textInput.addClass("ai-prompt-content-input");
			textInput.value = activePrompt.content;
			textInput.placeholder = title === "System Prompt" ? "你是一个... {{CONTEXT}}" : "用鲁迅的语气回答...";
			textInput.onchange = async () => {
				activePrompt.content = textInput.value;
				await this.plugin.saveSettings();
			};
		}
	}
}
