import {App, PluginSettingTab, Setting} from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	mySetting: string;
	collapseByDefault: boolean;
	dashScopeApiKey: string;
	enableThinking: boolean;
	aiBaseUrl: string;
	aiModel: string;
	customPrompts: string[];
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	collapseByDefault: false,
	dashScopeApiKey: '',
	enableThinking: false,
	aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
	aiModel: 'deepseek-v4-flash',
	customPrompts: [],
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

		// ── 自定义提示词 ─────────────────────────────────────────────
		new Setting(containerEl).setName('自定义提示词').setHeading();
		containerEl.createEl('p', {
			text: '在此处添加常用的自定义提示词，它们将出现在 //// 快捷输入的建议列表顶部。每行一条。',
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
	}
}
