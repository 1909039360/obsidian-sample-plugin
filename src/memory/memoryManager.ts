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

	constructor(app: App, getSettings: () => MyPluginSettings) {
		this.app = app;
		this.getSettings = getSettings;
		this.store = new ConversationStore();
		this.compressionService = new CompressionService();
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
		if (!settings.memoryEnabled) return;

		this.store.addTurn('user', question);
		this.store.addTurn('assistant', answer);

		if (this.store.shouldCompress(settings.maxTokensBeforeCompression, settings.maxTurnsBeforeCompression)) {
			const turnsToCompress = this.store.getTurnsToCompress(settings.recentTurnsToKeep);
			if (turnsToCompress.length > 0) {
				// Fire-and-forget; errors are caught inside CompressionService
				void this.compressionService.compress(
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
		if (!settings.memoryEnabled) return [];
		return this.store.toMessages() as AIMessage[];
	}

	/**
	 * Builds the memory context string for {{MEMORY}} substitution in system prompt.
	 */
	buildMemoryContext(): string {
		const settings = this.getSettings();
		if (!settings.memoryEnabled) return '';

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
}
