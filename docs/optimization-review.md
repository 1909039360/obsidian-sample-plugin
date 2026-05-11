# Obsidian AI plugin 优化建议

## 目的

本文基于当前项目实现，对可维护性、稳定性、性能、用户体验和工程化进行一次聚焦评审。
目标不是一次性“大重构”，而是识别最值得投入的优化点，并给出建议的落地顺序。

## 总体结论

当前插件已经具备可用的核心能力：

- 选中文本加入 AI 上下文
- 流式写入 AI 回答
- 记忆系统压缩与长期记忆抽取
- 独立的 AI task view
- 可配置的 prompt / model / memory 参数

但从代码结构和运行时行为看，仍有几个明显的优化方向：

1. 启动期仍残留 sample plugin 脚手架代码，增加了无意义的噪音和维护成本。
2. AI 流式写入逻辑已经变复杂，但仍集中在单个命令实现里，可测试性和可维护性偏弱。
3. 网络请求、流式解析、记忆压缩这几块缺少取消、超时、状态管理与失败恢复能力。
4. 设置持久化和记忆文件落盘策略还不够稳定，后续容易出现“UI 看起来变了，但状态并不完整一致”的问题。
5. 项目存在少量现成的工程告警，适合尽快清理。

## 优先级建议

| 优先级 | 方向 | 价值 | 成本 |
| --- | --- | --- | --- |
| P0 | 清理 sample scaffolding 与命名 | 高 | 低 |
| P0 | 抽离 AI 流式写入控制器 | 高 | 中 |
| P0 | 给 AI 请求增加取消、超时、并发保护 | 高 | 中 |
| P1 | 修正记忆系统的持久化语义 | 高 | 中 |
| P1 | 优化设置页频繁保存行为 | 中 | 低 |
| P1 | 补齐配置迁移与默认值升级逻辑 | 中 | 低 |
| P2 | 清理 TS / CSS 告警与兼容性问题 | 中 | 低 |
| P2 | 增加最小化测试与手工验收文档 | 中 | 中 |

## 详细建议

### 1. 清理 sample plugin 残留代码

相关文件：`src/main.ts`

当前入口里还保留了一些明显的模板代码：

- `MyPlugin` / `SampleModal` / `SampleSettingTab` 命名仍偏脚手架化
- ribbon icon 点击后只是弹 `This is a notice!`
- status bar 固定写入 `Status bar text`
- 定时器每 5 分钟 `console.log('setInterval')`
- `open-modal-simple` / `open-modal-complex` 这类 sample command 价值较低

这类代码的问题不是“功能错误”，而是：

- 会降低项目的可读性，让后续维护者分不清哪些是正式能力，哪些只是样例遗留
- 增加无意义的启动逻辑和 UI 噪音
- 让 README、命令列表、设置页显得不够聚焦

建议：

- 重命名主类和设置页类，使用真正的插件名
- 删除无业务价值的 sample modal / ribbon / status bar / interval
- 只保留与 AI、上下文、记忆相关的正式入口

### 2. 抽离 AI 流式写入控制器

相关文件：`src/commands/registerCommands.ts`

当前 `ai-completion` 命令已经承担了很多职责：

- 问题提取
- 文本模板插入
- thinking / answer 两阶段切换
- 流式 chunk 写入
- 光标与滚动控制
- 完成态分割线收尾
- 记忆系统记录

这导致这个命令已经成为一个“行为聚合点”。这类代码短期能工作，但后续每加一个需求都更容易把它推成不可维护的状态。

建议拆分成几个明确模块：

- `buildPromptContext(...)`
- `streamWriter.insertChunk(...)`
- `streamWriter.finish(...)`
- `runAiCompletion(...)`
- `extractInlineQuestion(...)`

最值得单独抽出来的是“流式写入器”。最近已经连续修了多次滚动与光标问题，这正说明这部分已经不适合继续埋在命令函数内部。

推荐落地方式：

- 新建 `src/ai/streamWriter.ts` 或 `src/commands/aiCompletion.ts`
- 把 `currentLine/currentCh`、chunk 写入、结束态处理都封装进去
- 给流式写入器定义清晰的输入输出，减少对外部局部变量的依赖

### 3. 给 AI 请求增加取消、超时和并发保护

相关文件：`src/ai.ts`、`src/commands/registerCommands.ts`

当前 `streamDashScope(...)` 已经能稳定读取流式结果，但仍缺几个运行时能力：

- 没有 `AbortController`，用户一旦触发了请求，无法中途停止
- 没有请求超时控制，网络挂起时体验会比较差
- 没有防重入保护，用户重复触发快捷键时，可能同时写入多条流
- 没有“当前正在生成”的显式状态，后续若做按钮禁用或状态提示会比较麻烦

建议：

- 给 `streamDashScope(...)` 增加 `signal?: AbortSignal`
- 在命令层增加“当前 editor 是否已有活跃生成任务”的状态表
- 增加一个 `Cancel AI completion` 命令
- 给超时和用户取消提供明确错误提示

如果后面打算继续扩展到多个模型供应商，这一步很重要。否则后续所有 provider 都会重复补一遍取消和状态管理。

### 4. 提升流式解析和写入的健壮性

相关文件：`src/ai.ts`

当前的 SSE 解析逻辑基本可用，但仍有几个可加强点：

- `while` 结束后没有对剩余 `buffer` 做最后一次解析尝试
- 只识别 `data: ` 行，未显式兼容更宽松的 SSE 事件结构
- 解析失败时只打 `console.error`，没有统计或结构化错误信息
- `reasoning_content` / `content` 的兼容逻辑可以进一步抽成独立解析函数

建议：

- 抽出 `parseSseChunks(buffer)` 辅助函数
- 在流结束时尝试处理尾部残留 buffer
- 为解析错误增加更具体的上下文信息
- 给 provider 响应结构做轻量适配层，避免未来换模型时在主逻辑里堆 `if/else`

### 5. 优化设置页的持久化频率

相关文件：`src/settings.ts`

设置页里很多输入框使用 `onChange(async (value) => await saveSettings())`。对于短文本还可以接受，但对大段 prompt 配置来说，这意味着用户每打一两个字符就会触发一次保存。

这类实现的问题：

- 对 vault 写入频率高
- 在移动端或大 vault 下可能导致轻微卡顿
- 后续如果设置项更多，这种模式会放大写放大问题

建议：

- 对 text / textarea 改成 `blur` 保存，或加 `300-500ms` debounce
- 对数值输入做统一校验和错误提示，而不是静默忽略非法值
- 给 URL / model / memory 参数增加基本格式校验

### 6. 修正记忆系统的持久化语义

相关文件：`src/memory/memoryManager.ts`、`src/memory/conversationStore.ts`、`src/memory/fileSystemAdapter.ts`

当前记忆系统设计方向是对的，但持久化语义还不够完整：

- `clearSession()` 只清空内存中的 `ConversationStore`，不会同步清理 `short-term/active-session.md`
- `init()` 只从 `active-session.md` 里加载 summary，没有恢复 recent turns
- `recordTurn()` 只在压缩时落盘，未压缩前的短期会话主要停留在内存中
- 插件重载后，未压缩的 recent turns 可能丢失

这会导致一个实际问题：

用户从 UI 视角以为“记忆系统已经工作”，但插件重载、崩溃、手动清空之后，落盘状态和内存状态不一定一致。

建议：

- 明确记忆系统是“仅 summary 持久化”还是“最近会话也持久化”
- 如果目标是可靠记忆，建议每轮对话都异步更新 `active-session.md`
- `clearSession()` 应同时清理内存和对应 short-term 文件
- 为记忆系统增加一个最小一致性模型：`init -> restore -> update -> clear`

### 7. 增加设置迁移与版本化默认值处理

相关文件：`src/main.ts`、`src/settings.ts`

当前 `loadSettings()` 只对 system prompt 做了一个很局部的默认值补齐：

- `savedSystemPrompts` 为空时补默认值
- `activeSystemPromptId` 为空时补默认值

但其他字段没有统一迁移机制，例如：

- `savedSoulPrompts`
- `memory*` 系列配置
- 未来新加的 provider / UI 配置

建议：

- 增加 `settingsVersion`
- 编写 `migrateSettings(raw): MyPluginSettings`
- 把默认值合并、字段修正、兼容旧数据都放进迁移函数

这样以后升级功能时，不需要在 `loadSettings()` 里持续堆散落的兼容逻辑。

### 8. 清理类型绕过和弱类型接口

相关文件：`src/main.ts`、`src/commands/registerCommands.ts`

项目里有几处类型层面的“先绕过去再说”：

- `// @ts-ignore` 执行命令
- `(editor as any).cm` 访问底层 CodeMirror
- 某些数组过滤后再强转为 `as any`

其中 `(editor as any).cm` 在当前场景下可能确实需要，但建议把这些访问封装在单独的 adapter 里，而不是分散在业务逻辑中。

建议：

- 建一个 `editorAdapter.ts`，集中封装 `getCodeMirror(editor)`、`dispatchWithoutScroll(...)`、`setSelectionByOffset(...)`
- 尽量消灭 `@ts-ignore`
- 把 prompt 列表和 active id 的读写封装成具名 helper，减少 `as any`

### 9. 清理现有工程告警

通过问题面板可以看到两个直接可处理的点：

#### 9.1 CSS 兼容性告警

相关文件：`styles.css`

当前有 `-webkit-line-clamp`，但缺少标准属性 `line-clamp`。

建议：

- 增加标准属性作为兼容补充

#### 9.2 TypeScript 配置告警

相关文件：`tsconfig.json`

当前存在关于以下选项的弃用提示：

- `baseUrl`
- `moduleResolution: node`

建议：

- 检查是否可以迁移到新的模块解析配置
- 若短期无法迁移，至少明确加入兼容策略，而不是让告警一直存在

### 10. 补一层最小测试和验收文档

当前项目的风险点主要集中在“有状态行为”：

- 流式输出
- 光标位置
- 滚动行为
- 记忆压缩
- prompt 切换

这类问题非常适合补“少量但高价值”的验证手段。

建议最小化投入方案：

- 文档化一份手工验收清单
- 对纯逻辑模块补单元测试，例如：
  - `selectionStore.ts`
  - `conversationStore.ts`
  - `tokenEstimator.ts`
  - `stream SSE parser`（如果抽出来）
- 把“滚动不被抢夺、完成后光标位置正确”纳入回归检查项

## 推荐执行顺序

### 第一阶段：低成本高收益

1. 清理 sample scaffolding
2. 清理 CSS / TS 配置告警
3. 设置页改为 debounce / blur 保存
4. 补一份手工验收文档

### 第二阶段：稳定性提升

1. 为 AI 请求增加取消 / 超时 / 防并发
2. 抽离流式写入控制器
3. 抽离 editor adapter，收敛 `any` 访问

### 第三阶段：记忆系统增强

1. 明确记忆系统持久化模型
2. 改进 `init / clear / recordTurn` 的一致性
3. 增加 settings migration 机制

## 如果只做 3 件事

如果当前时间有限，最值得优先做的是这三项：

1. 把 `registerCommands.ts` 里的 AI completion 流式逻辑抽出来。
2. 给 `streamDashScope(...)` 增加取消、超时、并发保护。
3. 修正记忆系统“内存状态”和“磁盘状态”不完全一致的问题。

这三项会直接改善后续迭代效率，也最能降低继续开发时的回归风险。
