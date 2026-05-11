# 项目源码说明与排障手册

## 1. 文档目标

本文用于帮助后续开发人员快速理解项目结构，定位关键逻辑，并在出现问题时有明确的排查入口。

覆盖范围：
- src 下全部 TypeScript 源文件
- 对每个文件说明主要职责
- 对每个类与函数说明主要作用
- 给出常见问题的排查建议

## 2. 项目分层概览

### 2.1 入口与插件生命周期
- src/main.ts

### 2.2 AI 调用与流式输出
- src/ai.ts
- src/commands/registerCommands.ts

### 2.3 编辑器与预览中的代码块交互
- src/codeBlockCollapser.ts
- src/editorCodeBlockCollapser.ts
- src/selectionStore.ts
- src/promptSuggest.ts

### 2.4 侧栏视图与配置面板
- src/aiTaskView.ts
- src/settings.ts

### 2.5 记忆系统
- src/memory/memoryManager.ts
- src/memory/conversationStore.ts
- src/memory/compressionService.ts
- src/memory/fileSystemAdapter.ts
- src/memory/tokenEstimator.ts
- src/memory/types.ts

## 3. 文件级说明

## 3.1 src/main.ts

文件职责：
- 插件主入口
- 负责 onload 时初始化设置、记忆系统、视图、命令、编辑器扩展、菜单和设置页

类与方法：

1) MyPlugin extends Plugin
- onload
  - 插件启动总流程
  - 初始化 settings
  - 初始化 MemoryManager
  - 注册 AI task view
  - 注册命令 registerPluginCommands
  - 注册提示词建议 AIPromptSuggest
  - 注册设置页 SampleSettingTab
  - 注册预览模式代码块折叠 registerCodeBlockCollapser
  - 注册 Live Preview 折叠扩展 createEditorCodeBlockCollapserExtension
  - 注册编辑器右键菜单
- activateView
  - 打开或激活 AI_TASK_VIEW_TYPE 对应侧栏视图
- openSampleModal
  - 打开示例弹窗
- onunload
  - 插件卸载入口，目前无自定义逻辑
- loadSettings
  - 从磁盘读取设置并合并默认值
  - 额外兜底系统提示词列表与激活 ID
- saveSettings
  - 保存 settings 到插件数据

2) SampleModal extends Modal
- onOpen
  - 打开时渲染简单文本
- onClose
  - 关闭时清空内容

常见排障入口：
- 插件启动失败：先看 onload 是否在某个初始化步骤抛错
- 侧栏打不开：看 activateView 和 registerView 是否一致
- 设置不生效：看 loadSettings 与 saveSettings 调用链

## 3.2 src/settings.ts

文件职责：
- 定义配置类型
- 提供默认配置
- 定义插件设置页 UI 与交互

类型与常量：
- NamedPrompt
  - 具名提示词对象结构
- MyPluginSettings
  - 全部设置字段定义
- DEFAULT_SETTINGS
  - 默认配置值

类与方法：

1) SampleSettingTab extends PluginSettingTab
- display
  - 渲染设置页全部分组
  - 代码块设置
  - AI 接口设置
  - 系统提示词和自定义提示词设置
  - 记忆系统设置

常见排障入口：
- 某个设置项无法保存：排查对应 onChange 内是否更新到 this.plugin.settings 并调用 saveSettings
- 默认值异常：看 DEFAULT_SETTINGS 与 main.ts 中 loadSettings 的兜底逻辑

## 3.3 src/ai.ts

文件职责：
- 承担 AI 流式调用
- 负责上下文和系统提示词拼装
- 解析 SSE 流并将分片回调给上层

类型：
- AIStreamCallbacks
  - onReasoning
  - onContent
  - onError
  - onComplete
- AIMessage
  - role + content

函数：

1) streamDashScope
- 输入用户问题、上下文、模型参数、回调函数
- 组装 systemPrompt，并注入 CONTEXT 与 MEMORY
- 发起 stream=true 的 fetch 请求
- 持续读取 response.body 并解析 data: 行
- 将 reasoning_content 和 content 分别回调给调用方
- 出错时调用 onError
- 流结束后调用 onComplete

常见排障入口：
- AI 无返回：先检查 apiKey、baseUrl、model
- 输出中断：检查 response.body 是否为空或 JSON 解析报错
- 记忆注入不生效：检查 MEMORY 占位符替换逻辑和调用方传参

## 3.4 src/selectionStore.ts

文件职责：
- 统一管理 AI 上下文中的代码块选择状态
- 提供选中集合和历史集合

类型与接口：
- CodeBlockMode
- CodeBlockContext
- CreateCodeBlockContextInput

函数：

1) hashString
- 用于对内容做轻量哈希，参与上下文 ID 生成

2) createCodeBlockContext
- 规范化输入文本与元信息
- 生成稳定 ID
- 返回标准 CodeBlockContext

类与方法：

1) CodeBlockSelectionStore
- addToHistory
  - 将移除项记录到历史列表，最多保留 5 条
- subscribe
  - 注册状态变更监听
- notify
  - 触发所有监听
- toggle
  - 选中/取消选中切换
- remove
  - 按 ID 移除选中项，并加入历史
- isSelected
  - 判断是否已选中
- getSelectedContexts
  - 返回按 selectedAt 排序的选中上下文
- getHistory
  - 返回历史上下文
- clear
  - 清空选中并全部转入历史

常见排障入口：
- 选中状态和 UI 不一致：检查 subscribe 回调是否正确刷新视图
- 重复上下文无法区分：检查 createCodeBlockContext 的 ID 拼接字段

## 3.5 src/promptSuggest.ts

文件职责：
- 提供 //// 内联提示词补全

常量：
- BUILTIN_PROMPTS

类与方法：

1) AIPromptSuggest extends EditorSuggest
- onTrigger
  - 识别 //// 环境并构造补全触发范围
- getSuggestions
  - 返回自定义提示词 + 内置提示词，按 query 过滤
- renderSuggestion
  - 渲染补全项文本
- selectSuggestion
  - 用选中项替换编辑器中的查询片段

常见排障入口：
- 输入 //// 没弹出建议：优先看 onTrigger 的正则匹配条件
- 建议列表缺少自定义项：看 settings.customPrompts 数据来源

## 3.6 src/codeBlockCollapser.ts

文件职责：
- 在阅读模式预览区域，为代码块注入自定义头部、选择按钮、折叠按钮、复制按钮布局

函数：

1) registerCodeBlockCollapser
- 注册 MarkdownPostProcessor
- 扫描 pre 元素并只处理一次
- 创建 wrapper/header/按钮组
- 构造 CodeBlockContext 并绑定选择状态
- 处理折叠展开逻辑
- 将原生复制按钮迁移到自定义头部

常见排障入口：
- 阅读模式无折叠按钮：检查 post processor 是否被注册
- 复制按钮错位：检查 MutationObserver 是否拿到 copy-code-button

## 3.7 src/editorCodeBlockCollapser.ts

文件职责：
- 在 Live Preview 编辑器中实现代码块折叠、展开、复制和上下文选择
- 基于 CodeMirror StateField 与 Decoration 实现

核心类型：
- CodeBlockPosition
- toggleFoldEffect

核心类：

1) FoldToggleWidget extends WidgetType
- 渲染未折叠状态的顶部/底部工具条
- 提供选择、复制、折叠按钮
- 点击折叠后派发 toggleFoldEffect

2) FoldedCodeBlockWidget extends WidgetType
- 渲染折叠态占位块
- 提供展开、复制、选择按钮

核心函数：

1) getCollapsedPreview
- 生成折叠态预览文本

2) getCodeContentForCopy
- 从代码块文本中剥离围栏并返回纯代码

3) createCopyButton
- 创建复制按钮并处理复制成功/失败反馈

4) copyCodeToClipboard
- 优先走 navigator.clipboard，失败回退到 execCommand

5) copyWithExecCommand
- 旧方案复制兜底

6) findCodeBlockPositions
- 扫描文档，找到 fenced code block 的起止位置

7) createEditorBlockContext
- 从 EditorView + block 生成 CodeBlockContext

8) updateSelectionButtonState
- 更新选中按钮视觉状态

9) createSelectionButton
- 创建上下文选择按钮

10) createFoldDecoration
- 为代码块创建折叠态 Decoration

11) createFoldField
- 创建 StateField，管理折叠集合及 effect 更新

12) buildToggleDecorations
- 构建顶部/底部工具条 Decoration

13) createEditorCodeBlockCollapserExtension
- 导出最终扩展数组，供 main.ts 注册

常见排障入口：
- Live Preview 折叠失效：优先看 createFoldField 和 toggleFoldEffect
- 代码复制空内容：看 getCodeContentForCopy 对围栏剥离逻辑
- 按钮重复渲染：看 Widget eq 比较与 decoration 重建逻辑


## 3.8 src/aiTaskView.ts

文件职责：
- AI 侧栏视图
- 显示当前上下文、历史上下文、提示词管理、记忆开关、思考开关

常量：
- AI_TASK_VIEW_TYPE

类与方法：

1) AITaskView extends ItemView
- getViewType
  - 返回视图类型
- getDisplayText
  - 返回显示名
- getIcon
  - 返回侧栏图标
- onOpen
  - 构建 UI、注册事件、订阅 store 和 memory 变更
- onClose
  - 解除订阅
- updateMemoryToggleBtn
  - 刷新记忆开关按钮状态
- updateThinkingToggleBtn
  - 刷新思考开关按钮状态
- renderContexts
  - 渲染 Active Contexts 与 History
  - 渲染系统/灵魂提示词配置区
- renderPromptConfig
  - 渲染指定提示词组的新增、选择、删除、编辑逻辑

常见排障入口：
- 侧栏列表不刷新：检查 store.subscribe 回调是否触发
- Prompt 下拉与文本不同步：看 renderPromptConfig 的 select.onchange 与输入框 onchange

## 3.9 src/commands/registerCommands.ts

文件职责：
- 统一注册插件命令
- 包含 AI completion 核心执行流

类型：
- CommandDefinition
- CommandHost

函数：

1) registerPluginCommands
- 注册全部命令，主要包括：
  - open-ai-task-view
  - toggle-memory
  - toggle-thinking
  - open-modal-simple
  - replace-selected
  - add-selected-text-to-context
  - copy-selected-code-block-contexts
  - insert-ai-question-markers
  - clear-selected-code-blocks
  - ai-completion
  - clear-memory-session
  - open-modal-complex

ai-completion 内关键局部函数：
- insertStreamChunk
  - 通过 CodeMirror dispatch 写入流式文本，scrollIntoView=false
- setStreamCursor
  - 在流完成后将光标移动到最终位置

ai-completion 主流程：
- 提取 //问题//
- 插入分割线和思考区占位
- 调用 streamDashScope
- 处理 onReasoning 与 onContent 分片
- onComplete 收尾分割线并记录记忆

常见排障入口：
- 快捷键无效：检查命令 id 与热键冲突
- AI 输出位置异常：看 currentLine/currentCh 维护和 insertStreamChunk
- 输出完成后光标不正确：看 setStreamCursor 调用点

## 3.10 src/memory/types.ts

文件职责：
- 记忆系统的数据类型定义

类型：
- LongTermMemoryTag
- ConfidenceLevel
- ConversationTurn
- LongTermMemoryEntry
- UserProfile
- MemorySettings

常见排障入口：
- 记忆数据结构不一致：先核对这里与 compressionService 的映射关系

## 3.11 src/memory/tokenEstimator.ts

文件职责：
- 提供轻量 Token 估算

函数：

1) estimateTokens
- 基于字符长度近似估算 token 数

常见排障入口：
- 压缩触发过早或过晚：检查该估算策略与阈值配置是否匹配实际模型

## 3.12 src/memory/conversationStore.ts

文件职责：
- 记忆系统的会话内存状态容器

类与方法：

1) ConversationStore
- addTurn
  - 追加一轮 user/assistant 消息并累计 token
- shouldCompress
  - 根据 token 和用户轮次判断是否触发压缩
- getAllTurns
  - 获取完整 turns
- getRecentTurns
  - 获取最近 N 轮对话
- getTurnsToCompress
  - 获取应压缩部分
- replaceTurnsWithSummary
  - 用摘要替换旧对话并保留最近窗口
- getSummaryPrefix
- setSummaryPrefix
- getTotalTokens
- getTurnCount
- toMessages
  - 转为 AI API 可消费消息数组
- clear
  - 清空状态

常见排障入口：
- 压缩窗口不符合预期：看 getTurnsToCompress 与 replaceTurnsWithSummary 的 keepCount

## 3.13 src/memory/fileSystemAdapter.ts

文件职责：
- 对 Obsidian vault adapter 的文件读写封装

常量：
- MEMORY_FILE_TEMPLATES
  - 记忆系统初始化模板文件

类与方法：

1) FileSystemAdapter
- resolvePath
  - 拼接 baseDir 与相对路径
- ensureDirectories
  - 创建目录与模板文件
- readFile
  - 读取文件，文件不存在时返回空字符串
- writeFile
  - 覆盖写入文件
- appendFile
  - 追加写入
- writeArchive
  - 写入归档会话文件
- updateIndex
  - 更新记忆索引文件

常见排障入口：
- 记忆文件未生成：看 ensureDirectories 是否调用
- 路径异常：检查 memoryDirectory 配置和 resolvePath 输出

## 3.14 src/memory/compressionService.ts

文件职责：
- 执行对话压缩
- 抽取长期记忆
- 更新用户画像

内部函数：

1) callAIOnce
- 非流式调用 AI，用于摘要、抽取和画像更新

2) extractJsonArray
- 从模型返回文本中提取 JSON 数组并解析

类与方法：

1) CompressionService
- compress
  - 并发保护入口，避免重复压缩
- doCompress
  - 压缩主流程：短期摘要、归档、长期记忆抽取、索引更新
- updateLongTermMemory
  - 按 tag 更新 knowledge/events/personality 文件
- updateUserProfile
  - 根据 personality 条目更新 user-profile.md

常见排障入口：
- 压缩不触发：看 MemoryManager.recordTurn 的阈值判断与 shouldCompress
- 长期记忆为空：检查 extractJsonArray 与模型返回格式
- 用户画像不更新：看 personality 过滤和 updateUserProfile 调用条件

## 3.15 src/memory/memoryManager.ts

文件职责：
- 记忆系统门面层
- 对外提供启停、订阅、历史注入、记录对话

类与方法：

1) MemoryManager
- toggle
  - 开关 active 状态
- isActive
  - 获取当前 active 状态
- subscribe
  - 订阅记忆状态变化
- notify
  - 通知订阅者
- init
  - 初始化文件系统并加载短期摘要
- recordTurn
  - 记录一轮对话并按阈值触发压缩
- getConversationHistory
  - 返回注入模型的历史消息
- buildMemoryContext
  - 生成可注入系统提示词的 MEMORY 文本
- clearSession
  - 清空会话内存
- isEnabled
  - 返回配置层是否启用记忆系统

常见排障入口：
- 记忆按钮显示 ON 但无效果：区分 active 与 memoryEnabled 两层状态
- 压缩回调未更新上下文：看 onSummaryReady 中 replaceTurnsWithSummary 是否执行

## 4. 常见问题快速定位

1) AI 无法输出
- 先看 src/ai.ts 中 streamDashScope 是否触发 onError
- 再看 src/commands/registerCommands.ts 中 ai-completion 对问题格式 //问题// 的匹配

2) 输出位置、滚动、光标异常
- 重点看 src/commands/registerCommands.ts 中 insertStreamChunk、currentLine/currentCh、setStreamCursor

3) 代码块选择与折叠行为异常
- 阅读模式：src/codeBlockCollapser.ts
- Live Preview：src/editorCodeBlockCollapser.ts
- 状态存储：src/selectionStore.ts

4) 记忆系统不生效
- 配置与开关：src/settings.ts、src/memory/memoryManager.ts
- 压缩流程：src/memory/compressionService.ts
- 文件落盘：src/memory/fileSystemAdapter.ts

## 5. 后续维护建议

1) 将 registerCommands.ts 中 ai-completion 逻辑进一步拆分为独立模块，便于测试与回归。
2) 为 streamDashScope 增加可取消能力与超时控制。
3) 为记忆系统增加更明确的持久化一致性策略，避免仅内存状态变化。
4) 为关键模块补最小化测试：selectionStore、conversationStore、SSE 解析。

