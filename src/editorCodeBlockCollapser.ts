import { Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";
import { MyPluginSettings } from "./settings";

interface CodeBlockPosition {
	startPos: number;
	endPos: number;
	startLineTo: number;
	language: string;
}

const CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})(.*)$/;

export const toggleFoldEffect = StateEffect.define<{
	from: number;
	to: number;
	defaultState?: boolean;
}>();

class FoldToggleWidget extends WidgetType {
	constructor(private readonly block: CodeBlockPosition) {
		super();
	}

	eq(other: FoldToggleWidget): boolean {
		return (
			other.block.startPos === this.block.startPos &&
			other.block.endPos === this.block.endPos &&
			other.block.language === this.block.language
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const container = document.createElement("span");
		container.className = "cbf-editor-toggle-host";

		const button = document.createElement("button");
		button.className = "cbf-editor-toggle";
		button.type = "button";
		button.setAttribute("aria-label", "折叠代码块");
		button.title = "折叠代码块";

		const icon = document.createElement("span");
		icon.className = "cbf-editor-toggle-icon";
		icon.textContent = "▾";
		button.appendChild(icon);

		button.addEventListener("mousedown", (event) => {
			event.preventDefault();
		});

		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			view.dispatch({
				effects: toggleFoldEffect.of({
					from: this.block.startPos,
					to: this.block.endPos,
				}),
			});
			view.focus();
		});

		container.appendChild(button);
		return container;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

class FoldedCodeBlockWidget extends WidgetType {
	constructor(private readonly block: CodeBlockPosition) {
		super();
	}

	eq(other: FoldedCodeBlockWidget): boolean {
		return (
			other.block.startPos === this.block.startPos &&
			other.block.endPos === this.block.endPos &&
			other.block.language === this.block.language
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "cbf-editor-folded";

		const header = document.createElement("div");
		header.className = "cbf-editor-folded-header";

		const langLabel = document.createElement("span");
		langLabel.className = "cbf-editor-folded-lang";
		langLabel.textContent = this.block.language || "code";
		header.appendChild(langLabel);

		const button = document.createElement("button");
		button.className = "cbf-editor-toggle is-collapsed";
		button.type = "button";
		button.setAttribute("aria-label", "展开代码块");
		button.title = "展开代码块";

		const icon = document.createElement("span");
		icon.className = "cbf-editor-toggle-icon";
		icon.textContent = "▸";
		button.appendChild(icon);

		button.addEventListener("mousedown", (event) => {
			event.preventDefault();
		});

		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			view.dispatch({
				effects: toggleFoldEffect.of({
					from: this.block.startPos,
					to: this.block.endPos,
					defaultState: false,
				}),
			});
			view.focus();
		});
		header.appendChild(button);

		const preview = document.createElement("pre");
		preview.className = "cbf-editor-folded-preview";

		const code = document.createElement("code");
		const previewText = getCollapsedPreview(view, this.block);
		code.textContent = previewText || "...";
		preview.appendChild(code);

		wrapper.appendChild(header);
		wrapper.appendChild(preview);
		return wrapper;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

function getCollapsedPreview(view: EditorView, block: CodeBlockPosition): string {
	const text = view.state.doc.sliceString(block.startPos, block.endPos);
	const lines = text.split("\n");
	let codeLines = lines.slice(1);

	if (codeLines.length > 0) {
		const lastLine = codeLines[codeLines.length - 1];
		if (
			lastLine &&
			(lastLine.trim().startsWith("```") || lastLine.trim().startsWith("~~~"))
		) {
			codeLines = codeLines.slice(0, -1);
		}
	}

	return codeLines.slice(0, 3).join("\n");
}

function findCodeBlockPositions(state: EditorView["state"]): CodeBlockPosition[] {
	const positions: CodeBlockPosition[] = [];
	let openFence:
		| {
			marker: string;
			startPos: number;
			startLineTo: number;
			language: string;
		  }
		| null = null;

	for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
		const line = state.doc.line(lineNumber);
		const match = line.text.match(CODE_FENCE_PATTERN);

		if (!match) {
			continue;
		}

		const marker = match[1];
		if (!marker) {
			continue;
		}

		if (!openFence) {
			openFence = {
				marker: marker.charAt(0),
				startPos: line.from,
				startLineTo: line.to,
				language: (match[2] ?? "").trim(),
			};
			continue;
		}

		if (marker.charAt(0) !== openFence.marker) {
			continue;
		}

		positions.push({
			startPos: openFence.startPos,
			endPos: line.to,
			startLineTo: openFence.startLineTo,
			language: openFence.language,
		});
		openFence = null;
	}

	return positions;
}

function createFoldDecoration(block: CodeBlockPosition): Decoration {
	return Decoration.replace({
		block: true,
		inclusiveStart: true,
		inclusiveEnd: false,
		widget: new FoldedCodeBlockWidget(block),
	});
}

function createFoldField(settings: MyPluginSettings): StateField<DecorationSet> {
	return StateField.define<DecorationSet>({
		create(state) {
			if (!settings.collapseByDefault || !state.field(editorLivePreviewField, false)) {
				return Decoration.none;
			}

			const builder = new RangeSetBuilder<Decoration>();
			for (const block of findCodeBlockPositions(state)) {
				builder.add(block.startPos, block.endPos, createFoldDecoration(block));
			}
			return builder.finish();
		},
		update(folds, transaction) {
			folds = folds.map(transaction.changes);

			for (const effect of transaction.effects) {
				if (!effect.is(toggleFoldEffect)) {
					continue;
				}

				const { from, to, defaultState } = effect.value;
				let hasFold = false;

				folds.between(from, to, () => {
					hasFold = true;
				});

				const shouldFold = defaultState !== undefined ? defaultState : !hasFold;

				if (!shouldFold) {
					folds = folds.update({
						filter: (fromPos, toPos) => fromPos !== from || toPos !== to,
					});
					continue;
				}

				if (hasFold) {
					continue;
				}

				const block = findCodeBlockPositions(transaction.state).find(
					(position) => position.startPos === from && position.endPos === to
				);

				if (!block) {
					continue;
				}

				folds = folds.update({
					add: [createFoldDecoration(block).range(from, to)],
				});
			}

			return folds;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildToggleDecorations(
	state: EditorView["state"],
	foldField: StateField<DecorationSet>
): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) {
		return Decoration.none;
	}

	const builder = new RangeSetBuilder<Decoration>();
	const folds = state.field(foldField);

	for (const block of findCodeBlockPositions(state)) {
		let isFolded = false;
		folds.between(block.startPos, block.endPos, () => {
			isFolded = true;
		});

		if (isFolded) {
			continue;
		}

		builder.add(
			block.startLineTo,
			block.startLineTo,
			Decoration.widget({
				widget: new FoldToggleWidget(block),
				side: 1,
			})
		);
	}

	return builder.finish();
}

export function createEditorCodeBlockCollapserExtension(
	settings: MyPluginSettings
): Extension[] {
	const foldField = createFoldField(settings);
	const toggleField = StateField.define<DecorationSet>({
		create(state) {
			return buildToggleDecorations(state, foldField);
		},
		update(_value, transaction) {
			return buildToggleDecorations(transaction.state, foldField);
		},
		provide: (field) => EditorView.decorations.from(field),
	});

	return [foldField, toggleField];
}