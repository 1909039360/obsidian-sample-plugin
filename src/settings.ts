import {App, PluginSettingTab, Setting} from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	mySetting: string;
	collapseByDefault: boolean;
	dashScopeApiKey: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	collapseByDefault: false,
	dashScopeApiKey: ''
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

		new Setting(containerEl)
			.setName('默认折叠代码块')
			.setDesc('开启后，所有代码块默认以折叠状态显示（重新打开文件后生效）')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.collapseByDefault)
				.onChange(async (value) => {
					this.plugin.settings.collapseByDefault = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('DashScope API Key')
			.setDesc('阿里云百炼 (DashScope) API Key，用于 AI 问答')
			.addText(text => text
				.setPlaceholder('sk-1ed436ba5b3f4d0c9ab32af1ac4788bc')
				.setValue(this.plugin.settings.dashScopeApiKey)
				.onChange(async (value) => {
					this.plugin.settings.dashScopeApiKey = value;
					await this.plugin.saveSettings();
				}));
	}
}
