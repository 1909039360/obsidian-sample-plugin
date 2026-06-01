import { App } from 'obsidian';
import { MyPluginSettings } from '../settings';
import { ConversationStore } from './conversationStore';
import { FileSystemAdapter } from './fileSystemAdapter';
import { CompressionService } from './compressionService';
import { AIMessage } from '../ai';

export class MemoryManager {
	private store: ConversationStore;
	private fileAdapter!: FileSystemAdapter;
	private compressionService: CompressionService;
	private app: App;
	private getSettings: () => MyPluginSettings;
	private active = true;
	private listeners: Array<() => void> = [];

	constructor(app: App, getSettings: () => MyPluginSettings) {
		this.app = app;
		this.getSettings = getSettings;
		this.store = new ConversationStore();
		this.compressionService = new CompressionService();
	}

	/** Set memory active state explicitly. */
	setActive(state: boolean): void {
		this.active = state;
		this.notify();
	}

	/** Toggle memory active state; returns the new state. */
	toggle(): boolean {
		this.active = !this.active;
		this.notify();
		return this.active;
	}

	isActive(): boolean {
		return this.active;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter(l => l !== listener);
		};
	}

	private notify(): void {
		this.listeners.forEach(l => l());
	}

	async init(): Promise<void> {
		const settings = this.getSettings();
		if (!settings.memoryEnabled) return;

		this.fileAdapter = new FileSystemAdapter(this.app, settings.memoryDirectory);
		await this.fileAdapter.ensureDirectories();

		// Load existing summary into store
		const existingSession = await this.fileAdapter.readFile('short-term/active-session.md');
		const summaryMatch = existingSession.match(/## Summary\n\n([\s\S]+?)(\n##|$)/);
		if (summaryMatch?.[1]) {
			this.store.setSummaryPrefix(summaryMatch[1].trim());
		}
	}

	/**
	 * Record a completed question/answer turn.
	 * Triggers background compression if thresholds are exceeded.
	 */
	async recordTurn(question: string, answer: string): Promise<void> {
		const settings = this.getSettings();
		if (!settings.memoryEnabled || !this.active) return;

		this.store.addTurn('user', question);
		this.store.addTurn('assistant', answer);

		if (this.store.shouldCompress(settings.maxTokensBeforeCompression, settings.maxTurnsBeforeCompression)) {
			const turnsToCompress = this.store.getTurnsToCompress(settings.recentTurnsToKeep);
			if (turnsToCompress.length > 0) {
				// Fire-and-forget; errors are caught inside CompressionService
				void this.compressionService.compress(
					this.app,
					turnsToCompress,
					settings,
					this.fileAdapter,
					(summary, archived) => {
						// Synchronously update the in-memory store
						this.store.replaceTurnsWithSummary(summary, settings.recentTurnsToKeep);
					}
				);
			}
		}
	}

	/**
	 * Returns the conversation history as a messages array for AI injection.
	 * Includes a summary system message at the front if one exists.
	 */
	getConversationHistory(): AIMessage[] {
		const settings = this.getSettings();
		if (!settings.memoryEnabled || !this.active) return [];
		return this.store.toMessages() as AIMessage[];
	}

	/**
	 * Builds the memory context string for {{MEMORY}} substitution in system prompt.
	 */
	buildMemoryContext(): string {
		const settings = this.getSettings();
		if (!settings.memoryEnabled || !this.active) return '';

		const parts: string[] = ['[记忆系统]'];
		const summary = this.store.getSummaryPrefix();
		if (summary) {
			parts.push(`对话摘要：\n${summary}`);
		}
		const recentTurns = this.store.getRecentTurns(settings.recentTurnsToKeep);
		if (recentTurns.length > 0) {
			const recent = recentTurns
				.map(t => `${t.role === 'user' ? '用户' : 'AI'}：${t.content}`)
				.join('\n');
			parts.push(`最近对话：\n${recent}`);
		}
		if (parts.length === 1) return '';
		return parts.join('\n\n');
	}

	/** Clear the current session's short-term memory. */
	clearSession(): void {
		this.store.clear();
	}

	isEnabled(): boolean {
		return this.getSettings().memoryEnabled;
	}

	/**
	 * Append a question/answer pair to memory/history.md.
	 * Always writes regardless of memoryEnabled setting.
	 */
	async appendToHistory(question: string, answer: string, wikiLinksText = ''): Promise<void> {
		const settings = this.getSettings();
		const dir = settings.memoryDirectory || 'memory';
		const filePath = `${dir}/history.md`;

		const now = new Date();
		const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);

		const activeSystemPromptName = settings.savedSystemPrompts?.find(p => p.id === settings.activeSystemPromptId)?.name ?? '';
		const activeSoulPromptName = settings.savedSoulPrompts?.find(p => p.id === settings.activeSoulPromptId)?.name ?? '';
		const memoryStatus = this.isActive() ? 'ON' : 'OFF';
		const enableThinking = settings.enableThinking;

		const metaParts: string[] = [
			`>**Model** \`${settings.aiModel}\` `,
			activeSystemPromptName ? `>**System** \`${activeSystemPromptName}\`` : '',
			activeSoulPromptName ? `>**Soul** \`${activeSoulPromptName}\`` : '',
			`>**Memory** \`${memoryStatus}\``,
			`>**Thinking** \`${enableThinking ? 'ON' : 'OFF'}\``,
		].filter(Boolean) as string[];
		const metaBlock = `${metaParts.join('\n')}\n`;

		// Match the editor output format exactly
		const wikiSection = wikiLinksText ? `${wikiLinksText}\n` : '\n';
		const entry = `## ${question}\n\n*${timestamp}*\n\n---\n${wikiSection}${metaBlock}\n${answer}\n\n---\n\n`;

		try {
			if (!(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.adapter.mkdir(dir);
			}

			if (!(await this.app.vault.adapter.exists(filePath))) {
				await this.app.vault.adapter.write(filePath, `# AI 问答历史\n\n${entry}`);
			} else {
				const existing = await this.app.vault.adapter.read(filePath);
				await this.app.vault.adapter.write(filePath, existing + entry);
			}
		} catch (error) {
			console.error('appendToHistory failed', error);
		}
	}
}
