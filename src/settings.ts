import {App, PluginSettingTab, Setting} from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	mySetting: string;
	collapseByDefault: boolean;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	mySetting: 'default',
	collapseByDefault: false,
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
	}
}
