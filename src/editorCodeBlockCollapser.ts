import { Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { MyPluginSettings } from "./settings";
import {
	CodeBlockSelectionStore,
	createCodeBlockContext,
} from "./selectionStore";

interface CodeBlockPosition {
	startPos: number;
	endPos: number;
	startLineTo: number;
	startLine: number;
	endLine: number;
	language: string;
}

const CODE_FENCE_PATTERN = /^\s*(`{3,}|~{3,})(.*)$/;

export const toggleFoldEffect = StateEffect.define<{
	from: number;
	to: number;
	defaultState?: boolean;
}>();

class FoldToggleWidget extends WidgetType {
	constructor(
		private readonly block: CodeBlockPosition,
		private readonly isSelected: boolean,
		private readonly selectionStore: CodeBlockSelectionStore
	) {
		super();
	}

	eq(other: FoldToggleWidget): boolean {
		return (
			other.block.startPos === this.block.startPos &&
			other.block.endPos === this.block.endPos &&
			other.block.language === this.block.language &&
			other.isSelected === this.isSelected
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const container = document.createElement("span");
		container.className = "cbf-editor-toggle-host";
		const blockContext = createEditorBlockContext(view, this.block);

		const selectButton = createSelectionButton(this.isSelected, () => {
			const selected = this.selectionStore.toggle(blockContext);
			updateSelectionButtonState(selectButton, selected);
		});
		container.appendChild(selectButton);

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
	constructor(
		private readonly block: CodeBlockPosition,
		private readonly isSelected: boolean,
		private readonly selectionStore: CodeBlockSelectionStore
	) {
		super();
	}

	eq(other: FoldedCodeBlockWidget): boolean {
		return (
			other.block.startPos === this.block.startPos &&
			other.block.endPos === this.block.endPos &&
			other.block.language === this.block.language &&
			other.isSelected === this.isSelected
		);
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = document.createElement("div");
		wrapper.className = "cbf-editor-folded";
		const blockContext = createEditorBlockContext(view, this.block);

		const header = document.createElement("div");
		header.className = "cbf-editor-folded-header";

		const langLabel = document.createElement("span");
		langLabel.className = "cbf-editor-folded-lang";
		langLabel.textContent = this.block.language || "code";
		header.appendChild(langLabel);

		const actions = document.createElement("div");
		actions.className = "cbf-editor-folded-actions";
		header.appendChild(actions);

		const selectButton = createSelectionButton(this.isSelected, () => {
			const selected = this.selectionStore.toggle(blockContext);
			updateSelectionButtonState(selectButton, selected);
		});
		actions.appendChild(selectButton);

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
		actions.appendChild(button);

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
			startLine: number;
			endLine: number;
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
				startLine: line.number - 1,
				endLine: line.number - 1,
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
			startLine: openFence.startLine,
			endLine: line.number - 1,
			language: openFence.language,
		});
		openFence = null;
	}

	return positions;
}

function createEditorBlockContext(
	view: EditorView,
	block: CodeBlockPosition
) {
	const sourcePath = view.state.field(editorInfoField, false)?.file?.path ?? "";
	const content = view.state.doc.sliceString(block.startPos, block.endPos);

	return createCodeBlockContext({
		sourcePath,
		startLine: block.startLine,
		endLine: block.endLine,
		language: block.language,
		content,
		mode: "live-preview",
	});
}

function updateSelectionButtonState(button: HTMLButtonElement, selected: boolean): void {
	button.classList.toggle("is-selected", selected);
	button.setAttribute("aria-pressed", String(selected));
	button.title = selected ? "取消选中代码块上下文" : "选中代码块上下文";
}

function createSelectionButton(
	initiallySelected: boolean,
	onToggle: () => void
): HTMLButtonElement {
	const button = document.createElement("button");
	button.className = "cbf-editor-select-toggle";
	button.type = "button";
	button.setAttribute("aria-label", "选择代码块作为 AI 上下文");

	const box = document.createElement("span");
	box.className = "cbf-select-box";
	box.textContent = "✓";
	button.appendChild(box);
	updateSelectionButtonState(button, initiallySelected);

	button.addEventListener("mousedown", (event) => {
		event.preventDefault();
	});

	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		onToggle();
	});

	return button;
}

function createFoldDecoration(
	block: CodeBlockPosition,
	isSelected: boolean,
	selectionStore: CodeBlockSelectionStore
): Decoration {
	return Decoration.replace({
		block: true,
		inclusiveStart: true,
		inclusiveEnd: false,
		widget: new FoldedCodeBlockWidget(block, isSelected, selectionStore),
	});
}

function createFoldField(
	settings: MyPluginSettings,
	selectionStore: CodeBlockSelectionStore
): StateField<DecorationSet> {
	return StateField.define<DecorationSet>({
		create(state) {
			if (!settings.collapseByDefault || !state.field(editorLivePreviewField, false)) {
				return Decoration.none;
			}

			const builder = new RangeSetBuilder<Decoration>();
			for (const block of findCodeBlockPositions(state)) {
				const blockContext = createCodeBlockContext({
					sourcePath: state.field(editorInfoField, false)?.file?.path ?? "",
					startLine: block.startLine,
					endLine: block.endLine,
					language: block.language,
					content: state.doc.sliceString(block.startPos, block.endPos),
					mode: "live-preview",
				});

				builder.add(
					block.startPos,
					block.endPos,
					createFoldDecoration(
						block,
						selectionStore.isSelected(blockContext.id),
						selectionStore
					)
				);
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
					add: [
						createFoldDecoration(
							block,
							selectionStore.isSelected(
								createEditorBlockContext(
									{ state: transaction.state } as EditorView,
									block
								).id
							),
							selectionStore
						).range(from, to),
					],
				});
			}

			return folds;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildToggleDecorations(
	state: EditorView["state"],
	foldField: StateField<DecorationSet>,
	selectionStore: CodeBlockSelectionStore
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
				widget: new FoldToggleWidget(
					block,
					selectionStore.isSelected(
						createCodeBlockContext({
							sourcePath: state.field(editorInfoField, false)?.file?.path ?? "",
							startLine: block.startLine,
							endLine: block.endLine,
							language: block.language,
							content: state.doc.sliceString(block.startPos, block.endPos),
							mode: "live-preview",
						}).id
					),
					selectionStore
				),
				side: 1,
			})
		);
	}

	return builder.finish();
}

export function createEditorCodeBlockCollapserExtension(
	settings: MyPluginSettings,
	selectionStore: CodeBlockSelectionStore
): Extension[] {
	const foldField = createFoldField(settings, selectionStore);
	const toggleField = StateField.define<DecorationSet>({
		create(state) {
			return buildToggleDecorations(state, foldField, selectionStore);
		},
		update(_value, transaction) {
			return buildToggleDecorations(transaction.state, foldField, selectionStore);
		},
		provide: (field) => EditorView.decorations.from(field),
	});

	return [foldField, toggleField];
}