export type LongTermMemoryTag = 'knowledge' | 'event' | 'personality';
export type ConfidenceLevel = 'low' | 'medium' | 'high';

export interface ConversationTurn {
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
	estimatedTokens: number;
	turnIndex: number;
}

export interface LongTermMemoryEntry {
	id: string;
	tag: LongTermMemoryTag;
	summary: string;
	evidence: string;
	confidence: ConfidenceLevel;
	updatedAt: number;
}

export interface UserProfile {
	communicationStyle: string;
	techPreferences: string;
	workHabits: string;
	restrictions: string;
	longTermGoals: string;
	updatedAt: number;
}

export interface MemorySettings {
	memoryEnabled: boolean;
	memoryDirectory: string;
	maxTokensBeforeCompression: number;
	maxTurnsBeforeCompression: number;
	recentTurnsToKeep: number;
}
