import { MarkdownPostProcessorContext, Plugin } from "obsidian";
import { MyPluginSettings } from "./settings";

export function registerCodeBlockCollapser(
	plugin: Plugin,
	getSettings: () => MyPluginSettings
): void {
	plugin.registerMarkdownPostProcessor(
		(element: HTMLElement, _context: MarkdownPostProcessorContext) => {
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

				// 折叠按钮
				const toggleBtn = document.createElement("button");
				toggleBtn.classList.add("cbf-toggle");
				toggleBtn.setAttribute("aria-label", "折叠/展开代码块");

				const arrow = document.createElement("span");
				arrow.classList.add("cbf-arrow");
				toggleBtn.appendChild(arrow);
				header.appendChild(toggleBtn);

				// 应用默认折叠状态
				const collapsed = getSettings().collapseByDefault;
				wrapper.classList.toggle("cbf-collapsed", collapsed);
				arrow.textContent = collapsed ? "▶" : "▼";

				// 将 pre 替换为 wrapper，并把 pre 移入 wrapper
				pre.parentNode?.insertBefore(wrapper, pre);
				wrapper.appendChild(header);
				wrapper.appendChild(pre);

				// 点击切换
				toggleBtn.addEventListener("click", () => {
					const isCollapsed = wrapper.classList.toggle("cbf-collapsed");
					arrow.textContent = isCollapsed ? "▶" : "▼";
				});
			});
		}
	);
}
