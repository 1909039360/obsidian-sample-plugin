import { Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo, Notice, TFile, type App } from "obsidian";
import {
	buildContextFromMarker,
	buildDocumentContextForHeadingPath,
	buildDocumentMarker,
	getMarkdownFilesInFolder,
	parseDocumentMarkersFromLine,
	resolveHeadingChildren,
	resolveShortcutContexts,
} from "./navigation";
import { DocumentContextStore } from "./store";
import type { DocumentContextItem, DocumentMarker, DocumentSuggestItem, DocumentSuggestShortcutItem } from "./types";

const SHORTCUTS: DocumentSuggestShortcutItem[] = [
	{ kind: "shortcut", shortcut: "current", label: "@current", description: "恢复上次对话的 Document Contexts" },
	{ kind: "shortcut", shortcut: "next", label: "@next", description: "跳到上一轮一级标题的下一章" },
	{ kind: "shortcut", shortcut: "pre", label: "@pre", description: "跳到上一轮一级标题的上一章" },
	{ kind: "shortcut", shortcut: "next1", label: "@next1", description: "跳到上一轮二级标题的下一小节" },
	{ kind: "shortcut", shortcut: "pre1", label: "@pre1", description: "跳到上一轮二级标题的上一小节" },
];

export class DocumentContextSuggest extends EditorSuggest<DocumentSuggestItem> {
	private activeFile: TFile | null = null;
	private readonly store: DocumentContextStore;
	private static readonly DOCUMENT_TRIGGER_PATTERN = /(?:^|\s|\]|\/\/)@([^\s@]*)$/;
	private static readonly INLINE_PROMPT_TRIGGER_PATTERN = /\/\/.*@([^\s@]*)$/;

	constructor(app: App, store: DocumentContextStore) {
		super(app);
		this.store = store;
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile): EditorSuggestTriggerInfo | null {
		this.activeFile = file;
		const line = editor.getLine(cursor.line);
		const prefix = line.substring(0, cursor.ch);
		const suffix = line.substring(cursor.ch);
		const match = prefix.match(DocumentContextSuggest.DOCUMENT_TRIGGER_PATTERN);
		const inlinePromptMatch = suffix.startsWith("//")
			? prefix.match(DocumentContextSuggest.INLINE_PROMPT_TRIGGER_PATTERN)
			: null;
		const resolvedMatch = match ?? inlinePromptMatch;
		if (!resolvedMatch) {
			return null;
		}

		const startIndex = prefix.lastIndexOf("@");
		return {
			start: { line: cursor.line, ch: startIndex },
			end: cursor,
			query: resolvedMatch[1] ?? "",
		};
	}

	async getSuggestions(context: EditorSuggestContext): Promise<DocumentSuggestItem[]> {
		if (!this.activeFile) {
			return [];
		}

		const query = context.query.toLowerCase();
		const linePrefix = context.editor.getLine(context.start.line).slice(0, context.start.ch);
		const markers = parseDocumentMarkersFromLine(linePrefix);
		const lastMarker = markers[markers.length - 1] ?? null;

		const suggestions: DocumentSuggestItem[] = [...SHORTCUTS];
		if (!lastMarker) {
			suggestions.push(
				...getMarkdownFilesInFolder(this.app, this.activeFile).map((file) => ({
					kind: "file" as const,
					file,
					label: file.name,
					description: file.path,
				}))
			);
		} else {
			const file = getMarkdownFilesInFolder(this.app, this.activeFile).find((item) => item.name === lastMarker.fileName);
			if (file) {
				const children = await resolveHeadingChildren(this.app, file, lastMarker.titlePath);
				suggestions.push(
					...children.map((heading) => ({
						kind: "heading" as const,
						file,
						heading,
						label: heading.title,
						description: `${file.name} · ${heading.pathTitles.join(" > ")}`,
					}))
				);
			}
		}

		if (!query) {
			return suggestions;
		}

		return suggestions.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query));
	}

	renderSuggestion(value: DocumentSuggestItem, el: HTMLElement): void {
		el.empty();
		el.createEl("div", { text: value.label, cls: "ai-doc-suggest-title" });
		el.createEl("small", { text: value.description, cls: "ai-doc-suggest-desc" });
	}

	selectSuggestion(value: DocumentSuggestItem): void {
		void this.applySuggestion(value);
	}

	private async applySuggestion(value: DocumentSuggestItem): Promise<void> {
		const activeContext = this.context;
		if (!activeContext || !this.activeFile) {
			return;
		}

		const line = activeContext.editor.getLine(activeContext.start.line);
		const markers = parseDocumentMarkersFromLine(line);
		const previousMarker = markers.filter((marker) => marker.end <= activeContext.start.ch).pop() ?? null;
		let items: DocumentContextItem[] = [];

		if (value.kind === "shortcut") {
			const shortcutBaseItems = await this.resolveShortcutBaseItems(previousMarker, activeContext.editor.getCursor().line);
			items = await resolveShortcutContexts(this.app, this.activeFile, value.shortcut, shortcutBaseItems);
		} else if (value.kind === "file") {
			items = [await buildContextFromMarker(this.app, this.activeFile, {
				raw: `@doc[${value.file.name}]`,
				fileName: value.file.name,
				titlePath: [],
				start: activeContext.start.ch,
				end: activeContext.end.ch,
			}, activeContext.editor.getCursor().line) as DocumentContextItem];
		} else {
			items = [await buildDocumentContextForHeadingPath(this.app, value.file, value.heading.pathTitles)];
		}

		if (items.length === 0) {
			new Notice("未找到可用的文档上下文。");
			return;
		}

		if (value.kind === "shortcut") {
			this.store.setSelectedItems(items);
		} else {
			const firstItem = items[0];
			if (!firstItem) {
				return;
			}
			this.store.select(firstItem);
		}

		this.store.setLastConversationSnapshot(items);

		this.replaceMarkersInEditor(activeContext.editor, activeContext.start, activeContext.end, items, previousMarker);
		new Notice(`已选择 ${items.length} 条文档上下文`);
	}

	private async resolveShortcutBaseItems(previousMarker: DocumentMarker | null, cursorLine: number): Promise<DocumentContextItem[]> {
		if (previousMarker && this.activeFile) {
			const markerItem = await buildContextFromMarker(
				this.app,
				this.activeFile,
				previousMarker,
				cursorLine,
				this.store.getLastConversationSnapshot()
			);
			if (markerItem) {
				return [markerItem];
			}
		}

		const selectedItems = this.store.getSelectedItems();
		if (selectedItems.length > 0) {
			return selectedItems;
		}

		return this.store.getLastConversationSnapshot();
	}

	private replaceMarkersInEditor(
		editor: Editor,
		start: EditorPosition,
		end: EditorPosition,
		items: DocumentContextItem[],
		previousMarker: DocumentMarker | null
	): void {
		const markerText = items.map((item) => buildDocumentMarker(item)).join(" ");
		const insertedText = `${markerText} `;
		if (previousMarker) {
			editor.replaceRange("", start, end);
			editor.replaceRange(insertedText, { line: start.line, ch: previousMarker.start }, { line: start.line, ch: previousMarker.end });
			editor.setCursor({ line: start.line, ch: previousMarker.start + insertedText.length });
			return;
		}

		editor.replaceRange(insertedText, start, end);
		editor.setCursor({ line: start.line, ch: start.ch + insertedText.length });
	}
}