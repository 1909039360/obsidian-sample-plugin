import {App, PluginSettingTab, Setting} from "obsidian";
import MyPlugin from "./main";
import type { DocumentContextItem } from "./documentContext/types";

export interface NamedPrompt {
	id: string;
	name: string;
	content: string;
}

export interface MyPluginSettings {
	mySetting: string;
	collapseByDefault: boolean;
	dashScopeApiKey: string;
	enableThinking: boolean;
	aiBaseUrl: string;
	aiModel: string;
	customPrompts: string[];
	
	// Legacy
	systemPromptTemplate: string;
	
	// New named prompts
	savedSystemPrompts: NamedPrompt[];
	activeSystemPromptId: string;
	
	savedSoulPrompts: NamedPrompt[];
	activeSoulPromptId: string;

	// PDF → Markdown (PaddleOCR)
	paddleOcrToken: string;

	// Memory system
	memoryEnabled: boolean;
	memoryActive: boolean;
	memoryDirectory: string;
	maxTokensBeforeCompression: number;
	maxTurnsBeforeCompression: number;
	recentTurnsToKeep: number;
	documentContextHistoryLimit: number;
	documentContextFocusMode: boolean;
	lastDocumentContextSnapshot: DocumentContextItem[];
	documentContextFileUsage: Record<string, number>;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	collapseByDefault: false,
	dashScopeApiKey: '',
	enableThinking: false,
	aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
	aiModel: 'deepseek-v4-flash',
	customPrompts: [],
	
	systemPromptTemplate: "你是一个强大的 AI 助手。\n\n{{CONTEXT}}\n\n请回答用户的问题。要求：\n1. 返回的内容为 Markdown 格式\n2. 最大标题级别为3 (###)",
	
	savedSystemPrompts: [
		{
			id: 'default-system-prompt',
			name: '默认系统提示词',
			content: "你是一个强大的 AI 助手。\n\n{{CONTEXT}}\n\n请回答用户的问题。要求：\n1. 返回的内容为 Markdown 格式\n2. 最大标题级别为3 (###)"
		}
	],
	activeSystemPromptId: 'default-system-prompt',
	
	savedSoulPrompts: [],
	activeSoulPromptId: '',

	// PDF → Markdown (PaddleOCR)
	paddleOcrToken: '',

	// Memory system
	memoryEnabled: true,
	memoryActive: true,
	memoryDirectory: 'memory',
	maxTokensBeforeCompression: 100000,
	maxTurnsBeforeCompression: 10,
	recentTurnsToKeep: 4,
	documentContextHistoryLimit: 5,
	documentContextFocusMode: true,
	lastDocumentContextSnapshot: [],
	documentContextFileUsage: {},
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// ── 代码块 ──────────────────────────────────────────────────
		new Setting(containerEl).setName('代码块').setHeading();

		new Setting(containerEl)
			.setName('默认折叠代码块')
			.setDesc('开启后，所有代码块默认以折叠状态显示（重新打开文件后生效）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.collapseByDefault)
				.onChange(async (value) => {
					this.plugin.settings.collapseByDefault = value;
					await this.plugin.saveSettings();
				}));

		// ── AI 配置 ──────────────────────────────────────────────────
		new Setting(containerEl).setName('AI 配置').setHeading();

		new Setting(containerEl)
			.setName('API key')
			.setDesc('用于 AI 问答的 API key（兼容 OpenAI Chat Completions 格式）')
			.addText(text => text
				.setPlaceholder('在此处粘贴 sk-*** 开头的 API key')
				.setValue(this.plugin.settings.dashScopeApiKey)
				.onChange(async (value) => {
					this.plugin.settings.dashScopeApiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API base URL')
			.setDesc('兼容 OpenAI Chat Completions 接口的完整请求地址。默认使用阿里云 DashScope。')
			.addText(text => {
				text.inputEl.addClass('cbf-wide-input');
				text
					.setPlaceholder(DEFAULT_SETTINGS.aiBaseUrl)
					.setValue(this.plugin.settings.aiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.aiBaseUrl = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Model name')
			.setDesc('调用的大模型标识，例如 deepseek-v4-flash、gpt-4o 等。')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.aiModel)
				.setValue(this.plugin.settings.aiModel)
				.onChange(async (value) => {
					this.plugin.settings.aiModel = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('启用思考模式 (enable thinking)')
			.setDesc('开启后，大模型将展示思考过程（如 DeepSeek-R1 的思考链）。默认关闭。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableThinking)
				.onChange(async (value) => {
					this.plugin.settings.enableThinking = value;
					await this.plugin.saveSettings();
				}));

		// ── 自定义提示词 ────────────────────────────────────────────────
		new Setting(containerEl).setName('自定义提示词 (Prompts)').setHeading();

		new Setting(containerEl)
			.setName('系统提示词 (System Prompt)')
			.setDesc('AI 会话中使用的系统级指令，可使用 {{CONTEXT}}、{{ACTIVE_CONTEXT}}、{{DOCUMENT_CONTEXT}}、{{MEMORY}} 占位符。')
			.addTextArea(text => {
				text.inputEl.addClass('cbf-prompts-textarea');
				text.inputEl.rows = 8;
				text
					.setPlaceholder(DEFAULT_SETTINGS.systemPromptTemplate)
					.setValue(this.plugin.settings.systemPromptTemplate)
					.onChange(async (value) => {
						this.plugin.settings.systemPromptTemplate = value.trim();
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl('p', {
			text: '在此处添加常用的用户级自定义命令提示词，它们将出现在 //// 快捷输入的建议列表顶部。每行一条。',
			cls: 'setting-item-description',
		});

		const promptsTextarea = containerEl.createEl('textarea', {
			cls: 'cbf-prompts-textarea',
		});
		promptsTextarea.value = this.plugin.settings.customPrompts.join('\n');
		promptsTextarea.rows = 6;
		promptsTextarea.addEventListener('change', () => {
			this.plugin.settings.customPrompts = promptsTextarea.value
				.split('\n')
				.map(line => line.trim())
				.filter(line => line.length > 0);
			void this.plugin.saveSettings();
		});

		// ── PDF → Markdown ────────────────────────────────────────────────
		new Setting(containerEl).setName('PDF 转 Markdown (PaddleOCR)').setHeading();

		new Setting(containerEl)
			.setName('PaddleOCR API Token')
			.setDesc('用于 PDF → Markdown OCR 转换的 API Token（右键 PDF 文件即可触发转换）')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('在此粘贴 PaddleOCR token')
					.setValue(this.plugin.settings.paddleOcrToken)
					.onChange(async (value) => {
						this.plugin.settings.paddleOcrToken = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// ── 记忆系统 ────────────────────────────────────────────────────────
		new Setting(containerEl).setName('记忆系统').setHeading();

		new Setting(containerEl)
			.setName('启用记忆系统')
			.setDesc('开启后，AI 对话历史将自动存储、压缩，并注入到后续对话的上下文中。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.memoryEnabled)
				.onChange(async (value) => {
					this.plugin.settings.memoryEnabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('记忆存储目录')
			.setDesc('相对于 Vault 根目录的路径，用于存放所有记忆 Markdown 文件。')
			.addText(text => text
				.setPlaceholder('memory')
				.setValue(this.plugin.settings.memoryDirectory)
				.onChange(async (value) => {
					this.plugin.settings.memoryDirectory = value.trim() || 'memory';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('触发压缩的 Token 上限')
			.setDesc('对话累积 Token 估算值超过此阈值时，后台自动触发压缩。')
			.addText(text => text
				.setPlaceholder('100000')
				.setValue(String(this.plugin.settings.maxTokensBeforeCompression))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.maxTokensBeforeCompression = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('触发压缩的对话轮次上限')
			.setDesc('用户发送消息轮次超过此值时，后台自动触发压缩。')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.maxTurnsBeforeCompression))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.maxTurnsBeforeCompression = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('压缩后保留的最近轮次数')
			.setDesc('压缩后短期窗口中保留的最近对话轮次（每轮包含问 + 答）。')
			.addText(text => text
				.setPlaceholder('4')
				.setValue(String(this.plugin.settings.recentTurnsToKeep))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.plugin.settings.recentTurnsToKeep = num;
						await this.plugin.saveSettings();
					}
				}));
	}
}
