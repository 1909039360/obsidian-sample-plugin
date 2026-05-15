import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type { DocumentContextItem } from "./documentContext/types";
import { DocumentContextStore } from "./documentContext/store";
import { MemoryManager } from "./memory/memoryManager";
import MyPlugin from "./main";
import { CodeBlockSelectionStore, createCodeBlockContext } from "./selectionStore";
import { MyPluginSettings } from "./settings";

export const AI_TASK_VIEW_TYPE = "ai-task-view";

export class AITaskView extends ItemView {
	store: CodeBlockSelectionStore;
	documentContextStore: DocumentContextStore;
	settings: () => MyPluginSettings;
	plugin: MyPlugin;
	memoryManager: MemoryManager;
	unsubscribeStore!: () => void;
	unsubscribeDocumentStore!: () => void;
	unsubscribeMemory!: () => void;

	contextPageContainer!: HTMLElement;
	promptPageContainer!: HTMLElement;
	contextTabBtn!: HTMLButtonElement;
	promptTabBtn!: HTMLButtonElement;
	memoryToggleBtn!: HTMLElement;
	thinkingToggleBtn!: HTMLElement;
	documentFocusToggleBtn!: HTMLElement;
	activePage: "context" | "prompt" = "context";

	constructor(
		leaf: WorkspaceLeaf,
		store: CodeBlockSelectionStore,
		documentContextStore: DocumentContextStore,
		settings: () => MyPluginSettings,
		plugin: MyPlugin
	) {
		super(leaf);
		this.store = store;
		this.documentContextStore = documentContextStore;
		this.settings = settings;
		this.plugin = plugin;
		this.memoryManager = plugin.memoryManager;
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
		if (!container) {
			return;
		}

		container.empty();
		container.addClass("ai-task-view");
		const topBar = container.createEl("div", { cls: "ai-task-topbar" });
		topBar.createEl("h3", { text: "AI Context Manager", cls: "ai-task-view-title" });
		const tabs = topBar.createEl("div", { cls: "ai-task-tabs" });
		this.contextTabBtn = tabs.createEl("button", { text: "Context", cls: "ai-task-tab" });
		this.promptTabBtn = tabs.createEl("button", { text: "Prompt", cls: "ai-task-tab" });
		this.contextTabBtn.onclick = () => this.setActivePage("context");
		this.promptTabBtn.onclick = () => this.setActivePage("prompt");

		this.contextPageContainer = container.createEl("div", { cls: "ai-task-page ai-task-page--context" });
		this.promptPageContainer = container.createEl("div", { cls: "ai-task-page ai-task-page--prompt" });
		this.unsubscribeStore = this.store.subscribe(() => this.renderContexts());
		this.unsubscribeDocumentStore = this.documentContextStore.subscribe(() => this.renderContexts());
		this.unsubscribeMemory = this.plugin.memoryManager.subscribe(() => this.updateMemoryToggleBtn());

		this.renderContexts();
		this.updatePageTabs();
		this.updatePageVisibility();
	}

	async onClose() {
		if (this.unsubscribeStore) {
			this.unsubscribeStore();
		}
		if (this.unsubscribeDocumentStore) {
			this.unsubscribeDocumentStore();
		}
		if (this.unsubscribeMemory) {
			this.unsubscribeMemory();
		}
	}

	private updateMemoryToggleBtn() {
		if (!this.memoryToggleBtn) {
			return;
		}

		const enabled = this.plugin.memoryManager.isActive();
		this.memoryToggleBtn.setText(enabled ? "Memory: ON" : "Memory: OFF");
		this.memoryToggleBtn.toggleClass("ai-memory-btn--off", !enabled);
		this.memoryToggleBtn.toggleClass("ai-memory-btn--on", enabled);
	}

	updateThinkingToggleBtn() {
		if (!this.thinkingToggleBtn) {
			return;
		}

		const enabled = this.plugin.settings.enableThinking;
		this.thinkingToggleBtn.setText(enabled ? "Thinking: ON" : "Thinking: OFF");
		this.thinkingToggleBtn.toggleClass("ai-thinking-btn--off", !enabled);
		this.thinkingToggleBtn.toggleClass("ai-thinking-btn--on", enabled);
	}

	private setActivePage(page: "context" | "prompt") {
		if (this.activePage === page) {
			return;
		}

		this.activePage = page;
		this.updatePageTabs();
		this.updatePageVisibility();
	}

	private updatePageTabs() {
		if (!this.contextTabBtn || !this.promptTabBtn) {
			return;
		}

		this.contextTabBtn.toggleClass("is-active", this.activePage === "context");
		this.promptTabBtn.toggleClass("is-active", this.activePage === "prompt");
	}

	private updatePageVisibility() {
		if (!this.contextPageContainer || !this.promptPageContainer) {
			return;
		}

		this.contextPageContainer.toggleClass("is-active", this.activePage === "context");
		this.promptPageContainer.toggleClass("is-active", this.activePage === "prompt");
	}

	renderContexts() {
		this.contextPageContainer.empty();
		this.promptPageContainer.empty();
		this.renderContextPage();
		this.renderPromptPage();
		this.updatePageTabs();
		this.updatePageVisibility();
	}

	private renderContextPage() {
		const toolbar = this.contextPageContainer.createEl("div", { cls: "ai-task-toolbar" });
		const clearBtn = toolbar.createEl("button", { text: "Clear All Contexts", cls: "ai-clear-btn" });
		clearBtn.onclick = () => {
			this.store.clear();
			this.documentContextStore.clear();
		};

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
					sourcePath: "Clipboard",
					startLine: timestamp,
					endLine: timestamp,
					language: "text",
					content: text,
					mode: "live-preview",
				});
				this.store.toggle(context);
				new Notice("已从剪切板导入内容");
			} catch (_error) {
				new Notice("无法读取剪切板");
			}
		};

		this.memoryToggleBtn = toolbar.createEl("button", { cls: "ai-memory-btn" });
		this.updateMemoryToggleBtn();
		this.memoryToggleBtn.onclick = () => {
			this.plugin.memoryManager.toggle();
		};

		this.thinkingToggleBtn = toolbar.createEl("button", { cls: "ai-thinking-btn" });
		this.updateThinkingToggleBtn();
		this.thinkingToggleBtn.onclick = async () => {
			this.plugin.settings.enableThinking = !this.plugin.settings.enableThinking;
			await this.plugin.saveSettings();
			this.updateThinkingToggleBtn();
			new Notice(this.plugin.settings.enableThinking ? "✓ Thinking 模式已开启" : "✗ Thinking 模式已关闭");
		};

		this.renderActiveContexts(this.contextPageContainer);
		this.contextPageContainer.createEl("hr", { cls: "ai-context-divider" });
		this.renderDocumentContexts(this.contextPageContainer);
	}

	private renderPromptPage() {
		this.renderPromptConfig(this.promptPageContainer, "System Prompt", "savedSystemPrompts", "activeSystemPromptId");
		this.promptPageContainer.createEl("hr", { cls: "ai-prompt-divider" });
		this.renderPromptConfig(this.promptPageContainer, "Soul Prompt (回答个性)", "savedSoulPrompts", "activeSoulPromptId");
	}

	private renderActiveContexts(container: HTMLElement) {
		const contexts = this.store.getSelectedContexts();
		container.createEl("h4", { text: "Active Contexts" });

		if (contexts.length === 0) {
			container.createEl("p", { text: "No contexts selected.", cls: "text-muted" });
		} else {
			contexts.forEach((ctx, idx) => {
				const itemDiv = container.createEl("div", { cls: "ai-context-item" });
				const info = itemDiv.createEl("div");
				info.createEl("strong", { text: `[${idx + 1}] ${ctx.language}` });
				info.createEl("br");
				const linesInfo = ctx.endLine > ctx.startLine ? `L${ctx.startLine + 1}-L${ctx.endLine + 1}` : `L${ctx.startLine + 1}`;
				const previewText = ctx.content.length > 30 ? `${ctx.content.replace(/\s+/g, " ").substring(0, 30)}...` : ctx.content;
				info.createEl("small", {
					text: ctx.sourcePath !== "Clipboard" ? `${ctx.sourcePath} (${linesInfo})` : ctx.sourcePath,
					cls: "text-muted",
				});
				info.createEl("br");
				info.createEl("span", { text: previewText, cls: "text-muted ai-context-preview" });

				const removeBtn = itemDiv.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove" } });
				setIcon(removeBtn, "trash");
				removeBtn.onclick = () => this.store.remove(ctx.id);
			});
		}

		const history = this.store.getHistory();
		if (history.length > 0) {
			container.createEl("hr", { cls: "ai-context-divider" });
			container.createEl("h4", { text: "History (Last 5)" });
			history.forEach((ctx) => {
				const itemDiv = container.createEl("div", { cls: "ai-context-history-item" });
				const info = itemDiv.createEl("div");
				const previewText = ctx.content.length > 30 ? `${ctx.content.replace(/\s+/g, " ").substring(0, 30)}...` : ctx.content;
				info.createEl("small", { text: ctx.sourcePath !== "Clipboard" ? `${ctx.sourcePath} (${ctx.language})` : "Clipboard" });
				info.createEl("br");
				info.createEl("span", { text: previewText, cls: "ai-context-preview" });

				const restoreBtn = itemDiv.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Restore" } });
				setIcon(restoreBtn, "plus-with-circle");
				restoreBtn.onclick = () => this.store.toggle(ctx);
			});
		}
	}

	private renderDocumentContexts(container: HTMLElement) {
		const contexts = this.documentContextStore.getSelectedItems();
		const header = container.createEl("div", { cls: "ai-document-context-header" });
		header.createEl("h4", { text: "Document Contexts", cls: "ai-document-context-title" });
		this.documentFocusToggleBtn = header.createEl("button", { cls: "ai-document-focus-btn" });
		this.updateDocumentFocusToggleBtn();
		this.documentFocusToggleBtn.onclick = async () => {
			const enabled = !this.documentContextStore.isFocusMode();
			this.documentContextStore.setFocusMode(enabled);
			this.plugin.settings.documentContextFocusMode = enabled;
			await this.plugin.saveSettings();
			this.updateDocumentFocusToggleBtn();
			new Notice(enabled ? "✓ 关注模式已开启" : "✗ 关注模式已关闭");
		};

		if (contexts.length === 0) {
			container.createEl("p", { text: "No document contexts selected.", cls: "text-muted" });
		} else {
			contexts.forEach((ctx) => this.renderDocumentContextItem(container, ctx, false));
		}

		const history = this.documentContextStore.getHistory();
		if (history.length > 0) {
			container.createEl("hr", { cls: "ai-context-divider" });
			container.createEl("h4", { text: "Document History (Last 5)" });
			history.forEach((ctx) => this.renderDocumentContextItem(container, ctx, true));
		}
	}

	private updateDocumentFocusToggleBtn() {
		if (!this.documentFocusToggleBtn) {
			return;
		}

		const enabled = this.documentContextStore.isFocusMode();
		this.documentFocusToggleBtn.setText(enabled ? "关注模式: ON" : "关注模式: OFF");
		this.documentFocusToggleBtn.toggleClass("ai-document-focus-btn--on", enabled);
		this.documentFocusToggleBtn.toggleClass("ai-document-focus-btn--off", !enabled);
	}

	private renderDocumentContextItem(container: HTMLElement, ctx: DocumentContextItem, isHistory: boolean) {
		const itemDiv = container.createEl("div", {
			cls: isHistory ? "ai-context-history-item ai-document-context-item" : "ai-context-item ai-document-context-item",
		});
		const info = itemDiv.createEl("div");
		info.createEl("strong", { text: ctx.fileName });
		info.createEl("br");
		info.createEl("small", {
			text: ctx.titlePath.length > 0 ? ctx.titlePath.join(" > ") : "当前文档",
			cls: "text-muted ai-document-context-path",
		});

		const actionBtn = itemDiv.createEl("button", { cls: "clickable-icon", attr: { "aria-label": isHistory ? "Restore" : "Remove" } });
		setIcon(actionBtn, isHistory ? "plus-with-circle" : "trash");
		actionBtn.onclick = () => {
			if (isHistory) {
				this.documentContextStore.select(ctx);
				return;
			}
			this.documentContextStore.remove(ctx.id);
		};
	}

	private renderPromptConfig(
		container: HTMLElement,
		title: string,
		listKey: "savedSystemPrompts" | "savedSoulPrompts",
		activeKey: "activeSystemPromptId" | "activeSoulPromptId"
	) {
		const settings = this.settings();
		const list = settings[listKey];

		const headerDiv = container.createEl("div", { cls: "ai-prompt-header" });
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
			container.createEl("p", { text: "未配置任何提示词。", cls: "text-muted" });
			return;
		}

		const selectDiv = container.createEl("div", { cls: "ai-prompt-select-row" });
		const select = selectDiv.createEl("select", { cls: "dropdown ai-prompt-select" });

		if (activeKey === "activeSoulPromptId") {
			select.createEl("option", { text: "None / Default", value: "" });
		}

		list.forEach((prompt) => {
			const option = select.createEl("option", { text: prompt.name, value: prompt.id });
			if (settings[activeKey] === prompt.id) {
				option.selected = true;
			}
		});

		select.onchange = async () => {
			settings[activeKey] = select.value;
			await this.plugin.saveSettings();
			this.renderContexts();
		};

		const activePrompt = list.find((prompt) => prompt.id === settings[activeKey]);
		if (!activePrompt) {
			return;
		}

		const deleteBtn = selectDiv.createEl("button", { cls: "clickable-icon ai-prompt-delete-btn" });
		setIcon(deleteBtn, "trash");
		deleteBtn.onclick = async () => {
			settings[listKey] = list.filter((prompt) => prompt.id !== activePrompt.id) as typeof settings[typeof listKey];
			settings[activeKey] = "";
			await this.plugin.saveSettings();
			this.renderContexts();
		};

		const nameInput = container.createEl("input", { type: "text" });
		nameInput.addClass("ai-prompt-name-input");
		nameInput.value = activePrompt.name;
		nameInput.placeholder = "Prompt Name";
		nameInput.onchange = async () => {
			activePrompt.name = nameInput.value;
			await this.plugin.saveSettings();
			this.renderContexts();
		};

		const textInput = container.createEl("textarea");
		textInput.addClass("ai-prompt-content-input");
		textInput.value = activePrompt.content;
		textInput.placeholder = title === "System Prompt" ? "你是一个... {{DOCUMENT_CONTEXT}}" : "用鲁迅的语气回答...";
		textInput.onchange = async () => {
			activePrompt.content = textInput.value;
			await this.plugin.saveSettings();
		};
	}
}
