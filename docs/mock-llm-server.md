# Mock LLM Server 方案

本文档设计一个本地 Mock LLM Server，用于拦截 OpenCode 发送的完整 API 请求并导出为 JSON 文件，以便分析和调试。

## 1. 目标

1. 在本地创建一个 Mock LLM Server，接收 OpenAI-Compatible 格式的 API 请求
2. 配置 OpenCode 连接到这个 Mock Server
3. Mock Server 拦截完整请求（包括 headers、body、tools 等），导出为 JSON 文件
4. 返回一个有效的响应，使 OpenCode 不报错（可以是简单的文本回复）

## 2. 架构设计

```
┌─────────────┐     HTTP POST      ┌─────────────────────────┐
│  OpenCode   │ ─────────────────→ │   Mock LLM Server       │
│  (CLI)      │     /v1/chat/      │   (localhost:4199)      │
│             │     completions    │                         │
│             │ ←───────────────── │   1. 记录完整请求       │
│             │   SSE stream       │   2. 保存为 JSON 文件   │
│             │   response         │   3. 返回假响应         │
└─────────────┘                    └─────────────────────────┘
                                           │
                                           ▼
                                   captured-requests/
                                   ├── 2026-03-17T10-30-00_001.json
                                   ├── 2026-03-17T10-30-05_002.json
                                   └── ...
```

## 3. Mock Server 实现

使用 Bun 的内置 HTTP 服务器实现，无需额外依赖。

### 3.1 创建 Mock Server 脚本

**文件: `packages/opencode/script/mock-llm-server.ts`**

```typescript
#!/usr/bin/env bun

import { mkdir } from "fs/promises"
import { join } from "path"

const PORT = Number(process.env.MOCK_PORT) || 4199
const OUTPUT_DIR = process.env.MOCK_OUTPUT_DIR || join(import.meta.dir, "..", "captured-requests")

await mkdir(OUTPUT_DIR, { recursive: true })

let counter = 0

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // 处理 CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      })
    }

    // 只拦截 POST 请求（chat completions / responses）
    if (req.method === "POST") {
      counter++
      const body = await req.json()

      // 构建完整的请求记录
      const record = {
        _metadata: {
          captured_at: new Date().toISOString(),
          sequence: counter,
          method: req.method,
          url: url.pathname + url.search,
          full_url: req.url,
        },
        headers: Object.fromEntries(req.headers.entries()),
        body,
      }

      // 保存到文件
      const filename = `${timestamp()}_${String(counter).padStart(3, "0")}.json`
      const filepath = join(OUTPUT_DIR, filename)
      await Bun.write(filepath, JSON.stringify(record, null, 2))
      console.log(`[${counter}] Captured: ${req.method} ${url.pathname} → ${filename}`)
      console.log(`  Model: ${body.model ?? "unknown"}`)
      console.log(`  Messages: ${body.messages?.length ?? body.input?.length ?? 0}`)
      console.log(`  Tools: ${body.tools?.length ?? 0}`)

      // 判断请求格式并返回对应的响应
      const isStreaming = body.stream === true || body.stream === undefined

      // OpenAI Responses API 格式 (有 input 字段)
      if (body.input) {
        return respondOpenAIResponses(body, isStreaming)
      }

      // OpenAI Chat Completions API 格式 (有 messages 字段)
      return respondChatCompletions(body, isStreaming)
    }

    // GET /v1/models — 返回模型列表
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [
          {
            id: "mock-model",
            object: "model",
            created: Date.now(),
            owned_by: "mock",
          },
        ],
      })
    }

    // 其他请求返回 404
    return new Response("Not Found", { status: 404 })
  },
})

function respondChatCompletions(body: any, streaming: boolean) {
  const model = body.model ?? "mock-model"

  if (streaming) {
    // SSE 流式响应
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const id = `chatcmpl-mock-${counter}`
        // 发送流式文本
        const chunks = [
          {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          },
          {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {
                  content:
                    "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复，不会调用任何工具。",
                },
                finish_reason: null,
              },
            ],
          },
          {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
            },
          },
        ]

        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  // 非流式响应
  return Response.json({
    id: `chatcmpl-mock-${counter}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复，不会调用任何工具。",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    },
  })
}

function respondOpenAIResponses(body: any, streaming: boolean) {
  const model = body.model ?? "mock-model"

  if (streaming) {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const id = `resp-mock-${counter}`

        const events = [
          {
            type: "response.created",
            response: {
              id,
              object: "response",
              status: "in_progress",
              model,
              output: [],
            },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "message",
              id: `msg-mock-${counter}`,
              role: "assistant",
              status: "in_progress",
              content: [],
            },
          },
          {
            type: "response.content_part.added",
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
            },
          },
          {
            type: "response.output_text.delta",
            output_index: 0,
            content_index: 0,
            delta:
              "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复。",
          },
          {
            type: "response.output_text.done",
            output_index: 0,
            content_index: 0,
            text: "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复。",
          },
          {
            type: "response.content_part.done",
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复。",
            },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: `msg-mock-${counter}`,
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复。",
                },
              ],
            },
          },
          {
            type: "response.completed",
            response: {
              id,
              object: "response",
              status: "completed",
              model,
              output: [
                {
                  type: "message",
                  id: `msg-mock-${counter}`,
                  role: "assistant",
                  status: "completed",
                  content: [
                    {
                      type: "output_text",
                      text: "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复。",
                    },
                  ],
                },
              ],
              usage: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
              },
            },
          },
        ]

        for (const event of events) {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          )
        }
        controller.close()
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }

  return Response.json({
    id: `resp-mock-${counter}`,
    object: "response",
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: `msg-mock-${counter}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "[Mock Response] 请求已被 Mock LLM Server 拦截并保存。这是一个自动回复。",
          },
        ],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
    },
  })
}

console.log(`\n🔧 Mock LLM Server started`)
console.log(`   Listening on: http://localhost:${PORT}`)
console.log(`   Output dir:   ${OUTPUT_DIR}`)
console.log(`\n   Endpoints:`)
console.log(`     POST /v1/chat/completions  (Chat Completions API)`)
console.log(`     POST /v1/responses         (Responses API)`)
console.log(`     GET  /v1/models            (Model listing)`)
console.log(`\n   Captured requests will be saved as JSON files.`)
console.log(`   Press Ctrl+C to stop.\n`)
```

### 3.2 运行 Mock Server

```bash
cd packages/opencode
bun run script/mock-llm-server.ts
```

可通过环境变量配置：

```bash
MOCK_PORT=4199 MOCK_OUTPUT_DIR=./captured-requests bun run script/mock-llm-server.ts
```

## 4. 配置 OpenCode 连接 Mock Server

### 4.1 方式一：配置文件（推荐）

编辑 `.opencode/opencode.json`（项目级）或 `~/.config/opencode/config.json`（全局）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "mock/mock-model",
  "provider": {
    "mock": {
      "name": "Mock LLM",
      "api": "http://localhost:4199/v1",
      "npm": "@ai-sdk/openai-compatible",
      "env": [],
      "models": {
        "mock-model": {
          "name": "Mock Model",
          "id": "mock-model",
          "tool_call": true,
          "temperature": true,
          "reasoning": false,
          "attachment": false,
          "modalities": {
            "input": ["text"],
            "output": ["text"]
          },
          "limit": {
            "context": 128000,
            "output": 16000
          },
          "cost": {
            "input": 0,
            "output": 0
          }
        }
      },
      "options": {
        "apiKey": "mock-key",
        "baseURL": "http://localhost:4199/v1"
      }
    }
  }
}
```

**关键配置说明：**

- `"model": "mock/mock-model"` — 设置默认使用 mock provider 的 mock-model
- `"npm": "@ai-sdk/openai-compatible"` — 使用 OpenAI-Compatible SDK，这样请求会走标准的 `/v1/chat/completions` 端点
- `"api": "http://localhost:4199/v1"` — Mock Server 地址
- `"options.baseURL"` — SDK 的 baseURL
- `"options.apiKey"` — 随意填写，Mock Server 不验证
- `cost.input/output = 0` — 避免 opencode provider 过滤逻辑将模型移除

### 4.2 方式二：环境变量

如果想使用已有的 OpenAI provider 但重定向到 Mock Server：

```bash
OPENAI_API_KEY=mock-key OPENAI_BASE_URL=http://localhost:4199/v1 bun run dev
```

但此方式会尝试使用 OpenAI 的 Responses API 格式，需要 Mock Server 同时支持该格式（上面的实现已经支持）。

### 4.3 方式三：自定义 provider 配置（同时拦截 Anthropic 格式）

如果希望同时拦截 Anthropic Messages API 格式的请求，可以配置一个使用 `@ai-sdk/anthropic` SDK 的 provider：

```json
{
  "provider": {
    "mock-anthropic": {
      "name": "Mock Anthropic",
      "npm": "@ai-sdk/anthropic",
      "env": [],
      "models": {
        "mock-claude": {
          "name": "Mock Claude",
          "id": "mock-claude",
          "tool_call": true,
          "temperature": false,
          "reasoning": true,
          "attachment": true,
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 200000,
            "output": 16000
          },
          "cost": {
            "input": 0,
            "output": 0
          }
        }
      },
      "options": {
        "apiKey": "mock-key",
        "baseURL": "http://localhost:4199"
      }
    }
  }
}
```

注意：Anthropic SDK 发送到 `{baseURL}/v1/messages`，所以 Mock Server 需要相应地处理该端点。Mock Server 的通用 POST 处理已经可以拦截所有路径。

## 5. 使用流程

### 5.1 完整操作步骤

```bash
# 终端 1: 启动 Mock Server
cd packages/opencode
bun run script/mock-llm-server.ts

# 终端 2: 运行 OpenCode（配置好 mock provider 后）
cd /your/project
bun run dev

# 在 OpenCode TUI 中输入任何提问
# → Mock Server 拦截请求并保存为 JSON

# 终端 3: 查看捕获的请求
ls packages/opencode/captured-requests/
cat packages/opencode/captured-requests/2026-03-17T10-30-00_001.json | jq .
```

### 5.2 捕获的 JSON 文件格式

```json
{
  "_metadata": {
    "captured_at": "2026-03-17T10:30:00.123Z",
    "sequence": 1,
    "method": "POST",
    "url": "/v1/chat/completions",
    "full_url": "http://localhost:4199/v1/chat/completions"
  },
  "headers": {
    "content-type": "application/json",
    "authorization": "Bearer mock-key",
    "user-agent": "opencode/1.2.27",
    "...": "..."
  },
  "body": {
    "model": "mock-model",
    "messages": [
      {
        "role": "system",
        "content": "You are powered by the model named mock-model..."
      },
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "请帮我读取 README.md"
          }
        ]
      }
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "read",
          "description": "Read a file or directory...",
          "parameters": {
            "type": "object",
            "properties": {
              "filePath": { "type": "string" },
              "offset": { "type": "number" },
              "limit": { "type": "number" }
            },
            "required": ["filePath"]
          }
        }
      },
      "... 其他工具 ..."
    ],
    "stream": true,
    "temperature": null,
    "max_tokens": 16000
  }
}
```

### 5.3 一键抓取：`make getreq`

项目根目录的 `Makefile` 提供了端到端自动化流程：

```bash
# 默认使用 "hello" 作为 prompt
make getreq

# 自定义 prompt
make getreq MOCK_PROMPT="请帮我读取 README.md"

# 自定义端口和输出目录
make getreq MOCK_PORT=5000 MOCK_OUTPUT_DIR=./my-reqs
```

`make getreq` 自动完成以下步骤：
1. 生成 mock provider 配置文件到 `docs/extra/mock-opencode.json`
2. 启动 Mock LLM Server（后台运行）
3. 在临时目录 `/tmp/opencode-mock` 中执行 `opencode run`，通过 `OPENCODE_CONFIG` 环境变量加载 mock 配置
4. 停止 Mock Server
5. 列出捕获的请求文件

输出示例：
```
=== Done! Captured requests ===
-rw-r--r--  3130  docs/extra/reqs/2026-03-17T23-39-16-752_001.json
-rw-r--r-- 64014  docs/extra/reqs/2026-03-17T23-39-21-392_002.json
```

每次 `opencode run` 通常产生 2 个请求：
- 请求 001（~3KB）：标题生成（title agent），不含 tools
- 请求 002（~64KB）：主对话（build agent），包含完整 system prompt 和 15 个 tools

其他 Makefile targets：
- `make mock-server` — 单独启动 Mock Server（前台运行，用于配合手动测试）
- `make clean-reqs` — 清理捕获的请求文件

**注意事项：**
- 如果系统没有全局安装 `bun`，Makefile 会自动 fallback 到 `npx bun`
- OpenCode 的 `run` 命令在非 TTY 环境下会等待 stdin 输入，Makefile 通过 `< /dev/null` 解决

### 5.4 分析捕获的请求

```bash
# 查看所有请求的工具名称
cat docs/extra/reqs/*.json | jq -r '.body.tools[]?.function?.name' | sort -u

# 查看某个请求中所有工具的描述长度
cat docs/extra/reqs/*_002.json | jq '[.body.tools[] | {name: .function.name, desc_length: (.function.description | length)}]'

# 提取工具定义为独立文件
cat docs/extra/reqs/*_002.json | jq '.body.tools' > tools-snapshot.json
```

## 6. 高级用法

### 6.1 使 Mock Server 返回 Tool Call（触发工具执行）

如果需要测试完整的 tool call 流程，可以修改 Mock Server 使其返回 tool call 响应：

```typescript
// 在 respondChatCompletions 中修改为返回 tool call
const choices = [{
  index: 0,
  message: {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: "call_mock_001",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ filePath: "/tmp/test.txt" })
      }
    }]
  },
  finish_reason: "tool_calls"
}]
```

这会触发 OpenCode 执行 read 工具，然后发送第二个请求（包含 tool result），从而可以捕获完整的多轮交互。

### 6.2 对比 OpenCode 和 Claude Code 的请求

1. 先用 Mock Server 捕获 OpenCode 的请求
2. 对比 `docs/extra/Anthropic_API_POST_request_original.json`（Claude Code 的请求）
3. 重点对比 `tools` 字段中的 `name`, `description`, `input_schema` / `parameters`

```bash
# 提取 OpenCode 的工具名列表
cat captured-requests/001.json | jq -r '.body.tools[].function.name' | sort

# 提取 Claude Code 的工具名列表
cat docs/extra/Anthropic_API_POST_request_original.json | jq -r '.tools[].name' | sort

# 对比
diff <(cat captured-requests/001.json | jq -r '.body.tools[].function.name' | sort) \
     <(cat docs/extra/Anthropic_API_POST_request_original.json | jq -r '.tools[].name' | sort)
```

### 6.3 配置为透明代理（拦截后转发到真实 API）

如果需要同时拦截和使用真实 API，可以修改 Mock Server 为透明代理模式：

```typescript
const REAL_API = process.env.REAL_API_URL || "https://api.openai.com"
const REAL_KEY = process.env.REAL_API_KEY

// 保存请求后，转发到真实 API
const realResponse = await fetch(`${REAL_API}${url.pathname}`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${REAL_KEY}`,
  },
  body: JSON.stringify(body),
})
return realResponse
```

## 7. 注意事项

1. **端口冲突**: 默认使用 4199 端口，避免与 OpenCode 的 HTTP Server（默认 4096）冲突
2. **请求大小**: 包含完整 system prompt 和 tools 的请求可能很大（数十 KB），JSON 文件相应也很大
3. **多轮交互**: Mock Server 返回 `stop` finish reason，所以 OpenCode 不会继续循环。如果需要测试多轮，需要修改为返回 `tool_calls`
4. **流式 vs 非流式**: OpenCode 默认使用流式请求。Mock Server 已经处理了两种情况
5. **Anthropic 格式**: 如果使用 `@ai-sdk/anthropic` SDK，请求格式与 OpenAI-Compatible 不同，Mock Server 的通用 POST 处理可以拦截但响应格式需要适配
