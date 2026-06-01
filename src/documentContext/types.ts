import type { TFile } from "obsidian";

export interface DocumentHeadingNode {
	id: string;
	filePath: string;
	title: string;
	level: number;
	startLine: number;
	endLine: number;
	parentId?: string;
	pathTitles: string[];
	children: DocumentHeadingNode[];
}

export type DocumentContextSource = "file" | "heading" | "shortcut";

export interface DocumentContextItem {
	id: string;
	filePath: string;
	fileName: string;
	titlePath: string[];
	level: number;
	content: string;
	selectedAt: number;
	source: DocumentContextSource;
}

export interface DocumentContextHistorySnapshot {
	items: DocumentContextItem[];
	createdAt: number;
	label: string;
}

export interface DocumentMarker {
	raw: string;
	fileName: string;
	titlePath: string[];
	start: number;
	end: number;
}

export type DocumentShortcut = "current" | "next" | "pre" | "next1" | "pre1";

export interface DocumentSuggestFileItem {
	kind: "file";
	file: TFile;
	label: string;
	description: string;
}

export interface DocumentSuggestHeadingItem {
	kind: "heading";
	file: TFile;
	heading: DocumentHeadingNode;
	label: string;
	description: string;
}

export interface DocumentSuggestShortcutItem {
	kind: "shortcut";
	shortcut: DocumentShortcut;
	label: string;
	description: string;
}

export type DocumentSuggestItem =
	| DocumentSuggestFileItem
	| DocumentSuggestHeadingItem
	| DocumentSuggestShortcutItem;
