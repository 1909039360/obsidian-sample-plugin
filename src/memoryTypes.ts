export const DEFAULT_MEMORY_RECENT_ROUNDS = 4;
export const DEFAULT_USER_PROFILE_CONFIDENCE_THRESHOLD = 0.75;

export interface MemoryRound {
	id: string;
	createdAt: string;
	question: string;
	answer: string;
}

export interface LongTermMemoryEntry {
	key: string;
	summary: string;
	updatedAt: string;
}

export interface UserProfileEntry {
	key: string;
	summary: string;
	confidence: number;
	updatedAt: string;
}

export interface MemoryState {
	shortTermSummary: string;
	recentRounds: MemoryRound[];
	longTermMemories: LongTermMemoryEntry[];
	userProfile: UserProfileEntry[];
	lastCompressionAt: string | null;
}

export const DEFAULT_MEMORY_STATE: MemoryState = {
	shortTermSummary: "",
	recentRounds: [],
	longTermMemories: [],
	userProfile: [],
	lastCompressionAt: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sanitizeMemoryRound(value: unknown): MemoryRound | null {
	if (!isRecord(value)) {
		return null;
	}

	const question = asString(value.question).trim();
	const answer = asString(value.answer).trim();
	if (!question || !answer) {
		return null;
	}

	return {
		id: asString(value.id) || crypto.randomUUID(),
		createdAt: asString(value.createdAt) || new Date().toISOString(),
		question,
		answer,
	};
}

function sanitizeLongTermMemoryEntry(value: unknown): LongTermMemoryEntry | null {
	if (!isRecord(value)) {
		return null;
	}

	const key = asString(value.key).trim();
	const summary = asString(value.summary).trim();
	if (!key || !summary) {
		return null;
	}

	return {
		key,
		summary,
		updatedAt: asString(value.updatedAt) || new Date().toISOString(),
	};
}

function sanitizeUserProfileEntry(value: unknown): UserProfileEntry | null {
	if (!isRecord(value)) {
		return null;
	}

	const key = asString(value.key).trim();
	const summary = asString(value.summary).trim();
	const confidence = asNumber(value.confidence);
	if (!key || !summary || confidence <= 0) {
		return null;
	}

	return {
		key,
		summary,
		confidence,
		updatedAt: asString(value.updatedAt) || new Date().toISOString(),
	};
}

export function sanitizeMemoryState(value: unknown): MemoryState {
	if (!isRecord(value)) {
		return DEFAULT_MEMORY_STATE;
	}

	const recentRounds = Array.isArray(value.recentRounds)
		? value.recentRounds
			.map(sanitizeMemoryRound)
			.filter((entry): entry is MemoryRound => entry !== null)
		: [];
	const longTermMemories = Array.isArray(value.longTermMemories)
		? value.longTermMemories
			.map(sanitizeLongTermMemoryEntry)
			.filter((entry): entry is LongTermMemoryEntry => entry !== null)
		: [];
	const userProfile = Array.isArray(value.userProfile)
		? value.userProfile
			.map(sanitizeUserProfileEntry)
			.filter((entry): entry is UserProfileEntry => entry !== null)
		: [];

	return {
		shortTermSummary: asString(value.shortTermSummary),
		recentRounds,
		longTermMemories,
		userProfile,
		lastCompressionAt: asString(value.lastCompressionAt) || null,
	};
}
