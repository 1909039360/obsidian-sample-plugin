import { ConversationTurn, LongTermMemoryEntry, LongTermMemoryTag } from './types';
import { FileSystemAdapter } from './fileSystemAdapter';
import { MyPluginSettings } from '../settings';

// ── Prompts ────────────────────────────────────────────────────────────────

const SHORT_TERM_SUMMARY_PROMPT = `你是一个对话记忆助手。请对以下对话进行简洁压缩摘要，保留核心事实、用户意图和重要结论。
输出格式：仅返回一段纯文本摘要（不超过300字），不要包含任何 JSON 或标题。`;

const LONG_TERM_EXTRACT_PROMPT = `你是一个知识提取助手。请从以下对话中提取重要的长期记忆条目。
输出格式：仅返回一个 JSON 数组，每个元素包含以下字段：
- id: 唯一标识符（字符串，建议格式：tag_时间戳）
- tag: "knowledge" | "event" | "personality"
- summary: 条目摘要（不超过100字）
- evidence: 来源说明（如"第3-5轮对话"）
- confidence: "low" | "medium" | "high"

示例：
[{"id":"knowledge_1234","tag":"knowledge","summary":"用户熟悉 TypeScript 和 Obsidian 插件开发","evidence":"第1-3轮","confidence":"high"}]

如果没有值得提取的内容，返回空数组 []。`;

const USER_PROFILE_UPDATE_PROMPT = `你是一个用户画像更新助手。根据以下「新提取的性格/偏好条目」和「当前用户画像」，生成一份更新后的完整用户画像。
输出格式：直接输出 Markdown 文本，包含以下段落（保持顺序）：
## 沟通风格偏好
## 技术偏好
## 工作习惯
## 禁忌与限制
## 长期目标

不要输出其他内容。若某段落无更新，保留原有内容。`;

// ── AI call helper (non-streaming) ────────────────────────────────────────

async function callAIOnce(
	prompt: string,
	userContent: string,
	apiKey: string,
	baseUrl: string,
	model: string
): Promise<string> {
	const response = await window.fetch(baseUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: prompt },
				{ role: 'user', content: userContent },
			],
			stream: false,
		}),
	});

	if (!response.ok) {
		throw new Error(`AI API error: ${response.status} ${response.statusText}`);
	}

	const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
	return data.choices?.[0]?.message?.content?.trim() ?? '';
}

function extractJsonArray(raw: string): unknown[] {
	const match = raw.match(/\[[\s\S]*\]/);
	if (!match) return [];
	try {
		return JSON.parse(match[0]) as unknown[];
	} catch {
		return [];
	}
}

// ── CompressionService ────────────────────────────────────────────────────

export class CompressionService {
	private isCompressing = false;

	async compress(
		turns: ConversationTurn[],
		settings: MyPluginSettings,
		fileAdapter: FileSystemAdapter,
		onSummaryReady: (summary: string, archivedTurns: ConversationTurn[]) => void
	): Promise<void> {
		if (this.isCompressing) return;
		this.isCompressing = true;

		try {
			await this.doCompress(turns, settings, fileAdapter, onSummaryReady);
		} catch (e) {
			console.error('[MemorySystem] Compression failed:', e);
		} finally {
			this.isCompressing = false;
		}
	}

	private async doCompress(
		turns: ConversationTurn[],
		settings: MyPluginSettings,
		fileAdapter: FileSystemAdapter,
		onSummaryReady: (summary: string, archivedTurns: ConversationTurn[]) => void
	): Promise<void> {
		const { dashScopeApiKey: apiKey, aiBaseUrl: baseUrl, aiModel: model } = settings;

		const dialogText = turns.map(t => `${t.role === 'user' ? '用户' : 'AI'}：${t.content}`).join('\n\n');

		// 1. Generate short-term summary
		const summary = await callAIOnce(SHORT_TERM_SUMMARY_PROMPT, dialogText, apiKey, baseUrl, model);
		if (!summary) throw new Error('Empty summary from AI');

		// Notify caller so ConversationStore can be updated synchronously
		onSummaryReady(summary, turns);

		// Archive original turns
		const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
		const archiveContent = `# Archive — ${sessionId}\n\n${dialogText}\n`;
		await fileAdapter.writeArchive(sessionId, archiveContent);

		// Update active-session.md
		const ts = new Date().toLocaleString('zh-CN');
		await fileAdapter.writeFile('short-term/active-session.md',
			`# Short-term Memory — Active Session\n\n_Last compressed: ${ts}_\n\n## Summary\n\n${summary}\n`
		);

		// 2. Extract long-term memory entries
		const rawEntries = await callAIOnce(LONG_TERM_EXTRACT_PROMPT, dialogText, apiKey, baseUrl, model);
		const parsed = extractJsonArray(rawEntries) as Partial<LongTermMemoryEntry>[];

		const validEntries: LongTermMemoryEntry[] = parsed
			.filter(e => e.id && e.tag && e.summary)
			.map(e => ({
				id: e.id!,
				tag: e.tag as LongTermMemoryTag,
				summary: e.summary!,
				evidence: e.evidence ?? '',
				confidence: e.confidence ?? 'medium',
				updatedAt: Date.now(),
			}));

		if (validEntries.length > 0) {
			await this.updateLongTermMemory(validEntries, fileAdapter);

			const personalityEntries = validEntries.filter(e => e.tag === 'personality');
			if (personalityEntries.length > 0) {
				await this.updateUserProfile(personalityEntries, settings, fileAdapter);
			}
		}

		await fileAdapter.updateIndex();
	}

	// ── Long-term memory ──────────────────────────────────────────────────

	private async updateLongTermMemory(
		entries: LongTermMemoryEntry[],
		fileAdapter: FileSystemAdapter
	): Promise<void> {
		const byTag: Record<LongTermMemoryTag, LongTermMemoryEntry[]> = {
			knowledge: [],
			event: [],
			personality: [],
		};
		for (const e of entries) {
			byTag[e.tag].push(e);
		}

		const fileMap: Record<LongTermMemoryTag, string> = {
			knowledge: 'long-term/knowledge.md',
			event: 'long-term/events.md',
			personality: 'long-term/personality.md',
		};

		for (const tag of Object.keys(byTag) as LongTermMemoryTag[]) {
			if (byTag[tag].length === 0) continue;
			const filePath = fileMap[tag];
			const existing = await fileAdapter.readFile(filePath);
			let content = existing || `# Long-term Memory — ${tag}\n\n`;

			for (const entry of byTag[tag]) {
				const marker = `<!-- id:${entry.id} -->`;
				const block = `${marker}\n### ${entry.summary}\n- **Evidence**: ${entry.evidence}\n- **Confidence**: ${entry.confidence}\n- **Updated**: ${new Date(entry.updatedAt).toLocaleString('zh-CN')}\n\n`;

				if (content.includes(marker)) {
					// Update existing entry
					content = content.replace(new RegExp(`${marker}[\\s\\S]*?(?=<!--|$)`), block);
				} else {
					content += block;
				}
			}

			await fileAdapter.writeFile(filePath, content);
		}
	}

	// ── User profile ──────────────────────────────────────────────────────

	private async updateUserProfile(
		personalityEntries: LongTermMemoryEntry[],
		settings: MyPluginSettings,
		fileAdapter: FileSystemAdapter
	): Promise<void> {
		const { dashScopeApiKey: apiKey, aiBaseUrl: baseUrl, aiModel: model } = settings;

		const currentProfile = await fileAdapter.readFile('profile/user-profile.md');
		const newEntries = personalityEntries.map(e => `- ${e.summary}`).join('\n');

		const userContent = `【新提取的性格/偏好条目】\n${newEntries}\n\n【当前用户画像】\n${currentProfile || '（暂无）'}`;
		const updatedProfile = await callAIOnce(USER_PROFILE_UPDATE_PROMPT, userContent, apiKey, baseUrl, model);
		if (!updatedProfile) return;

		const ts = new Date().toLocaleString('zh-CN');
		await fileAdapter.writeFile('profile/user-profile.md', `# User Profile\n\n${updatedProfile}\n\n_Last updated: ${ts}_\n`);
	}
}
