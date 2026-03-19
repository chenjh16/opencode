import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import path from "path"

type Category = "ok" | "parse-only" | "fixed-ok" | "fixed-only" | "fail" | "name-fixed" | "aborted" | "invalid"

interface RawToolCall {
  type: string
  toolCallId: string
  toolName: string
  input: string
}

interface ToolSchema {
  name: string
  description?: string
  parameters?: unknown
}

interface Entry {
  timestamp: string
  category: Category
  sessionID: string
  toolCallId: string
  toolName: string
  resolvedTool?: string
  toolSchema?: ToolSchema
  raw: RawToolCall
  original: {
    input: unknown
    inputRaw: string
    parseError?: string
    jsonRepairError?: string
  }
  sanitized?: {
    input: unknown
    inputRaw: string
    actions: string[]
  }
  repaired?: {
    name?: string
    input?: unknown
    inputRaw?: string
    method: string
  }
  execution?: {
    status: "completed" | "error"
    duration?: number
    error?: string
  }
}

interface Pending {
  raw: RawToolCall
  input: string
  error: string
  toolSchema?: ToolSchema
  method?: string
  renamed?: string
  repairedInput?: string
  jsonRepairError?: string
  sanitizedInput?: string
  sanitizeActions?: string[]
}

const log = Log.create({ service: "toolcall-log" })
const pending = new Map<string, Pending>()

function dir() {
  try {
    return path.join(Instance.worktree, ".opencode", "logs", "toolcall")
  } catch {
    return path.join(Instance.directory, ".opencode", "logs", "toolcall")
  }
}

function filename(tool: string, category: Category) {
  const now = new Date()
  const ts = now.toISOString().slice(0, 23).replace(/[:.]/g, "-")
  const safe = tool.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `${ts}_${safe}_${category}.json`
}

function parse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

async function emit(entry: Entry) {
  try {
    const file = path.join(dir(), filename(entry.toolName, entry.category))
    await Filesystem.write(file, JSON.stringify(entry, null, 2))
    log.info("logged", { category: entry.category, tool: entry.toolName })
  } catch (e) {
    log.error("write failed", { error: e })
  }
}

export namespace ToolCallLog {
  export function enabled() {
    return Flag.OPENCODE_LOG_TOOLCALL
  }

  export function schema(name: string, tools: Record<string, any>): ToolSchema | undefined {
    const t = tools[name]
    if (!t) return undefined
    return {
      name,
      description: t.description,
      parameters: t.inputSchema?.jsonSchema,
    }
  }

  export function repair(toolCall: RawToolCall, error: string, toolSchema?: ToolSchema) {
    if (!enabled()) return
    pending.set(toolCall.toolCallId, {
      raw: { ...toolCall },
      input: toolCall.input,
      error,
      toolSchema,
    })
  }

  export function sanitized(callId: string, output: string, actions: string[]) {
    if (!enabled()) return
    const p = pending.get(callId)
    if (p) {
      p.sanitizedInput = output
      p.sanitizeActions = actions
    }
  }

  export function jsonRepairFailed(callId: string, error: string) {
    if (!enabled()) return
    const p = pending.get(callId)
    if (p) p.jsonRepairError = error
  }

  export function repaired(callId: string, opts: { name?: string; input?: string; method: string }) {
    if (!enabled()) return
    const p = pending.get(callId)
    if (p) {
      p.renamed = opts.name
      p.repairedInput = opts.input
      p.method = opts.method
    }
  }

  export function updateSchema(callId: string, schema: ToolSchema) {
    if (!enabled()) return
    const p = pending.get(callId)
    if (p) p.toolSchema = schema
  }

  export async function finalize(opts: {
    sessionID: string
    toolCallId: string
    toolName: string
    resolvedTool?: string
    input: string
    status: "completed" | "error"
    duration?: number
    error?: string
  }) {
    if (!enabled()) return
    const p = pending.get(opts.toolCallId)
    pending.delete(opts.toolCallId)

    let category: Category
    if (opts.toolName === "invalid") {
      category = "invalid"
    } else if (opts.error === "Tool execution aborted") {
      category = "aborted"
    } else if (p) {
      if (p.repairedInput || p.renamed) {
        category = opts.status === "completed" ? (p.repairedInput ? "fixed-ok" : "name-fixed") : "fixed-only"
      } else {
        category = "fail"
      }
    } else {
      category = opts.status === "completed" ? "ok" : "parse-only"
    }

    const raw = p?.raw ?? {
      type: "tool-call",
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      input: opts.input,
    }

    const orig = p ? p.input : opts.input
    const hasSanitize = p?.sanitizeActions && p.sanitizeActions.length > 0
    const hasRepair = p && (p.renamed || p.repairedInput)
    await emit({
      timestamp: new Date().toISOString(),
      category,
      sessionID: opts.sessionID,
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      resolvedTool: opts.resolvedTool,
      toolSchema: p?.toolSchema,
      raw,
      original: {
        input: parse(orig),
        inputRaw: orig,
        parseError: p?.error,
        jsonRepairError: p?.jsonRepairError,
      },
      sanitized: hasSanitize
        ? {
            input: parse(p!.sanitizedInput!),
            inputRaw: p!.sanitizedInput!,
            actions: p!.sanitizeActions!,
          }
        : undefined,
      repaired: hasRepair
        ? {
            name: p!.renamed,
            input: p!.repairedInput ? parse(p!.repairedInput) : undefined,
            inputRaw: p!.repairedInput,
            method: p!.method!,
          }
        : undefined,
      execution: {
        status: opts.status,
        duration: opts.duration,
        error: opts.error,
      },
    })
  }

  export async function fail(opts: {
    sessionID: string
    toolCall: RawToolCall
    error: string
  }) {
    if (!enabled()) return
    const p = pending.get(opts.toolCall.toolCallId)
    pending.delete(opts.toolCall.toolCallId)
    const hasSanitize = p?.sanitizeActions && p.sanitizeActions.length > 0
    await emit({
      timestamp: new Date().toISOString(),
      category: "fail",
      sessionID: opts.sessionID,
      toolCallId: opts.toolCall.toolCallId,
      toolName: opts.toolCall.toolName,
      toolSchema: p?.toolSchema,
      raw: { ...opts.toolCall },
      original: { input: parse(opts.toolCall.input), inputRaw: opts.toolCall.input, parseError: opts.error, jsonRepairError: p?.jsonRepairError },
      sanitized: hasSanitize
        ? {
            input: parse(p!.sanitizedInput!),
            inputRaw: p!.sanitizedInput!,
            actions: p!.sanitizeActions!,
          }
        : undefined,
    })
  }
}
