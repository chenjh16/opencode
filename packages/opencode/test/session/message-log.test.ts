import { describe, expect, test } from "bun:test"
import { MessageLog } from "../../src/session/message-log"

describe("MessageLog", () => {
  test("enabled returns false by default (no env set at module load)", () => {
    expect(MessageLog.enabled()).toBe(false)
  })
})
