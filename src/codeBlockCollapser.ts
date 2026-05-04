import { MarkdownPostProcessorContext, Plugin } from "obsidian";
import { MyPluginSettings } from "./settings";
import {
	CodeBlockSelectionStore,
	createCodeBlockContext,
} from "./selectionStore";

export function registerCodeBlockCollapser(
	plugin: Plugin,
	getSettings: () => MyPluginSettings,
	selectionStore: CodeBlockSelectionStore
): void {
	plugin.registerMarkdownPostProcessor(
		(element: HTMLElement, context: MarkdownPostProcessorContext) => {
			const preElements = element.querySelectorAll<HTMLElement>(
				"pre:not(.cbf-processed)"
			);

			preElements.forEach((pre) => {
				pre.classList.add("cbf-processed");

				// 获取语言标识
				const codeEl = pre.querySelector("code");
				let language = "";
				if (codeEl) {
					const langClass = Array.from(codeEl.classList).find((c) =>
						c.startsWith("language-")
					);
					if (langClass) {
						language = langClass.replace("language-", "");
					}
				}

				// 创建外层包裹容器
				const wrapper = document.createElement("div");
				wrapper.classList.add("cbf-wrapper");

				// 创建标题栏
				const header = document.createElement("div");
				header.classList.add("cbf-header");

				// 语言标签
				const langLabel = document.createElement("span");
				langLabel.classList.add("cbf-lang");
				langLabel.textContent = language || "code";
				header.appendChild(langLabel);

				// 右侧按钮组
				const btnGroup = document.createElement("div");
				btnGroup.classList.add("cbf-btn-group");
				header.appendChild(btnGroup);

				const sectionInfo = context.getSectionInfo(pre);
				const blockContext = createCodeBlockContext({
					sourcePath: context.sourcePath,
					startLine: sectionInfo?.lineStart ?? 0,
					endLine: sectionInfo?.lineEnd ?? sectionInfo?.lineStart ?? 0,
					language,
					content: codeEl?.textContent ?? "",
					mode: "preview",
				});

				const selectBtn = document.createElement("button");
				selectBtn.classList.add("cbf-select-toggle");
				selectBtn.setAttribute("aria-label", "选择代码块作为 AI 上下文");

				const selectMark = document.createElement("span");
				selectMark.classList.add("cbf-select-box");
				selectMark.textContent = "✓";
				selectBtn.appendChild(selectMark);

				const updateSelectionState = (selected: boolean): void => {
					selectBtn.classList.toggle("is-selected", selected);
					selectBtn.setAttribute("aria-pressed", String(selected));
					selectBtn.title = selected
						? "取消选中代码块上下文"
						: "选中代码块上下文";
				};

				updateSelectionState(selectionStore.isSelected(blockContext.id));
				selectBtn.addEventListener("click", () => {
					const selected = selectionStore.toggle(blockContext);
					updateSelectionState(selected);
				});
				btnGroup.appendChild(selectBtn);

				// 折叠按钮
				const toggleBtn = document.createElement("button");
				toggleBtn.classList.add("cbf-toggle");
				toggleBtn.setAttribute("aria-label", "折叠/展开代码块");
				const arrow = document.createElement("span");
				arrow.classList.add("cbf-arrow");
				toggleBtn.appendChild(arrow);
				btnGroup.appendChild(toggleBtn);

				// 应用默认折叠状态
				const collapsed = getSettings().collapseByDefault;
				wrapper.classList.toggle("cbf-collapsed", collapsed);
				arrow.textContent = collapsed ? "▶" : "▼";

				// 将 pre 替换为 wrapper，并把 pre 移入 wrapper
				pre.parentNode?.insertBefore(wrapper, pre);
				wrapper.appendChild(header);
				wrapper.appendChild(pre);

				// 将 Obsidian 原生复制按钮移入标题栏按钮组（置于折叠按钮之前）
				const moveCopyBtn = (): boolean => {
					const copyBtn = pre.querySelector<HTMLElement>(".copy-code-button");
					if (copyBtn) {
						copyBtn.classList.add("cbf-copy-button");
						btnGroup.insertBefore(copyBtn, toggleBtn);
						return true;
					}
					return false;
				};

				if (!moveCopyBtn()) {
					// 复制按钮尚未注入，用 MutationObserver 等待
					const observer = new MutationObserver(() => {
						if (moveCopyBtn()) {
							observer.disconnect();
						}
					});
					observer.observe(pre, { childList: true, subtree: true });
				}

				// 点击切换
				toggleBtn.addEventListener("click", () => {
					const isCollapsed = wrapper.classList.toggle("cbf-collapsed");
					arrow.textContent = isCollapsed ? "▶" : "▼";
				});
			});
		}
	);
}
