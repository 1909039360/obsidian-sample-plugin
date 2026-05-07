import { App, Notice, normalizePath } from "obsidian";
import {
	compressDashScopeMemory,
	type MemoryCompressionResult,
} from "./ai";
import {
	DEFAULT_MEMORY_RECENT_ROUNDS,
	DEFAULT_USER_PROFILE_CONFIDENCE_THRESHOLD,
	type LongTermMemoryEntry,
	type MemoryRound,
	type MemoryState,
	type UserProfileEntry,
} from "./memoryTypes";

interface MemoryServiceOptions {
	app: App;
	pluginId: string;
	getApiKey: () => string;
	getState: () => MemoryState;
	saveState: (state: MemoryState) => Promise<void>;
}

interface ProfileMergeResult {
	acceptedEntries: UserProfileEntry[];
	rejectedEntries: Array<{ key: string; summary: string; confidence: number }>;
}

function normalizeMemoryKey(key: string): string {
	return key.trim().toLowerCase();
}

export function buildMemoryContext(state: MemoryState): string {
	const sections: string[] = [];

	if (state.shortTermSummary.trim()) {
		sections.push(`## 历史压缩摘要\n${state.shortTermSummary.trim()}`);
	}

	if (state.longTermMemories.length > 0) {
		sections.push([
			"## 长期记忆",
			...state.longTermMemories.map((entry) => `- ${entry.key}: ${entry.summary}`),
		].join("\n"));
	}

	if (state.userProfile.length > 0) {
		sections.push([
			"## 用户画像",
			...state.userProfile.map((entry) => `- ${entry.key}: ${entry.summary}`),
		].join("\n"));
	}

	if (state.recentRounds.length > 0) {
		sections.push([
			"## 最近对话",
			...state.recentRounds.map((round, index) => [
				`### 第 ${index + 1} 轮`,
				`用户：${round.question}`,
				`助手：${round.answer}`,
			].join("\n")),
		].join("\n\n"));
	}

	return sections.join("\n\n").trim();
}

function mergeLongTermMemories(
	existingEntries: LongTermMemoryEntry[],
	incomingEntries: Array<{ key: string; summary: string }>,
	timestamp: string,
): LongTermMemoryEntry[] {
	const merged = new Map(
		existingEntries.map((entry) => [normalizeMemoryKey(entry.key), entry] as const),
	);

	for (const entry of incomingEntries) {
		const key = entry.key.trim();
		const summary = entry.summary.trim();
		if (!key || !summary) {
			continue;
		}

		merged.set(normalizeMemoryKey(key), {
			key,
			summary,
			updatedAt: timestamp,
		});
	}

	return Array.from(merged.values());
}

function mergeUserProfileEntries(
	existingEntries: UserProfileEntry[],
	incomingEntries: Array<{ key: string; summary: string; confidence: number }>,
	timestamp: string,
): ProfileMergeResult {
	const merged = new Map(
		existingEntries.map((entry) => [normalizeMemoryKey(entry.key), entry] as const),
	);
	const rejectedEntries: Array<{ key: string; summary: string; confidence: number }> = [];

	for (const entry of incomingEntries) {
		const key = entry.key.trim();
		const summary = entry.summary.trim();
		const confidence = entry.confidence;
		if (!key || !summary) {
			continue;
		}

		if (confidence < DEFAULT_USER_PROFILE_CONFIDENCE_THRESHOLD) {
			rejectedEntries.push({ key, summary, confidence });
			continue;
		}

		merged.set(normalizeMemoryKey(key), {
			key,
			summary,
			confidence,
			updatedAt: timestamp,
		});
	}

	return {
		acceptedEntries: Array.from(merged.values()),
		rejectedEntries,
	};
}

function createCompressionLogContent(
	timestamp: string,
	compressedRounds: MemoryRound[],
	stateAfterCompression: MemoryState,
	compressionResult: MemoryCompressionResult | null,
	rejectedProfileEntries: Array<{ key: string; summary: string; confidence: number }>,
	error: Error | null,
): string {
	const retainedRounds = stateAfterCompression.recentRounds
		.map((round) => `- ${round.createdAt}: ${round.question}`)
		.join("\n");
	const compressedRoundLines = compressedRounds
		.map((round) => [
			`### ${round.createdAt}`,
			`- 问题: ${round.question}`,
			`- 回答: ${round.answer}`,
		].join("\n"))
		.join("\n\n");
	const longTermLines = stateAfterCompression.longTermMemories
		.map((entry) => `- ${entry.key}: ${entry.summary}`)
		.join("\n");
	const profileLines = stateAfterCompression.userProfile
		.map((entry) => `- ${entry.key} (${entry.confidence.toFixed(2)}): ${entry.summary}`)
		.join("\n");
	const rejectedProfileLines = rejectedProfileEntries
		.map((entry) => `- ${entry.key} (${entry.confidence.toFixed(2)}): ${entry.summary}`)
		.join("\n");

	return [
		"# Memory compression task log",
		`- Time: ${timestamp}`,
		`- Status: ${error ? "failed" : "success"}`,
		`- Compressed rounds: ${compressedRounds.length}`,
		`- Retained recent rounds: ${stateAfterCompression.recentRounds.length}`,
		error ? `- Error: ${error.message}` : "",
		"",
		"## Short-term summary",
		stateAfterCompression.shortTermSummary || "(empty)",
		"",
		"## Compressed rounds",
		compressedRoundLines || "(none)",
		"",
		"## Recent rounds kept",
		retainedRounds || "(none)",
		"",
		"## Long-term memory",
		longTermLines || "(none)",
		"",
		"## User profile",
		profileLines || "(none)",
		"",
		"## Rejected low-confidence profile entries",
		rejectedProfileLines || "(none)",
		"",
		"## Raw compression result",
		compressionResult ? JSON.stringify(compressionResult, null, 2) : "(none)",
	]
		.filter((line) => line !== "")
		.join("\n");
}

export class MemoryService {
	private readonly app: App;
	private readonly pluginId: string;
	private readonly getApiKey: () => string;
	private readonly getState: () => MemoryState;
	private readonly saveState: (state: MemoryState) => Promise<void>;
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(options: MemoryServiceOptions) {
		this.app = options.app;
		this.pluginId = options.pluginId;
		this.getApiKey = options.getApiKey;
		this.getState = options.getState;
		this.saveState = options.saveState;
	}

	buildPromptContext(): string {
		return buildMemoryContext(this.getState());
	}

	recordConversation(question: string, answer: string): Promise<void> {
		const trimmedQuestion = question.trim();
		const trimmedAnswer = answer.trim();
		if (!trimmedQuestion || !trimmedAnswer) {
			return Promise.resolve();
		}

		const run = async () => {
			const currentState = this.getState();
			const nextState: MemoryState = {
				...currentState,
				recentRounds: [
					...currentState.recentRounds,
					{
						id: crypto.randomUUID(),
						createdAt: new Date().toISOString(),
						question: trimmedQuestion,
						answer: trimmedAnswer,
					},
				],
			};
			await this.saveState(nextState);

			if (nextState.recentRounds.length <= DEFAULT_MEMORY_RECENT_ROUNDS) {
				return;
			}

			await this.compressHistory(nextState);
		};

		const queuedRun = this.operationQueue.then(run);
		this.operationQueue = queuedRun.catch(() => undefined);
		return queuedRun;
	}

	private async compressHistory(stateBeforeCompression: MemoryState): Promise<void> {
		const apiKey = this.getApiKey().trim();
		if (!apiKey) {
			return;
		}

		const retainedRounds = stateBeforeCompression.recentRounds.slice(
			-DEFAULT_MEMORY_RECENT_ROUNDS,
		);
		const compressedRounds = stateBeforeCompression.recentRounds.slice(
			0,
			Math.max(0, stateBeforeCompression.recentRounds.length - DEFAULT_MEMORY_RECENT_ROUNDS),
		);
		if (compressedRounds.length === 0) {
			return;
		}

		const timestamp = new Date().toISOString();
		let compressionResult: MemoryCompressionResult | null = null;
		let rejectedProfileEntries: Array<{ key: string; summary: string; confidence: number }> = [];
		let error: Error | null = null;
		let stateAfterCompression: MemoryState = {
			...stateBeforeCompression,
			recentRounds: retainedRounds,
		};

		try {
			compressionResult = await compressDashScopeMemory({
				apiKey,
				previousSummary: stateBeforeCompression.shortTermSummary,
				rounds: compressedRounds,
				longTermMemories: stateBeforeCompression.longTermMemories,
				userProfile: stateBeforeCompression.userProfile,
			});

			const mergedLongTermMemories = mergeLongTermMemories(
				stateBeforeCompression.longTermMemories,
				compressionResult.longTermMemories,
				timestamp,
			);
			const mergedUserProfile = mergeUserProfileEntries(
				stateBeforeCompression.userProfile,
				compressionResult.userProfile,
				timestamp,
			);
			rejectedProfileEntries = mergedUserProfile.rejectedEntries;

			stateAfterCompression = {
				shortTermSummary:
					compressionResult.shortTermSummary.trim()
					|| stateBeforeCompression.shortTermSummary,
				recentRounds: retainedRounds,
				longTermMemories: mergedLongTermMemories,
				userProfile: mergedUserProfile.acceptedEntries,
				lastCompressionAt: timestamp,
			};
			await this.saveState(stateAfterCompression);
		} catch (caughtError) {
			error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
			new Notice(`AI 记忆压缩失败：${error.message}`);
		}

		await this.writeCompressionLog(
			timestamp,
			compressedRounds,
			stateAfterCompression,
			compressionResult,
			rejectedProfileEntries,
			error,
		);
	}

	private async writeCompressionLog(
		timestamp: string,
		compressedRounds: MemoryRound[],
		stateAfterCompression: MemoryState,
		compressionResult: MemoryCompressionResult | null,
		rejectedProfileEntries: Array<{ key: string; summary: string; confidence: number }>,
		error: Error | null,
	): Promise<void> {
		const logsFolder = normalizePath(
			`${this.app.vault.configDir}/plugins/${this.pluginId}/task-logs`,
		);
		await this.ensureFolder(logsFolder);

		const filePath = normalizePath(
			`${logsFolder}/memory-compression-${timestamp.replace(/:/g, "-")}.md`,
		);
		const content = createCompressionLogContent(
			timestamp,
			compressedRounds,
			stateAfterCompression,
			compressionResult,
			rejectedProfileEntries,
			error,
		);
		await this.app.vault.create(filePath, content);
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const segments = folderPath.split("/").filter(Boolean);
		let currentPath = "";

		for (const segment of segments) {
			currentPath = currentPath ? `${currentPath}/${segment}` : segment;
			if (this.app.vault.getAbstractFileByPath(currentPath)) {
				continue;
			}

			await this.app.vault.createFolder(currentPath);
		}
	}
}
