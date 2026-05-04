import { App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, TFile } from 'obsidian';
import { MyPluginSettings } from './settings';

const BUILTIN_PROMPTS = [
	"总结这段文字",
	"解释这段代码",
	"重构这段代码",
	"提取主要观点",
	"把这段代码翻译成 Python",
	"修复代码里的 Bug",
	"为这段代码添加注释",
	"找出这段代码的性能瓶颈"
];

export class AIPromptSuggest extends EditorSuggest<string> {
	private readonly getSettings: () => MyPluginSettings;

	constructor(app: App, getSettings: () => MyPluginSettings) {
		super(app);
		this.getSettings = getSettings;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line);
		const prefix = line.substring(0, cursor.ch);
		const suffix = line.substring(cursor.ch);

		// 匹配：游标前是以 // 开始，且中间不包含 /
		const match = prefix.match(/\/\/([^/]*)$/);
		if (match) {
			// 确保游标后紧跟着也是 // 从而匹配我们 //// 的环境
			if (suffix.startsWith('//')) {
				return {
					start: { line: cursor.line, ch: match.index! + 2 }, // query 的起始位置 (即前置 // 的后面)
					end: cursor, // query 结束在游标处
					query: match[1] || "" // 确保不为 undefined
				};
			}
		}
		return null;
	}

	getSuggestions(context: EditorSuggestContext): string[] {
		const customPrompts = this.getSettings().customPrompts ?? [];
		// 自定义提示词排在前面，再跟内置提示词（去重）
		const allPrompts = [
			...customPrompts,
			...BUILTIN_PROMPTS.filter(p => !customPrompts.includes(p)),
		];

		const query = context.query.toLowerCase();
		// 如果用户没输入任何东西（刚打出 //// 的时候），显示全部
		if (!query) {
			return allPrompts;
		}
		// 否则根据输入进行过滤
		return allPrompts.filter(prompt => prompt.toLowerCase().includes(query));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		// 简单的渲染
		el.setText(value);
	}

	selectSuggestion(value: string, evt: MouseEvent | KeyboardEvent): void {
		if (this.context) {
			const { editor, start, end } = this.context;
			// 用选中的文字替换掉原来的查询输入
			editor.replaceRange(value, start, end);
		}
	}
}
