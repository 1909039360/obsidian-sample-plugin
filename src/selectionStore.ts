export type CodeBlockMode = "preview" | "live-preview";

export interface CodeBlockContext {
	id: string;
	sourcePath: string;
	startLine: number;
	endLine: number;
	language: string;
	content: string;
	mode: CodeBlockMode;
	selectedAt: number;
}

interface CreateCodeBlockContextInput {
	sourcePath: string;
	startLine: number;
	endLine: number;
	language: string;
	content: string;
	mode: CodeBlockMode;
}

function hashString(value: string): string {
	let hash = 0;

	for (let index = 0; index < value.length; index += 1) {
		hash = (hash << 5) - hash + value.charCodeAt(index);
		hash |= 0;
	}

	return Math.abs(hash).toString(16);
}

export function createCodeBlockContext(
	input: CreateCodeBlockContextInput
): CodeBlockContext {
	const normalizedContent = input.content.replace(/\r\n/g, "\n").trimEnd();
	const normalizedLanguage = input.language.trim();
	const normalizedSourcePath = input.sourcePath.trim();
	const id = [
		normalizedSourcePath,
		String(input.startLine),
		String(input.endLine),
		normalizedLanguage,
		hashString(normalizedContent),
	].join(":");

	return {
		id,
		sourcePath: normalizedSourcePath,
		startLine: input.startLine,
		endLine: input.endLine,
		language: normalizedLanguage,
		content: normalizedContent,
		mode: input.mode,
		selectedAt: Date.now(),
	};
}

export class CodeBlockSelectionStore {
	private readonly selectedBlocks = new Map<string, CodeBlockContext>();

	toggle(context: CodeBlockContext): boolean {
		if (this.selectedBlocks.has(context.id)) {
			this.selectedBlocks.delete(context.id);
			return false;
		}

		this.selectedBlocks.set(context.id, context);
		return true;
	}

	isSelected(blockId: string): boolean {
		return this.selectedBlocks.has(blockId);
	}

	getSelectedContexts(): CodeBlockContext[] {
		return Array.from(this.selectedBlocks.values()).sort(
			(left, right) => left.selectedAt - right.selectedAt
		);
	}

	clear(): void {
		this.selectedBlocks.clear();
	}
}