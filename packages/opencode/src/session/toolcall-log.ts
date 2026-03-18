import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import path from "path"

type Category = "ok" | "parse-only" | "fixed-ok" | "fixed-only" | "fail" | "name-fixed"

interface RawToolCall {
  type: string
  toolCallId: string
  toolName: string
  input: string
}

interface Entry {
  timestamp: string
  category: Category
  sessionID: string
  toolCallId: string
  toolName: string
  resolvedTool?: string
  raw: RawToolCall
  original: {
    input: string
    parseError?: string
  }
  repaired?: {
    input: string
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
  method?: string
  repaired?: string
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

  export function repair(toolCall: RawToolCall, error: string) {
    if (!enabled()) return
    pending.set(toolCall.toolCallId, {
      raw: { ...toolCall },
      input: toolCall.input,
      error,
    })
  }

  export function repaired(callId: string, result: string, method: string) {
    if (!enabled()) return
    const p = pending.get(callId)
    if (p) {
      p.repaired = result
      p.method = method
    }
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
    if (p) {
      if (p.method === "claude-tools-name" || p.method === "lowercase") {
        category = opts.status === "completed" ? "name-fixed" : "fixed-only"
      } else if (p.repaired) {
        category = opts.status === "completed" ? "fixed-ok" : "fixed-only"
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

    await emit({
      timestamp: new Date().toISOString(),
      category,
      sessionID: opts.sessionID,
      toolCallId: opts.toolCallId,
      toolName: opts.toolName,
      resolvedTool: opts.resolvedTool,
      raw,
      original: {
        input: p ? p.input : opts.input,
        parseError: p?.error,
      },
      repaired: p?.repaired ? { input: p.repaired, method: p.method! } : undefined,
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
    pending.delete(opts.toolCall.toolCallId)
    await emit({
      timestamp: new Date().toISOString(),
      category: "fail",
      sessionID: opts.sessionID,
      toolCallId: opts.toolCall.toolCallId,
      toolName: opts.toolCall.toolName,
      raw: { ...opts.toolCall },
      original: { input: opts.toolCall.input, parseError: opts.error },
    })
  }
}
