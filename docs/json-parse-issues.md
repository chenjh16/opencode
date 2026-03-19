# Tool Call JSON 解析问题汇总与解决方案

## 概述

本文档汇总了 opencode 项目中 tool call JSON 解析相关的已知问题，并给出对应的解决方案。问题来源包括上游 open issue、社区报告以及本地实践中遇到的 case。

## 问题分类

### 1. 流式参数重复拼接（Streaming Argument Duplication） ✅ 已修复

**问题描述**：部分 OpenAI 兼容 provider（如 GLM-5 via vLLM/NIM/SGLang）在流式返回 tool call 时，会在后续 chunk 中重发完整的 JSON payload，而非增量 delta。opencode 的 provider 层始终执行 `arguments += delta`，导致最终拼接出重复的 JSON。

**典型错误**：
```
{"command":"pwd","description":"Check current directory"{"command": "pwd", "description": "Check current directory"}
```

**相关 Issue**：
- [#17315](https://github.com/anomalyco/opencode/issues/17315) — Tool calls result in JSON parsing error - parameters duplicated (ZhipuAI/GLM-5-FP8)
- [#12425](https://github.com/anomalyco/opencode/issues/12425) — Error message: JSON Parse error: Expected '}'
- [#13900](https://github.com/anomalyco/opencode/issues/13900) — GLM-5 via NVIDIA NIM emits malformed tool JSON
- [#13982](https://github.com/anomalyco/opencode/issues/13982) — GLM-5 keeps screwing up JSON parsing of read tool calling

**相关 PR**：
- [#17339](https://github.com/anomalyco/opencode/pull/17339) — fix(opencode): handle repeated full streamed tool-call arguments

**上游修复方案**（PR #17339）：在 provider SDK 的流式解析层检测重发的完整 JSON payload，使用 `pick()` 函数判断当前 chunk 是否为完整替换而非增量 delta。如果是完整替换，则存储为 `full` 字段而非追加到 `arguments`：

```typescript
function pick(raw: string, part: string, done: boolean) {
  if (!raw || !whole(part)) return
  const prev = raw.trim()
  const next = part.trim()
  if (!prev) return
  if (next.startsWith(prev) || done) return part
}
```

**本地防御方案**（sanitize 预处理器）✅ 已在 `llm.ts` 中实现：在 `experimental_repairToolCall` 中，`sanitize()` 函数会：
1. 检测 `"value"{` 模式（引号字符串后直接跟 `{`，且不在 `:` 之后）
2. 用 `extractBlock()` 提取后续 `{...}` 块
3. 用 `isDuplicate()` 判断块内容是否与前面的 key-value 对重复（支持 whitespace 归一化比较）
4. 如果是重复，剥离整个块；如果不是，插入逗号

> **实现状态**：`sanitize()` + `isDuplicate()` + `normalize()` 已在 `packages/opencode/src/session/llm.ts` 中完整实现，并通过 `packages/opencode/test/session/sanitize-repair.test.ts` 中的 27 个单元测试验证。可处理精确重复和空格差异的重复。

---

### 2. 输出 token 截断（Output Token Truncation） ⚠️ 部分修复

**问题描述**：当 tool call 的 JSON 参数超过 `maxOutputTokens` 限制（默认 32k tokens）时，JSON 被截断为不完整的字符串。当前的 `experimental_repairToolCall` 无法区分「截断」和「无效工具」，将所有 parse 失败统一路由到 `invalid` 工具。

**典型症状**：
- `finishReason: "length"` 被当作正常完成，session loop 退出
- agent 在不知道输出被截断的情况下反复重试
- sub-agent 场景中可能导致无限挂起

**相关 Issue**：
- [#18108](https://github.com/anomalyco/opencode/issues/18108) — Truncated tool calls are misclassified and unrecoverable (finishReason: length + repairToolCall + doom loop)
- [#13102](https://github.com/anomalyco/opencode/issues/13102) — Tool execution aborted when tool call is truncated
- [#17471](https://github.com/anomalyco/opencode/issues/17471) — Auto-continue when model hits output token limit

**建议修复方案**（来自 #18108 提案，按优先级排列）：
| 优先级 | 修复 | 描述 |
|--------|------|------|
| P0 | repairToolCall 截断检测 | 当 `failed.toolCall.toolName` 是已注册工具但 JSON parse 失败时，返回「输出被 token 限制截断」而非 `invalid` |
| P1 | finishReason "length" 自动续传 | 在 session loop 中对 `finishReason: "length"` 继续而非退出 |
| P2 | thinking budget 协调 | 从 maxOutputTokens 中减去 thinking budget |
| P3 | sub-agent 权限挂起修复 | doom_loop 权限检查增加超时 |
| P4 | 提升 OUTPUT_TOKEN_MAX | 从 32k 提升到 64k |

**本地已实现的修复** ⚠️：`jsonrepair` 可以修复部分截断 JSON（如补全缺失的 `}`、`"`），已在三步管道中生效。但以下场景仍未修复：
- 严重截断（如只有 `{` 或 JSON 只有前半段）无法生成有意义的内容
- 未实现 `finishReason: "length"` 的自动续传
- 未实现截断检测（区分「截断」和「无效工具」）

> **实现状态**：`jsonrepair` 已集成在 `llm.ts` 的 repair 管道中，对轻度截断（缺少 1-2 个 `}`）可自动补全。但 P0-P4 的上游修复方案暂未实现。

---

### 3. XML 标签污染（XML Tag Contamination）

**问题描述**：部分 provider（如 SiliconFlow + Qwen3-8B）在将模型内部的 XML 格式 tool call 转换为 OpenAI 兼容格式时，会在 `function.arguments` 中保留 `</tool_call>` 等 XML 标签。

**典型错误**：
```
{"questions": [...], "multiple": true}}
</tool_call>
```

**相关 Issue**：
- [#17750](https://github.com/anomalyco/opencode/issues/17750) — Tool call arguments may contain invalid JSON (SiliconFlow + Qwen3-8B)

**相关 PR**：
- [#17818](https://github.com/anomalyco/opencode/pull/17818) — fix(opencode): add JSON validation for tool call arguments

**建议修复方案**：
1. 在 provider SDK 层的 `doGenerate` 和 `flush` 中添加 JSON 校验
2. 在参数累积阶段或发出 `tool-call` 事件前，strip 掉 `<tool_call>`/`</tool_call>` 标签
3. 在 `sanitize()` 预处理器中添加 XML 标签剥离逻辑

---

### 4. LiteLLM 代理层解析异常

**问题描述**：通过 LiteLLM 代理连接 Ollama 等本地 provider 时，tool call 参数未被正确解析，直接以 JSON 字符串形式显示在 assistant 回复中。

**相关 Issue**：
- [#18187](https://github.com/anomalyco/opencode/issues/18187) — Response parsing problem if connect to ollama via litellm
- [#17036](https://github.com/anomalyco/opencode/issues/17036) — Qwen3-Coder-Next via LiteLLM response not parsed correctly

**根因分析**：LiteLLM 代理可能改变了 tool call 的响应格式，导致 opencode 的 provider SDK 无法正确识别为 tool call。

**建议修复方案**：
- 确保 LiteLLM 代理模式下 `tools` 参数正确传递（已有 `_noop` 兼容逻辑）
- 在 provider SDK 层增加对 LiteLLM 特有响应格式的处理

---

### 5. readJson() 缺少错误处理

**问题描述**：`packages/opencode/src/util/filesystem.ts` 中的 `readJson()` 直接调用 `JSON.parse()` 而无 try-catch，恶意或损坏的 JSON 文件会导致未处理的异常。

**相关 Issue**：
- [#18351](https://github.com/anomalyco/opencode/issues/18351) — readJson() lacks error handling for malformed JSON

**建议修复方案**：
```typescript
export async function readJson<T = any>(p: string): Promise<T> {
  try {
    return JSON.parse(await readFile(p, "utf-8"))
  } catch (e) {
    throw new Error(`Failed to parse JSON from ${p}`, { cause: e })
  }
}
```

---

## 本地实现的解决方案

### 修复管道：sanitize → jsonrepair → JSON.stringify(JSON.parse())

在 `experimental_repairToolCall` 中实现的三步修复管道：

```
原始 input
  ↓
sanitize(input)
  - 去除控制字符 (0x00-0x08, 0x0b, 0x0e-0x1f)
  - 检测 "value"{ 和 }{ 模式
  - isDuplicate: whitespace 归一化比较，重复块则剥离
  - 非重复块则插入逗号
  ↓
jsonrepair(sanitized)
  - 补全缺失的 }, ], "
  - 修复尾部逗号
  - 修复未引用的 key
  ↓
JSON.stringify(JSON.parse(repaired))
  - 规范化 JSON 格式
  - 去除重复 key（保留最后一个值）
```

### isDuplicate whitespace 归一化

针对 issue #17315 报告的 case（GLM-5 重复 payload 带有不同空格），`isDuplicate()` 现在使用 `normalize()` 对比：

```typescript
function normalize(s: string) {
  return s.replace(/\s+/g, "")
}

function isDuplicate(existing: string, block: string) {
  const norm = normalize(existing)
  const pairs = block.split(",").map((p) => p.trim())
  return pairs.every((p) => p && (existing.includes(p) || norm.includes(normalize(p))))
}
```

这确保了 `"command":"pwd"` 和 `"command": "pwd"`（有空格差异）能被正确识别为重复。

### invalid 工具日志记录

当所有修复尝试失败后，`repairToolCall` 会将工具路由到 sentinel `invalid` tool。之前 `ToolCallLog.finalize()` 会过滤掉 `invalid`，导致这些失败案例无法被记录。现在 `invalid` 被记录为独立的 `invalid` 分类，包含完整的原始 tool call 信息、repair 尝试记录和错误信息。

## 整体防御策略

```
┌────────────────────────────────────────────┐
│  Provider SDK Layer (上游修复)             │
│  - PR #17339: 检测流式重复 payload         │
│  - PR #17818: JSON 校验 + XML strip        │
│  - 问题在源头被阻止                        │
├────────────────────────────────────────────┤
│  experimental_repairToolCall (本地防御)    │
│  - sanitize: 控制字符、重复块、stray brace │
│  - jsonrepair: 结构性 JSON 修复            │
│  - JSON.parse+stringify: 规范化 + key 去重 │
│  - 问题在到达工具之前被修复                │
├────────────────────────────────────────────┤
│  ToolCallLog (可观测性)                    │
│  - 记录每次 repair 的完整过程              │
│  - 分类: ok/parse-only/fixed-ok/           │
│    fixed-only/fail/name-fixed/             │
│    aborted/invalid                         │
│  - 便于诊断和统计                          │
└────────────────────────────────────────────┘
```

## 参考链接

| Issue/PR | 标题 | 状态 |
|----------|------|------|
| [#17315](https://github.com/anomalyco/opencode/issues/17315) | Tool calls result in JSON parsing error - parameters duplicated | open |
| [#17339](https://github.com/anomalyco/opencode/pull/17339) | fix: handle repeated full streamed tool-call arguments | open |
| [#12425](https://github.com/anomalyco/opencode/issues/12425) | Error message: JSON Parse error: Expected '}' | open |
| [#13900](https://github.com/anomalyco/opencode/issues/13900) | GLM-5 via NVIDIA NIM malformed MCP tool JSON | open |
| [#18108](https://github.com/anomalyco/opencode/issues/18108) | Truncated tool calls misclassified and unrecoverable | open |
| [#17750](https://github.com/anomalyco/opencode/issues/17750) | Tool call arguments may contain invalid JSON | open |
| [#17818](https://github.com/anomalyco/opencode/pull/17818) | fix: add JSON validation for tool call arguments | open |
| [#18187](https://github.com/anomalyco/opencode/issues/18187) | Response parsing problem via litellm | open |
| [#18351](https://github.com/anomalyco/opencode/issues/18351) | readJson() lacks error handling | open |
