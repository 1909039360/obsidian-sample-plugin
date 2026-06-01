import type { TFile } from "obsidian";
import type { DocumentContextItem, DocumentContextSource, DocumentHeadingNode } from "./types";

const HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function normalizeTitle(title: string): string {
	return title.trim().replace(/\s+/g, " ");
}

export function createDocumentContextId(filePath: string, titlePath: string[]): string {
	return [filePath, ...titlePath].join("::");
}

export function parseMarkdownHeadingTree(raw: string, filePath: string): DocumentHeadingNode[] {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const roots: DocumentHeadingNode[] = [];
	const stack: DocumentHeadingNode[] = [];
	const flatNodes: DocumentHeadingNode[] = [];

	lines.forEach((line, lineIndex) => {
		const match = line.match(HEADING_PATTERN);
		if (!match) {
			return;
		}

		const hashes = match[1];
		const rawTitle = match[2];
		if (!hashes || !rawTitle) {
			return;
		}

		const level = hashes.length;
		const title = normalizeTitle(rawTitle);
		if (!title) {
			return;
		}

		while (stack.length > 0) {
			const stackTop = stack[stack.length - 1];
			if (!stackTop || stackTop.level < level) {
				break;
			}

			stack.pop();
		}

		const parent = stack[stack.length - 1];
		const pathTitles = parent ? [...parent.pathTitles, title] : [title];
		const node: DocumentHeadingNode = {
			id: createDocumentContextId(filePath, pathTitles),
			filePath,
			title,
			level,
			startLine: lineIndex,
			endLine: lines.length - 1,
			parentId: parent?.id,
			pathTitles,
			children: [],
		};

		if (parent) {
			parent.children.push(node);
		} else {
			roots.push(node);
		}

		stack.push(node);
		flatNodes.push(node);
	});

	for (let index = 0; index < flatNodes.length; index += 1) {
		const current = flatNodes[index];
		if (!current) {
			continue;
		}

		for (let nextIndex = index + 1; nextIndex < flatNodes.length; nextIndex += 1) {
			const candidate = flatNodes[nextIndex];
			if (!candidate) {
				continue;
			}

			if (candidate.level <= current.level) {
				current.endLine = candidate.startLine - 1;
				break;
			}
		}
	}

	return roots;
}

export function flattenHeadingTree(nodes: DocumentHeadingNode[]): DocumentHeadingNode[] {
	const flattened: DocumentHeadingNode[] = [];
	for (const node of nodes) {
		flattened.push(node);
		flattened.push(...flattenHeadingTree(node.children));
	}
	return flattened;
}

export function findHeadingByPath(nodes: DocumentHeadingNode[], titlePath: string[]): DocumentHeadingNode | null {
	if (titlePath.length === 0) {
		return null;
	}

	const normalizedPath = titlePath.map(normalizeTitle);
	return (
		flattenHeadingTree(nodes).find((node) => {
			if (node.pathTitles.length !== normalizedPath.length) {
				return false;
			}

			return node.pathTitles.every((title, index) => title === normalizedPath[index]);
		}) ?? null
	);
}

export function getChildHeadings(nodes: DocumentHeadingNode[], titlePath: string[]): DocumentHeadingNode[] {
	if (titlePath.length === 0) {
		return [...nodes];
	}

	const parent = findHeadingByPath(nodes, titlePath);
	return parent?.children ?? [];
}

export function resolveCurrentHeading(nodes: DocumentHeadingNode[], cursorLine: number): DocumentHeadingNode | null {
	const matches = flattenHeadingTree(nodes).filter((node) => node.startLine <= cursorLine && cursorLine <= node.endLine);
	if (matches.length === 0) {
		return null;
	}

	matches.sort((left, right) => {
		if (left.level !== right.level) {
			return right.level - left.level;
		}
		return right.startLine - left.startLine;
	});

	return matches[0] ?? null;
}

function buildContextItem(
	file: TFile,
	titlePath: string[],
	content: string,
	level: number,
	source: DocumentContextSource
): DocumentContextItem {
	return {
		id: createDocumentContextId(file.path, titlePath),
		filePath: file.path,
		fileName: file.name,
		titlePath,
		level,
		content,
		selectedAt: Date.now(),
		source,
	};
}

export function buildDocumentContextFromFile(file: TFile, raw: string, source: DocumentContextSource = "file"): DocumentContextItem {
	return buildContextItem(file, [], raw.replace(/\r\n/g, "\n").trimEnd(), 0, source);
}

export function buildDocumentContextFromHeading(
	file: TFile,
	raw: string,
	node: DocumentHeadingNode,
	source: DocumentContextSource = "heading"
): DocumentContextItem {
	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	const content = lines.slice(node.startLine, node.endLine + 1).join("\n").trimEnd();
	return buildContextItem(file, [...node.pathTitles], content, node.level, source);
}

export function resolveDefaultDocumentContext(
	file: TFile,
	raw: string,
	cursorLine: number,
	preferredTitlePath: string[] = []
): DocumentContextItem {
	const roots = parseMarkdownHeadingTree(raw, file.path);
	const preferredNode = preferredTitlePath.length > 0 ? findHeadingByPath(roots, preferredTitlePath) : null;
	if (preferredNode) {
		return buildDocumentContextFromHeading(file, raw, preferredNode, "shortcut");
	}

	const currentNode = resolveCurrentHeading(roots, cursorLine);
	if (currentNode) {
		return buildDocumentContextFromHeading(file, raw, currentNode);
	}

	const firstHeading = roots[0] ?? flattenHeadingTree(roots)[0];
	if (firstHeading) {
		return buildDocumentContextFromHeading(file, raw, firstHeading);
	}

	return buildDocumentContextFromFile(file, raw);
}
