import { TFile, type App } from "obsidian";
import {
	buildDocumentContextFromFile,
	buildDocumentContextFromHeading,
	createDocumentContextId,
	findHeadingByPath,
	flattenHeadingTree,
	getChildHeadings,
	parseMarkdownHeadingTree,
	resolveDefaultDocumentContext,
} from "./parser";
import type { DocumentContextItem, DocumentHeadingNode, DocumentMarker, DocumentShortcut } from "./types";

const DOCUMENT_MARKER_PATTERN = /@doc\[([^\]]+)\]/g;

export function parseDocumentMarkersFromLine(line: string): DocumentMarker[] {
	const markers: DocumentMarker[] = [];
	const pattern = new RegExp(DOCUMENT_MARKER_PATTERN.source, "g");
	let match: RegExpExecArray | null = pattern.exec(line);
	while (match) {
		const value = match[1] ? match[1].trim() : "";
		if (!value) {
			match = pattern.exec(line);
			continue;
		}

		const parts = value
			.split(">")
			.map((part: string) => part.trim())
			.filter((part: string) => part.length > 0);
		const fileName = parts[0];
		if (!fileName) {
			match = pattern.exec(line);
			continue;
		}

		markers.push({
			raw: match[0],
			fileName,
			titlePath: parts.slice(1),
			start: match.index ?? 0,
			end: (match.index ?? 0) + match[0].length,
		});

		match = pattern.exec(line);
	}

	return markers;
}

export function buildDocumentMarker(item: DocumentContextItem): string {
	const parts = [item.fileName, ...item.titlePath];
	return `@doc[${parts.join(" > ")}]`;
}

export function stripDocumentMarkersFromText(text: string): string {
	return text.replace(DOCUMENT_MARKER_PATTERN, " ").replace(/\s{2,}/g, " ").trim();
}

export function getMarkdownFilesInFolder(app: App, activeFile: TFile): TFile[] {
	const folderPath = activeFile.parent?.path ?? "";
	return app.vault
		.getMarkdownFiles()
		.filter((file) => (file.parent?.path ?? "") === folderPath)
		.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

function resolveFileByName(app: App, activeFile: TFile, fileName: string): TFile | null {
	return getMarkdownFilesInFolder(app, activeFile).find((file) => file.name === fileName) ?? null;
}

export async function buildContextFromMarker(
	app: App,
	activeFile: TFile,
	marker: DocumentMarker,
	cursorLine: number,
	lastSnapshot: DocumentContextItem[] = []
): Promise<DocumentContextItem | null> {
	void cursorLine;
	void lastSnapshot;

	const file = resolveFileByName(app, activeFile, marker.fileName);
	if (!file) {
		return null;
	}

	const raw = await app.vault.cachedRead(file);
	if (marker.titlePath.length === 0) {
		return buildDocumentContextFromFile(file, raw);
	}

	const tree = parseMarkdownHeadingTree(raw, file.path);
	const node = findHeadingByPath(tree, marker.titlePath);
	if (!node) {
		return null;
	}

	return buildDocumentContextFromHeading(file, raw, node);
}

export async function resolveDocumentContextsFromLine(
	app: App,
	activeFile: TFile,
	line: string,
	cursorLine: number,
	lastSnapshot: DocumentContextItem[] = []
): Promise<DocumentContextItem[]> {
	const markers = parseDocumentMarkersFromLine(line);
	const resolved = await Promise.all(
		markers.map((marker) => buildContextFromMarker(app, activeFile, marker, cursorLine, lastSnapshot))
	);
	return resolved.filter((item): item is DocumentContextItem => item !== null);
}

export function mergeDocumentContexts(baseItems: DocumentContextItem[], overrideItems: DocumentContextItem[]): DocumentContextItem[] {
	const merged = new Map<string, DocumentContextItem>();
	for (const item of baseItems) {
		merged.set(item.id, item);
	}

	for (const item of overrideItems) {
		for (const existing of merged.values()) {
			if (existing.filePath === item.filePath && existing.id !== item.id) {
				merged.delete(existing.id);
			}
		}
		merged.set(item.id, item);
	}

	return Array.from(merged.values()).sort((left, right) => left.selectedAt - right.selectedAt);
}

export async function resolveHeadingChildren(app: App, file: TFile, titlePath: string[]): Promise<DocumentHeadingNode[]> {
	const raw = await app.vault.cachedRead(file);
	const tree = parseMarkdownHeadingTree(raw, file.path);
	return getChildHeadings(tree, titlePath);
}

export async function buildDocumentContextForHeadingPath(
	app: App,
	file: TFile,
	titlePath: string[]
): Promise<DocumentContextItem> {
	const raw = await app.vault.cachedRead(file);
	if (titlePath.length === 0) {
		return buildDocumentContextFromFile(file, raw);
	}

	const tree = parseMarkdownHeadingTree(raw, file.path);
	const node = findHeadingByPath(tree, titlePath);
	if (!node) {
		return {
			id: createDocumentContextId(file.path, []),
			filePath: file.path,
			fileName: file.name,
			titlePath: [],
			level: 0,
			content: raw.replace(/\r\n/g, "\n").replace(/\s+$/, ""),
			selectedAt: Date.now(),
			source: "file",
		};
	}

	return buildDocumentContextFromHeading(file, raw, node);
}

function pickSibling(nodes: DocumentHeadingNode[], current: DocumentHeadingNode, direction: -1 | 1): DocumentHeadingNode | null {
	const index = nodes.findIndex((node) => node.id === current.id);
	if (index < 0) {
		return null;
	}
	return nodes[index + direction] ?? null;
}

export async function resolveShortcutContexts(
	app: App,
	activeFile: TFile,
	shortcut: DocumentShortcut,
	lastSnapshot: DocumentContextItem[]
): Promise<DocumentContextItem[]> {
	void activeFile;

	if (shortcut === "current") {
		return lastSnapshot.map((item) => ({ ...item, selectedAt: Date.now(), source: "shortcut" }));
	}

	const lastContext = lastSnapshot[lastSnapshot.length - 1];
	if (!lastContext || lastContext.titlePath.length === 0) {
		return [];
	}

	const targetFile = app.vault.getAbstractFileByPath(lastContext.filePath);
	if (!(targetFile instanceof TFile)) {
		return [];
	}

	const raw = await app.vault.cachedRead(targetFile);
	const roots = parseMarkdownHeadingTree(raw, targetFile.path);
	const currentNode = findHeadingByPath(roots, lastContext.titlePath);
	if (!currentNode) {
		return [];
	}

	if (shortcut === "next" || shortcut === "pre") {
		const siblings = flattenHeadingTree(roots).filter((node) => node.level === 1);
		const levelOnePath = currentNode.pathTitles.slice(0, 1);
		const levelOneNode = findHeadingByPath(roots, levelOnePath);
		if (!levelOneNode) {
			return [];
		}
		const direction = shortcut === "pre" ? -1 : 1;
		const target = pickSibling(siblings, levelOneNode, direction);
		return target ? [buildDocumentContextFromHeading(targetFile, raw, target, "shortcut")] : [];
	}

	const parentPath = currentNode.pathTitles.slice(0, -1);
	if (parentPath.length === 0) {
		return [];
	}

	const parentNode = findHeadingByPath(roots, parentPath);
	if (!parentNode) {
		return [];
	}

	const siblings = parentNode.children.filter((node) => node.level === currentNode.level);
	const direction = shortcut === "pre1" ? -1 : 1;
	const target = pickSibling(siblings, currentNode, direction);
	return target ? [buildDocumentContextFromHeading(targetFile, raw, target, "shortcut")] : [];
}
