# Markdown 文档上下文自动选择功能设计文档

## 1. 背景与目标

当前插件已经具备两类能力：

- `Active Contexts`：通过代码块选择、选中文本、剪切板导入，将片段放入 AI 上下文。
- `////` 提示词补全：通过 `src/promptSuggest.ts` 为用户补全常用提示词。

但当前还缺少“面向 Markdown 章节结构”的上下文选择能力，无法满足以下场景：

- 用户在长文档中快速指定某一章、某一节作为 AI 问答上下文。
- 用户围绕同一本文档连续对话时，快速切换到上一章、下一章、上一小节、下一小节。
- 在侧栏中同时区分“代码/文本片段上下文”和“文档章节上下文”。

本次需求目标是新增 `Document Contexts` 能力，使插件能以 Markdown 标题树为导航结构，按“文件 -> 一级标题 -> 二级标题 -> 三级标题”逐层选择上下文，并与现有 `Active Contexts` 一起传给 AI。

## 2. 需求拆解

### 2.1 核心交互

1. 用户在编辑器输入 `@` 时，先弹出当前文件所在目录的 Markdown 文件列表。
2. 选择文件后，再次输入 `@`，弹出该文件的一级标题列表。
3. 选择一级标题后，再次输入 `@`，弹出该标题下的二级标题列表。
4. 如有更深层级，继续输入 `@`，逐级选择子标题。
5. 每次选择后，将该文件或标题节点对应的正文内容写入 `Document Contexts`。

### 2.2 侧栏展示

在 `AI Context Manager` 中新增一个独立区块：

- 名称：`Document Contexts`
- 与现有 `Active Contexts` 分开显示。
- 仅显示文件名、标题路径，不显示正文文本。
- 保留 5 条历史记录，交互方式与 `Active Contexts` 类似。

### 2.3 AI 调用

调用 AI 时同时注入：

- `Active Contexts`
- `Document Contexts`

其中 `Document Contexts` 必须保留章节标题层级，例如：

```text
文件: 西游记.md
路径: 第二回 > 灵根育孕源流出，心性修持大道生
```

### 2.4 快速入口

输入 `@` 时除正常建议项外，还需要增加快捷项：

- `@current`：恢复上一次对话使用的 `Document Contexts`
- `@next` / `@pre`：基于上一次选中的一级标题，切到下一章 / 上一章
- `@next1` / `@pre1`：基于上一次选中的二级标题，切到下一小节 / 上一小节

### 2.5 默认行为

如果用户没有继续细化输入，则默认选择“当前章节”。

推荐解释为：

- 上次选择的章节（文档的），如果没有选择，当前章节为空串。

这样实现后，既符合“默认选择章节”，又不会强制用户逐层选到最深层。

## 3. 当前实现现状

结合现有代码，相关能力集中在以下文件：

- `src/promptSuggest.ts`
  - 当前仅支持 `////` 提示词补全，不支持 `@` 文档上下文补全。
- `src/aiTaskView.ts`
  - 当前仅渲染 `Active Contexts` 与其历史，没有 `Document Contexts`。
- `src/selectionStore.ts`
  - 当前只管理代码/文本片段上下文，没有文档章节上下文模型。
- `src/commands/registerCommands.ts`
  - 当前 AI 调用入口从行尾 `//问题//` 中解析问题，并只读取 `selectionStore`。
- `src/ai.ts`
  - 当前系统提示词仅注入 `contexts`，没有独立的文档上下文输入。
- `src/main.ts`
  - 当前只注册了 `AIPromptSuggest`，没有注册文档上下文选择器。

结论：该需求不是单点改动，需要新增一套“文档上下文模型 + 标题解析器 + 编辑器建议器 + 侧栏渲染 + AI 注入”的链路。

## 4. 建议实现方案

## 4.1 模块划分

建议新增一个独立模块目录，避免继续堆在 `main.ts` 或 `aiTaskView.ts` 中：

```text
src/documentContext/
  types.ts
  parser.ts
  store.ts
  suggest.ts
  navigation.ts
```

各文件职责建议如下：

### `src/documentContext/types.ts`

定义核心数据结构：

```ts
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

export interface DocumentContextItem {
  id: string;
  filePath: string;
  fileName: string;
  titlePath: string[];
  level: number;
  content: string;
  selectedAt: number;
  source: "file" | "heading" | "shortcut";
}

export interface DocumentContextHistorySnapshot {
  items: DocumentContextItem[];
  createdAt: number;
  label: string;
}
```

说明：

- `DocumentHeadingNode` 用于描述文件中的标题树。
- `DocumentContextItem` 用于真正传给 AI 的上下文实体。
- `DocumentContextHistorySnapshot` 用于支持 `@current` 和侧栏历史恢复。

### `src/documentContext/parser.ts`

负责把 Markdown 文件解析为标题树，并提取正文范围。

优先方案：

1. 先通过 `app.metadataCache.getFileCache(file)?.headings` 获取 Obsidian 已解析的标题信息。
2. 如果缓存未命中，再回退到原始 Markdown 文本正则解析。

核心函数建议：

```ts
parseMarkdownHeadingTree(file: TFile, raw: string): DocumentHeadingNode[]
resolveCurrentHeading(file: TFile, cursorLine: number): DocumentHeadingNode | null
buildDocumentContextFromFile(file: TFile, raw: string): DocumentContextItem
buildDocumentContextFromHeading(file: TFile, raw: string, node: DocumentHeadingNode): DocumentContextItem
```

正文提取规则：

- 选中文件时：正文为整个文件内容。
- 选中标题时：正文为“该标题行 + 直到下一个同级或更高等级标题之前的全部文本”。
- 必须把标题本身也包含进 `content`，以满足“传给 AI 时保留章节标题”。

### `src/documentContext/store.ts`

新增与 `selectionStore.ts` 并行的存储层，用于管理 `Document Contexts`。

建议实现一个独立类：

```ts
export class DocumentContextStore {
  toggle(item: DocumentContextItem): boolean
  remove(id: string): void
  clear(): void
  getSelectedItems(): DocumentContextItem[]
  getHistory(): DocumentContextItem[]
  setLastConversationSnapshot(items: DocumentContextItem[]): void
  getLastConversationSnapshot(): DocumentContextItem[]
}
```

设计理由：

- `Active Contexts` 与 `Document Contexts` 展示逻辑相似，但数据结构、恢复规则、快捷导航规则不同。
- 不建议直接把 `selectionStore.ts` 泛型化到一个过于抽象的基类，否则会增加当前代码复杂度。

### `src/documentContext/navigation.ts`

负责实现快捷导航：

- `@current`
- `@next`
- `@pre`
- `@next1`
- `@pre1`

建议对“上次对话选择结果”存储两类信息：

1. 上次对话实际使用的 `DocumentContextItem[]`
2. 其中最后一个“可导航标题节点”的定位信息：
   - `filePath`
   - `titlePath`
   - `level`
   - `siblingIndex`

导航规则建议：

- `@next` / `@pre` 只在一级标题集合内移动。
- `@next1` / `@pre1` 只在最近一次选中的二级标题同级集合内移动。
- 如果不存在目标节点，提示 `Notice`，不修改当前选择。

### `src/documentContext/suggest.ts`

负责编辑器中的 `@` 联想，是该需求的主入口。

建议新建 `DocumentContextSuggest extends EditorSuggest<DocumentSuggestItem>`。

建议状态机：

```ts
type SuggestStage = "shortcut" | "file" | "heading";
```

触发流程建议：

1. 用户输入 `@` 时触发。
2. 如果当前行最近一个 `@` 后没有文本：
   - 展示快捷项 + 当前文件夹 Markdown 文件列表。
3. 用户选中文件后：
   - 在编辑器行内插入一个轻量标记。
   - 将当前链路状态缓存在 suggest 实例中。
4. 用户再次输入 `@`：
   - 如果已有选中文件，则展示该文件当前层级的子标题列表。
5. 用户每次选择标题节点后：
   - 同步更新 `DocumentContextStore`
   - 继续允许下一层 `@`

## 4.2 编辑器内标记格式建议

这部分需要重点设计，因为当前 AI 命令只会从当前行用正则提取 `//问题//`。

建议不要使用“纯内存隐藏状态”作为唯一依据，而是采用“可见轻标记 + 内存状态”的双轨方案。推荐格式：

```text
@doc[西游记.md]
@doc[西游记.md > 第二回]
@doc[西游记.md > 第二回 > 第一节]
```

理由：

- 文本是可见的，用户知道自己选了什么。
- 即使 Obsidian 重载或 suggest 状态丢失，仍能从行文本重新解析选择结果。
- 便于在 `registerCommands.ts` 中统一提取并清理。

建议最终交互为：

```text
@doc[西游记.md > 第二回] //总结这一章的主线//
```

再次输入 `@` 时，如果当前行已有最近一个 `@doc[...]`，则 suggest 以它作为父节点继续下钻。

## 4.3 默认章节识别

为满足“如果不输入默认选择章节”，建议实现：

```ts
resolveDefaultDocumentContext(
  activeFile: TFile,
  selectedFile: TFile,
  cursorLine: number
): DocumentContextItem
```

逻辑：

1. `selectedFile === activeFile` 时：
   - 用当前光标所在行匹配最近标题节点。
   - 若找到，返回该章节。
2. 否则：
   - 若文件存在一级标题，则返回第一个一级标题。
   - 否则返回整个文件。

这能让用户只完成第一步“选文件”时，也立即得到一个合理的默认章节。

## 5. AI Context Manager 侧栏改造

当前 `src/aiTaskView.ts` 的 `renderContexts()` 只渲染：

- `Active Contexts`
- `History (Last 5)`
- Prompt 配置

建议改为三段：

1. `Active Contexts`
2. `Document Contexts`
3. Prompt 配置

其中 `Document Contexts` 展示规则：

- 每项显示：
  - 文件名
  - 标题路径，例如 `第二回 > 第一节`
- 不显示正文 `content`
- 支持删除按钮
- 支持历史恢复

建议新增方法：

```ts
private renderActiveContexts(): void
private renderDocumentContexts(): void
private renderDocumentContextHistory(): void
```

这样可以避免当前 `renderContexts()` 继续膨胀。

## 6. AI 调用链改造

## 6.1 调用入口改造

当前 `src/commands/registerCommands.ts` 中的 `ai-completion` 只读取：

```ts
const contexts = plugin.selectionStore.getSelectedContexts();
```

需要改为同时读取：

```ts
const activeContexts = plugin.selectionStore.getSelectedContexts();
const documentContexts = plugin.documentContextStore.getSelectedItems();
```

同时需要在发送前做两件事：

1. 解析当前行中的 `@doc[...]` 标记，补充或覆盖 `DocumentContextStore` 当前选择。
2. 在 AI 开始调用后，将本次真正使用过的 `documentContexts` 记录为“上次对话快照”，供 `@current`、`@next`、`@pre` 使用。

## 6.2 `streamDashScope` 入参改造

建议将 `src/ai.ts` 中的方法签名改成：

```ts
streamDashScope(
  query: string,
  activeContexts: CodeBlockContext[],
  documentContexts: DocumentContextItem[],
  apiKey: string,
  enableThinking: boolean,
  ...
)
```

并分开格式化：

```ts
function formatActiveContexts(contexts: CodeBlockContext[]): string
function formatDocumentContexts(items: DocumentContextItem[]): string
```

文档上下文建议格式：

```text
以下是用户选中的文档上下文：

[文档 1]
文件: 西游记.md
标题路径: 第二回
内容:
## 第二回
......
```

## 6.3 提示词占位符兼容策略

当前系统提示词只约定了 `{{CONTEXT}}` 与 `{{MEMORY}}`。

建议升级为：

- `{{ACTIVE_CONTEXT}}`
- `{{DOCUMENT_CONTEXT}}`
- `{{MEMORY}}`
- `{{CONTEXT}}` 作为兼容占位符，等于两类上下文拼接结果

兼容逻辑：

1. 如果模板中存在 `{{ACTIVE_CONTEXT}}` 或 `{{DOCUMENT_CONTEXT}}`，则精确替换。
2. 如果模板只有 `{{CONTEXT}}`，则注入 `active + document` 的合并块。
3. 如果模板没有任何上下文占位符，则在模板尾部追加。

这样不会破坏现有用户配置。

## 7. 设置与持久化

当前设置模型 `src/settings.ts` 中没有文档上下文相关字段。建议新增：

```ts
documentContextHistoryLimit: number;
lastDocumentContextSnapshot: DocumentContextItem[];
```

是否把“当前选中的 `Document Contexts`”持久化，建议分两层：

- 当前选中项：可不持久化，跟随会话。
- 历史与上次对话快照：应持久化到插件数据，保证 `@current` 在重启 Obsidian 后仍可使用。

推荐默认值：

- `documentContextHistoryLimit = 5`

如果后续要开放设置页，可再新增一个简单输入项；当前阶段不是必须。

## 8. 关键实现细节

## 8.1 标题树生成算法

可以基于标题数组用栈构树：

1. 顺序扫描标题。
2. 遇到新标题时，将栈顶所有 `level >= current.level` 的节点弹出。
3. 当前节点挂到新栈顶的 `children` 下。
4. 扫描结束后，再根据“下一个同级或更高等级标题的起始行”计算每个节点 `endLine`。

复杂度：

- 构树 `O(n)`
- 定位当前章节可通过顺序遍历完成，标题数通常较小，足够使用。

## 8.2 当前行上下文链恢复

建议在 `DocumentContextSuggest` 中实现：

```ts
parseDocumentMarkersFromLine(line: string): ParsedDocumentMarker[]
```

用途：

- 让再次输入 `@` 时知道上一个已选层级。
- 让 AI 调用时能从行文本恢复上下文，不依赖 suggest 的瞬时内存。

## 8.3 同步策略

需要处理两条输入来源：

1. 侧栏中的 `Document Contexts`
2. 当前行中的 `@doc[...]`

推荐规则：

- 行内 `@doc[...]` 是本次提问的最高优先级。
- 侧栏是全局已选文档上下文。
- AI 调用时使用两者合并去重后的结果。

去重 key 建议：

```text
filePath + titlePath.join(">")
```

## 9. 用户可见效果

## 9.1 编辑器内效果

用户操作示例：

1. 在 `西游记.md` 同目录文档里输入 `@`
2. 弹出：
   - `@current`
   - `@next`
   - `@pre`
   - `西游记.md`
   - `红楼梦.md`
3. 选择 `西游记.md`
4. 当前行出现：

```text
@doc[西游记.md]
```

5. 再输入 `@`
6. 弹出该文件一级标题：
   - `第一回`
   - `第二回`
   - `第三回`
7. 选择 `第二回`
8. 当前行更新为：

```text
@doc[西游记.md > 第二回]
```

9. 再输入 `@` 可继续选 `第二回` 下的 `第一节`

## 9.2 侧栏效果

`AI Context Manager` 中新增：

```text
Active Contexts
Document Contexts
  西游记.md
  第二回 > 第一节
History (Last 5)
```

说明：

- 只展示路径，不展示正文。
- 点击恢复时恢复整条文档上下文项。

## 9.3 AI 接收效果

最终给 AI 的系统提示中，会同时出现：

- 代码片段/剪切板的 `Active Contexts`
- 标题+正文的 `Document Contexts`

从而支持这类提问：

- “总结第二回的主线冲突”
- “比较第二回和第三回的人物出场顺序”
- “结合当前代码片段和《设计说明》第二节，给出改造建议”

## 10. 需要修改的文件清单

### 必改文件

- `src/main.ts`
  - 初始化 `DocumentContextStore`
  - 注册 `DocumentContextSuggest`
  - 传入 `AITaskView`
- `src/aiTaskView.ts`
  - 新增 `Document Contexts` 区块和历史展示
- `src/commands/registerCommands.ts`
  - 读取并合并文档上下文
  - 记录上次对话快照
- `src/ai.ts`
  - 接收并格式化 `Document Contexts`
- `src/settings.ts`
  - 新增历史快照配置字段

### 新增文件

- `src/documentContext/types.ts`
- `src/documentContext/parser.ts`
- `src/documentContext/store.ts`
- `src/documentContext/suggest.ts`
- `src/documentContext/navigation.ts`

### 可选优化文件

- `styles.css`
  - 为 `Document Contexts` 增加分组样式
- `docs/project-code-reference.md`
  - 后续补充新模块说明

## 11. 分阶段实施建议

建议按 3 个阶段落地，避免一次性改动过大。

### 阶段 1：底座

目标：把“文档上下文”作为独立数据模型跑通。

内容：

- 新增 `DocumentContextStore`
- 新增 Markdown 标题树解析器
- 在侧栏中先静态渲染 `Document Contexts`
- 在 AI 调用链中支持 `documentContexts`

验收标准：

- 即使还没有 `@` suggest，也能通过临时命令或调试代码把某个标题节点放入 `Document Contexts` 并传给 AI。

### 阶段 2：交互

目标：打通 `@` 文件/标题逐层选择。

内容：

- 实现 `DocumentContextSuggest`
- 实现 `@doc[...]` 标记生成和解析
- 实现默认章节解析

验收标准：

- 用户可通过连续输入 `@` 完成 文件 -> 一级标题 -> 二级标题 选择。

### 阶段 3：快捷导航与收尾

目标：补齐高频跳转与历史恢复。

内容：

- 实现 `@current`
- 实现 `@next/@pre/@next1/@pre1`
- 完善历史持久化
- 调整样式与错误提示

验收标准：

- 用户围绕同一本文档连续提问时，不需要重新逐级点选。

## 12. 测试方案

## 12.1 单元测试建议

优先覆盖纯逻辑模块：

- `parser.ts`
  - 标题树构建
  - 节点正文范围提取
  - 当前章节识别
- `navigation.ts`
  - `@next/@pre`
  - `@next1/@pre1`
- `store.ts`
  - 选中、移除、历史上限、快照恢复

## 12.2 手工测试场景

1. 当前目录有多个 Markdown 文件，输入 `@` 能列出文件。
2. 选择文件后，再输入 `@` 能列出一级标题。
3. 选择一级标题后，再输入 `@` 能列出其子标题。
4. 只选文件不选标题时，默认章节正确。
5. 侧栏 `Document Contexts` 不显示正文，只显示路径。
6. 删除、恢复历史、清空行为正确。
7. 调用 AI 时，文档标题与正文都已注入。
8. `@current` 能恢复上一次对话的选择。
9. `@next/@pre` 在边界节点给出正确提示。

## 12.3 兼容性风险

需要重点验证：

- 当前 `////` 提示词补全与 `@` suggest 是否会互相抢触发。
- 当前 `//问题//` 正则是否能兼容同行出现 `@doc[...]`。
- 超长章节文本是否会导致 prompt 过长，需要后续加截断或 token 控制。

## 13. 风险与建议

### 13.1 最大风险

不是 UI，而是“编辑器中的标记协议”设计。

如果 `@` 选择结果只是临时内存状态：

- 编辑器重开后会丢失
- AI 命令难以可靠复原
- 调试成本高

因此建议从一开始就采用 `@doc[...]` 这类可解析文本协议。

### 13.2 性能建议

- 标题树可按文件路径缓存，基于 `metadataCache.changed` 或文件修改时间失效。
- 不要在每次键入时全量扫描整个 vault，只扫描“当前文件所在目录”。
- 文档正文注入前可做长度裁剪，避免一次塞入整章超大文本。

### 13.3 可维护性建议

- `Active Contexts` 与 `Document Contexts` 分别建 store，不要混用字段。
- `aiTaskView.ts` 拆分渲染函数，避免一个方法继续膨胀。
- `main.ts` 仍保持初始化职责，不把解析逻辑塞进去。

## 14. 最终结论

该需求可以在现有插件架构上平滑落地，推荐采用以下原则：

1. 新增独立的 `Document Context` 模块，而不是把现有 `selectionStore` 强行复用。
2. 用 Markdown 标题树作为导航主结构，按“文件 -> 标题 -> 子标题”逐层下钻。
3. 用 `@doc[...]` 作为编辑器内可见、可恢复、可解析的上下文标记协议。
4. 在侧栏新增 `Document Contexts` 与 5 条历史记录。
5. 在 AI 调用时，将 `Active Contexts` 和 `Document Contexts` 同时注入，并保留标题路径。

如果后续进入实际编码阶段，建议优先先做“底座 + AI 注入”，再做 `@` 交互和快捷导航，这样更容易分段验证。