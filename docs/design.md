# OpenCode 项目设计说明

## 1. 项目概述

OpenCode 是一个 AI 驱动的开发工具（类似于 Claude Code 的开源版本），提供命令行 (CLI)、TUI、Web、桌面端等多种交互方式。用户可以通过自然语言与 LLM 交互，LLM 能够调用各种工具（读写文件、执行命令、搜索代码等）来辅助完成软件工程任务。

**核心特性：**

- 多 LLM 提供商支持（OpenAI、Anthropic、Google、Azure、Bedrock、OpenRouter 等 20+ 家）
- 丰富的内置工具集（bash、read、write、edit、grep、glob、task、websearch 等）
- MCP (Model Context Protocol) 支持
- 插件系统
- Agent 系统（多种预设 agent 模式）
- 会话管理与上下文压缩
- 本地 SQLite 持久化

## 2. 整体架构

```
┌───────────────────────────────────────────────────────┐
│                    用户界面层                         │
│  ┌─────┐  ┌─────┐  ┌──────┐  ┌────────┐  ┌────────┐   │
│  │ CLI │  │ TUI │  │ Web  │  │Desktop │  │Desktop │   │
│  │     │  │     │  │ App  │  │(Tauri) │  │(Elctrn)│   │
│  └──┬──┘  └──┬──┘  └──┬───┘  └───┬────┘  └───┬────┘   │
│     └────────┴────────┴──────────┴────────────┘       │
│                       │                               │
│             ┌─────────▼─────────┐                     │
│             │   HTTP Server     │  (Hono)             │
│             │   src/server/     │                     │
│             └─────────┬─────────┘                     │
└───────────────────────┼───────────────────────────────┘
                        │
┌───────────────────────┼───────────────────────────────┐
│                     核心层                            │
│             ┌─────────▼─────────┐                     │
│             │  Session 管理     │                     │
│             │  prompt.ts        │                     │
│             │  processor.ts     │                     │
│             │  llm.ts           │                     │
│             └─────────┬─────────┘                     │
│    ┌──────────────────┼──────────────────┐            │
│    │                  │                  │            │
│  ┌─▼────┐     ┌──────▼───────┐   ┌──────▼─────┐       │
│  │Agent │     │  Provider    │   │  Tool      │       │
│  │      │     │              │   │            │       │
│  └──────┘     └──────────────┘   └────────────┘       │
│                                                       │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐        │
│  │MCP       │  │ Plugin    │  │ Permission   │        │
│  └──────────┘  └───────────┘  └──────────────┘        │
└───────────────────────────────────────────────────────┘
                        │
┌───────────────────────┼───────────────────────────────┐
│                    存储层                             │
│             ┌─────────▼─────────┐                     │
│             │  SQLite (Drizzle) │                     │
│             │  Session, Message │                     │
│             │  Part, etc.       │                     │
│             └───────────────────┘                     │
└───────────────────────────────────────────────────────┘
```

## 3. 包 (Package) 结构

项目采用 Bun workspace monorepo 结构，主要包如下：

| 包名 | 路径 | 说明 |
|------|------|------|
| `opencode` | `packages/opencode` | **核心包**：CLI、Server、Agent、Tool、Provider、Session 全部逻辑 |
| `@opencode-ai/plugin` | `packages/plugin` | 插件 SDK，定义工具插件接口 |
| `@opencode-ai/script` | `packages/script` | 版本、通道、发布脚本 |
| `@opencode-ai/util` | `packages/util` | 共享工具函数 |
| `@opencode-ai/sdk` | `packages/sdk/js` | JavaScript SDK（从 OpenAPI spec 自动生成） |
| `@opencode-ai/app` | `packages/app` | Web 前端 (SolidJS + Vite) |
| `@opencode-ai/ui` | `packages/ui` | 共享 UI 组件库 |
| `@opencode-ai/desktop` | `packages/desktop` | Tauri 桌面应用 |
| `@opencode-ai/desktop-electron` | `packages/desktop-electron` | Electron 桌面应用 |
| `@opencode-ai/web` | `packages/web` | 文档站 (Astro) |
| `@opencode-ai/enterprise` | `packages/enterprise` | 企业版/团队部署 |
| `@opencode-ai/console-*` | `packages/console/*` | 控制台系列（App、Core、Mail、Resource、Function） |

## 4. 核心包 (`packages/opencode`) 源码结构

```
packages/opencode/src/
├── index.ts              # CLI 入口 (yargs)
├── cli/                  # CLI 命令层
│   └── cmd/              # 子命令 (run, serve, generate, mcp, tui, ...)
│       └── tui/          # TUI 界面 (SolidJS + OpenTUI)
│           ├── app.tsx   # TUI 主应用
│           └── worker.ts # TUI worker
├── server/               # HTTP Server (Hono)
│   └── routes/           # session, project, provider, mcp, pty, workspace...
├── session/              # 会话系统（核心）
│   ├── index.ts          # Session CRUD
│   ├── prompt.ts         # 主循环：构建 prompt → 调用 LLM → 处理 tool calls
│   ├── processor.ts      # 流处理：消费 AI SDK stream 事件
│   ├── llm.ts            # LLM 调用封装（streamText）
│   ├── message-v2.ts     # 消息模型与转换
│   ├── system.ts         # System prompt 构建
│   ├── instruction.ts    # 指令 prompt
│   ├── compaction.ts     # 上下文压缩
│   └── prompt/           # 各种 prompt 模板 (.txt)
├── provider/             # Provider 系统
│   ├── provider.ts       # Provider/Model 注册、SDK 加载
│   ├── transform.ts      # Provider 特定变换（消息格式、缓存、schema）
│   ├── models.ts         # models.dev 模型元数据
│   ├── schema.ts         # ProviderID, ModelID branded types
│   └── sdk/copilot/      # GitHub Copilot 自定义 SDK
├── tool/                 # 工具系统
│   ├── tool.ts           # Tool.Info / Tool.Context / Tool.define
│   ├── registry.ts       # ToolRegistry（注册、过滤）
│   ├── bash.ts           # bash 工具
│   ├── read.ts           # read 工具
│   ├── write.ts          # write 工具
│   ├── edit.ts           # edit 工具
│   ├── grep.ts           # grep 工具
│   ├── glob.ts           # glob 工具
│   ├── task.ts           # task（子 agent）工具
│   ├── websearch.ts      # websearch 工具
│   ├── webfetch.ts       # webfetch 工具
│   ├── codesearch.ts     # codesearch 工具
│   ├── skill.ts          # skill 工具
│   ├── apply_patch.ts    # apply_patch 工具（GPT-5 系列使用）
│   ├── todo.ts           # todo 工具
│   ├── batch.ts          # batch 工具（实验性）
│   ├── plan.ts           # plan_exit 工具
│   ├── lsp.ts            # lsp 工具（实验性）
│   └── invalid.ts        # 无效工具调用兜底
├── agent/                # Agent 系统
│   ├── agent.ts          # Agent 定义（build, plan, general, explore, title...）
│   └── generate.txt      # Agent 生成 prompt
├── mcp/                  # MCP 客户端
├── plugin/               # 插件加载
├── permission/           # 权限系统
├── project/              # 项目状态、VCS
├── config/               # 配置管理
├── storage/              # 数据库 schema、迁移
├── auth/                 # 认证
├── skill/                # Skill 发现与加载
├── lsp/                  # LSP 集成
├── shell/                # Shell 集成
├── file/                 # 文件操作
├── flag/                 # Feature flags
├── global/               # 全局状态
├── installation/         # 安装与版本检测
├── bus.ts                # 事件总线
└── env.ts                # 环境变量
```

## 5. 核心系统设计

### 5.1 Session 系统

Session 是整个交互的核心抽象，代表一次完整的对话。

**数据模型：**

- `Session.Info`: 包含 id, slug, projectID, directory, title, permission, time 等
- `MessageV2.User / MessageV2.Assistant`: 用户/助手消息
- `MessageV2.Part`: 消息中的内容片段（text, file, tool, reasoning, step-start, step-finish, compaction, subtask 等）

**存储：** Drizzle ORM + SQLite，表结构定义在 `*.sql.ts` 中。

**主循环 (`SessionPrompt.loop`)：**

```
用户输入 → createUserMessage()
       ↓
    loop() 循环 {
       ↓
  1. 加载消息历史 (MessageV2.stream)
  2. 检查是否有 pending subtask / compaction → 优先处理
  3. 检查上下文溢出 → 触发 compaction
  4. 构建 system prompt (SystemPrompt.environment + skills + instructions)
  5. 解析工具集 (resolveTools)
  6. 转换消息为 AI SDK 格式 (MessageV2.toModelMessages)
  7. 调用 processor.process → LLM.stream → streamText
  8. 处理流事件: text, reasoning, tool-call, tool-result, finish
  9. 若 finish == "tool-calls" → 继续循环
  10. 若 finish == "stop" / "length" → 退出循环
    }
```

### 5.2 Provider 系统

Provider 系统通过 Vercel AI SDK 抽象多家 LLM 提供商。

**Provider 注册流程：**

1. 从 `models.dev` 获取模型元数据（构建时快照 + 运行时更新）
2. 扫描环境变量、配置文件、API key 存储
3. 执行 `CUSTOM_LOADERS` 中的提供商特定初始化逻辑
4. 合并配置产生最终的 `Provider.Info` 和 `Provider.Model`

**支持的提供商：** OpenAI, Anthropic, Google, Google Vertex, Amazon Bedrock, Azure, OpenRouter, Mistral, Groq, xAI, Perplexity, Vercel, GitLab, GitHub Copilot, DeepInfra, Cerebras, Cohere, Gateway, TogetherAI, Cloudflare, SAP AI Core 等。

**关键变换 (`ProviderTransform`)：**

- `message()`: 规范化消息格式（空内容过滤、tool call ID 格式化、缓存标记）
- `schema()`: 规范化工具参数 schema（Gemini 需要 enum 转 string 等）
- `options()`: 生成提供商特定选项（reasoning effort, thinking config 等）
- `variants()`: 生成推理 effort 变体（low/medium/high/max）

### 5.3 Tool 系统

**Tool 定义接口：**

```typescript
Tool.Info = {
  id: string
  init(ctx?) → {
    description: string
    parameters: z.ZodType      // Zod schema
    execute(args, ctx) → {
      title: string
      metadata: any
      output: string
      attachments?: FilePart[]
    }
  }
}
```

**Tool 注册 (`ToolRegistry`)：**

1. 内置工具列表（bash, read, write, edit, grep, glob, task, webfetch, ...）
2. 自定义工具：从 `{tool,tools}/*.{js,ts}` 加载
3. 插件工具：从 Plugin 系统加载
4. MCP 工具：从 MCP Server 动态加载

**Tool 选择逻辑：**
- `websearch` / `codesearch`: 仅对 opencode provider 或启用 `OPENCODE_ENABLE_EXA` 时可用
- `apply_patch` vs `edit`/`write`: GPT-5 系列使用 apply_patch，其余使用 edit/write
- `question`: 仅在 app/cli/desktop 客户端中启用
- 权限系统可以 deny/allow 特定工具

### 5.4 Agent 系统

Agent 定义了不同的行为模式：

| Agent | 模式 | 说明 |
|-------|------|------|
| `build` | primary | 默认 agent，完整工具访问 |
| `plan` | primary | 计划模式，只读 + 仅可编辑 plan 文件 |
| `general` | subagent | 通用子 agent，用于并行任务 |
| `explore` | subagent | 探索 agent，受限工具（只读 + 搜索） |
| `title` | subagent | 生成会话标题 |
| `compaction` | subagent | 执行上下文压缩 |
| `summary` | subagent | 生成消息摘要 |

每个 Agent 具有独立的 permission 规则集和可选的固定 model/prompt/temperature。

### 5.5 MCP 系统

OpenCode 作为 MCP 客户端，可连接外部 MCP Server 获取额外工具：

- MCP 工具通过 `MCP.tools()` 获取
- 在 `resolveTools` 中与内置工具合并
- 支持 OAuth 认证
- MCP Server 可在配置文件中定义

### 5.6 Permission 系统

基于规则集 (Ruleset) 的权限控制：

```typescript
Ruleset = Array<{
  permission: string   // 工具名或权限类别
  action: "allow" | "deny" | "ask"
  pattern: string      // glob 模式匹配
}>
```

- Agent 级默认权限
- Session 级覆盖权限
- 用户配置级权限
- 支持 glob 模式匹配文件路径

### 5.7 Plugin 系统

插件可以扩展：

- 自定义工具 (`tool`)
- 认证提供商 (`auth`)
- 事件钩子 (`tool.execute.before`, `tool.execute.after`, `chat.message`, `chat.params`, `shell.env` 等)

## 6. 数据流

### 6.1 用户提问到 LLM 响应

```
用户输入文本/文件
    ↓
SessionPrompt.prompt(input)
    ↓
createUserMessage()     → 创建 User 消息 + Parts
    ↓
SessionPrompt.loop()
    ↓
resolveTools()          → 收集内置 + MCP + 插件工具
    ↓
SystemPrompt.build()    → 拼接 system prompt
    ↓
MessageV2.toModelMessages() → 转换为 AI SDK ModelMessage[]
    ↓
ProviderTransform.message() → 提供商特定消息规范化
    ↓
LLM.stream()            → streamText() 调用 AI SDK
    ↓
SessionProcessor         → 消费 stream 事件
    ├─ text-delta        → 更新 text part
    ├─ reasoning         → 更新 reasoning part  
    ├─ tool-input-start  → 创建 tool part (pending)
    ├─ tool-call         → 执行工具 (running → completed/error)
    ├─ tool-result       → 记录工具结果
    └─ finish            → 更新 assistant 消息
    ↓
若 finish=="tool-calls" → 回到 loop 继续
若 finish=="stop"       → 退出，返回最终 assistant 消息
```

### 6.2 Tool Call 执行流程

```
LLM 返回 tool-call 事件
    ↓
AI SDK 调用 tool.execute(args, options)
    ↓
Plugin.trigger("tool.execute.before")
    ↓
实际工具执行 (如 read/bash/edit...)
    ↓
结果截断处理 (Truncate.output)
    ↓
Plugin.trigger("tool.execute.after")
    ↓
结果返回给 AI SDK → 添加到消息历史
    ↓
LLM 继续生成（可能再次调用工具）
```

## 7. 配置系统

配置来源（优先级从高到低）：

1. 命令行参数
2. 环境变量
3. 项目级配置: `.opencode/opencode.json` 或 `opencode.json`
4. 全局配置: `~/.config/opencode/config.json`

配置内容包括：

- `model`: 默认模型
- `provider`: 提供商配置（apiKey, baseURL, models 等）
- `disabled_providers` / `enabled_providers`: 启用/禁用提供商
- `permission`: 全局权限规则
- `mcp`: MCP Server 配置
- `experimental`: 实验性功能开关

## 8. 技术栈

| 技术 | 用途 |
|------|------|
| **Bun** | 运行时 & 构建系统 |
| **TypeScript** | 开发语言 |
| **Vercel AI SDK** (`ai`) | LLM 抽象层 |
| **Zod** | Schema 验证 |
| **yargs** | CLI 参数解析 |
| **Drizzle ORM** | SQLite ORM |
| **Hono** | HTTP Server |
| **SolidJS** | TUI & Web 前端 |
| **Effect** | 部分模块使用的函数式效果系统 |
| **Turbo** | Monorepo 任务编排 |
| **MCP SDK** | Model Context Protocol 客户端 |
