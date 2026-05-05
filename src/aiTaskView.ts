import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { CodeBlockSelectionStore } from "./selectionStore";
import { streamDashScope } from "./ai";
import { MyPluginSettings } from "./settings";

export const AI_TASK_VIEW_TYPE = "ai-task-view";

export class AITaskView extends ItemView {
	store: CodeBlockSelectionStore;
	settings: () => MyPluginSettings;
	unsubscribeStore: () => void;

	contextContainer: HTMLElement;
	chatContainer: HTMLElement;
	inputEl: HTMLTextAreaElement;

	constructor(leaf: WorkspaceLeaf, store: CodeBlockSelectionStore, settings: () => MyPluginSettings) {
		super(leaf);
		this.store = store;
		this.settings = settings;
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

		const header = container.createEl("h3", { text: "AI Context & Chat" });

		// Context items list
		this.contextContainer = container.createEl("div", { cls: "ai-context-container" });
		
		// Clear all button
		const clearBtn = container.createEl("button", { text: "Clear All Contexts", cls: "ai-clear-btn" });
		clearBtn.style.marginBottom = "10px";
		clearBtn.onclick = () => {
			this.store.clear();
		};

		// Chat display area
		this.chatContainer = container.createEl("div", { cls: "ai-chat-container" });
		this.chatContainer.style.flexGrow = "1";
		this.chatContainer.style.overflowY = "auto";
		this.chatContainer.style.border = "1px solid var(--background-modifier-border)";
		this.chatContainer.style.borderRadius = "4px";
		this.chatContainer.style.padding = "8px";
		this.chatContainer.style.marginTop = "10px";
		this.chatContainer.style.marginBottom = "10px";
		this.chatContainer.style.minHeight = "200px";

		// Input area
		this.inputEl = container.createEl("textarea", {
			attr: { placeholder: "Ask a question based on contexts..." }
		});
		this.inputEl.style.width = "100%";
		this.inputEl.style.minHeight = "60px";
		this.inputEl.style.resize = "vertical";

		// Submit button
		const submitBtn = container.createEl("button", { text: "Send", cls: "mod-cta" });
		submitBtn.style.width = "100%";
		submitBtn.style.marginTop = "10px";
		submitBtn.onclick = () => this.submitQuestion();

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

		if (contexts.length === 0) {
			this.contextContainer.createEl("p", { text: "No contexts selected.", cls: "text-muted" });
			return;
		}

		contexts.forEach((ctx, idx) => {
			const itemDiv = this.contextContainer.createEl("div", { cls: "ai-context-item" });
			itemDiv.style.display = "flex";
			itemDiv.style.justifyContent = "space-between";
			itemDiv.style.alignItems = "center";
			itemDiv.style.border = "1px solid var(--background-modifier-border)";
			itemDiv.style.borderRadius = "4px";
			itemDiv.style.padding = "4px 8px";
			itemDiv.style.marginBottom = "4px";

			const info = itemDiv.createEl("div");
			info.createEl("strong", { text: `[${idx+1}] ${ctx.language}` });
			info.createEl("br");
			
			const fileInfo = ctx.sourcePath;
			const linesInfo = ctx.endLine > ctx.startLine ? `L${ctx.startLine + 1}-L${ctx.endLine + 1}` : `L${ctx.startLine + 1}`;
			const previewText = ctx.content.length > 30 ? ctx.content.substring(0, 30) + "..." : ctx.content;

			info.createEl("small", { text: `${fileInfo} (${linesInfo})`, cls: "text-muted" });
			info.createEl("br");
			info.createEl("span", { text: previewText, cls: "text-muted" }).style.fontSize = "0.8em";

			const removeBtn = itemDiv.createEl("button", { cls: "clickable-icon" });
			setIcon(removeBtn, "trash");
			removeBtn.onclick = () => {
				this.store.remove(ctx.id);
			};
		});
	}

	async submitQuestion() {
		const question = this.inputEl.value.trim();
		if (!question) return;

		const contexts = this.store.getSelectedContexts();
		const settings = this.settings();

		// Create a new message block in chat container
		const userMsg = this.chatContainer.createEl("div");
		userMsg.createEl("strong", { text: "You:" });
		userMsg.createEl("p", { text: question });
		userMsg.style.borderBottom = "1px solid var(--background-modifier-border)";
		userMsg.style.paddingBottom = "8px";
		userMsg.style.marginBottom = "8px";

		const aiMsg = this.chatContainer.createEl("div");
		aiMsg.createEl("strong", { text: "AI:" });
		const aiContent = aiMsg.createEl("div");
		
		const reasoningContent = aiMsg.createEl("div");
		reasoningContent.style.color = "var(--text-muted)";
		reasoningContent.style.fontSize = "0.9em";
		reasoningContent.style.borderLeft = "2px solid var(--text-muted)";
		reasoningContent.style.paddingLeft = "8px";
		reasoningContent.style.marginBottom = "8px";
		reasoningContent.style.display = "none";

		// Clear input
		this.inputEl.value = "";

		const enableThinking = settings.enableThinking;
		if (enableThinking) {
			reasoningContent.style.display = "block";
			reasoningContent.innerText = "Thinking...\n";
		}

		let isFirstContent = true;

		await streamDashScope(
			question,
			contexts,
			settings.dashScopeApiKey,
			enableThinking,
			{
				onReasoning: (chunk) => {
					if (!enableThinking) return;
					if (reasoningContent.innerText === "Thinking...\n") reasoningContent.innerText = "";
					reasoningContent.innerText += chunk;
					this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
				},
				onContent: (chunk) => {
					if (isFirstContent && enableThinking) {
						isFirstContent = false;
					}
					aiContent.innerText += chunk;
					this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
				},
				onError: (error) => {
					const errEl = aiMsg.createEl("p", { text: `Error: ${error.message}` });
					errEl.style.color = "var(--text-error)";
				},
				onComplete: () => {
					// Done
				}
			},
			settings.aiBaseUrl,
			settings.aiModel
		);
	}
}
