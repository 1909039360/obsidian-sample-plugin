import { ConversationTurn } from './types';
import { estimateTokens } from './tokenEstimator';

export class ConversationStore {
	private turns: ConversationTurn[] = [];
	private totalTokens = 0;
	private summaryPrefix = '';

	addTurn(role: 'user' | 'assistant', content: string): ConversationTurn {
		const turn: ConversationTurn = {
			role,
			content,
			createdAt: Date.now(),
			estimatedTokens: estimateTokens(content),
			turnIndex: this.turns.length,
		};
		this.turns.push(turn);
		this.totalTokens += turn.estimatedTokens;
		return turn;
	}

	shouldCompress(maxTokens: number, maxTurns: number): boolean {
		const userTurns = this.turns.filter(t => t.role === 'user').length;
		return this.totalTokens > maxTokens || userTurns > maxTurns;
	}

	/** Returns full turns array (excluding already-summarized turns that were replaced). */
	getAllTurns(): ConversationTurn[] {
		return [...this.turns];
	}

	getRecentTurns(n: number): ConversationTurn[] {
		return this.turns.slice(-n * 2); // n user + n assistant ≈ 2n turns
	}

	/** Turns that will be compressed: everything except the last recentN round-trips. */
	getTurnsToCompress(recentN: number): ConversationTurn[] {
		const keepCount = recentN * 2;
		return this.turns.slice(0, Math.max(0, this.turns.length - keepCount));
	}

	/**
	 * Replace the conversation window with a summary block + the most recent N round-trips.
	 * Returns the original turns that were replaced (for archiving).
	 */
	replaceTurnsWithSummary(summary: string, recentN: number): ConversationTurn[] {
		const keepCount = recentN * 2;
		const toArchive = this.turns.slice(0, Math.max(0, this.turns.length - keepCount));
		const toKeep = this.turns.slice(-keepCount);

		this.summaryPrefix = summary;
		this.turns = toKeep;
		this.totalTokens = estimateTokens(summary) + toKeep.reduce((sum, t) => sum + t.estimatedTokens, 0);
		return toArchive;
	}

	getSummaryPrefix(): string {
		return this.summaryPrefix;
	}

	setSummaryPrefix(summary: string): void {
		this.summaryPrefix = summary;
		this.totalTokens = estimateTokens(summary) + this.turns.reduce((sum, t) => sum + t.estimatedTokens, 0);
	}

	getTotalTokens(): number {
		return this.totalTokens;
	}

	getTurnCount(): number {
		return this.turns.filter(t => t.role === 'user').length;
	}

	/** Build a messages array suitable for passing to the AI API. */
	toMessages(): Array<{ role: string; content: string }> {
		const messages: Array<{ role: string; content: string }> = [];

		if (this.summaryPrefix) {
			messages.push({ role: 'system', content: `[对话记忆摘要]\n${this.summaryPrefix}` });
		}

		for (const turn of this.turns) {
			messages.push({ role: turn.role, content: turn.content });
		}

		return messages;
	}

	clear(): void {
		this.turns = [];
		this.totalTokens = 0;
		this.summaryPrefix = '';
	}
}
