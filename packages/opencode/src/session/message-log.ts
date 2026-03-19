import { Flag } from "@/flag/flag"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import { Log } from "@/util/log"
import path from "path"

const log = Log.create({ service: "message-log" })
let counter = 0

function dir() {
  try {
    return path.join(Instance.worktree, ".opencode", "logs", "messages")
  } catch {
    return path.join(Instance.directory, ".opencode", "logs", "messages")
  }
}

function ts() {
  return new Date().toISOString().slice(0, 23).replace(/[:.]/g, "-")
}

export namespace MessageLog {
  export function enabled() {
    return Flag.OPENCODE_LOG_MESSAGES
  }

  export async function request(url: string, body: string) {
    if (!enabled()) return
    counter++
    const seq = String(counter).padStart(3, "0")
    const file = path.join(dir(), `${ts()}_${seq}_req.json`)
    try {
      const parsed = JSON.parse(body)
      await Filesystem.write(
        file,
        JSON.stringify({ url, timestamp: new Date().toISOString(), body: parsed }, null, 2),
      )
      log.info("logged request", { seq, url })
    } catch {
      await Filesystem.write(file, JSON.stringify({ url, timestamp: new Date().toISOString(), body }, null, 2))
    }
  }

  export async function response(url: string, status: number, chunks: string[]) {
    if (!enabled()) return
    const seq = String(counter).padStart(3, "0")
    const file = path.join(dir(), `${ts()}_${seq}_resp.json`)
    try {
      await Filesystem.write(
        file,
        JSON.stringify({ url, timestamp: new Date().toISOString(), status, chunks }, null, 2),
      )
      log.info("logged response", { seq, url, status, chunks: chunks.length })
    } catch (e) {
      log.error("response write failed", { error: e })
    }
  }
}
