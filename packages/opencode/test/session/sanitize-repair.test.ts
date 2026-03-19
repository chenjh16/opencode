import { describe, expect, test } from "bun:test"
import { jsonrepair } from "jsonrepair"
import { LLM } from "../../src/session/llm"

const { sanitize, isDuplicate, extractBlock, normalize } = LLM._test

function repair(input: string) {
  const san = sanitize(input)
  let repaired = jsonrepair(san.output)
  try {
    repaired = JSON.stringify(JSON.parse(repaired))
  } catch {}
  return { sanitized: san, repaired }
}

describe("normalize", () => {
  test("strips all whitespace", () => {
    expect(normalize('"command": "pwd"')).toBe('"command":"pwd"')
  })
  test("handles tabs and newlines", () => {
    expect(normalize('"a" :\t"b"\n')).toBe('"a":"b"')
  })
})

describe("extractBlock", () => {
  test("extracts balanced braces", () => {
    const s = '{"a":"b"}'
    const r = extractBlock(s, 0)
    expect(r).toEqual({ content: '"a":"b"', end: 9 })
  })
  test("handles nested braces", () => {
    const s = '{"a":{"b":"c"}}'
    const r = extractBlock(s, 0)
    expect(r).toEqual({ content: '"a":{"b":"c"}', end: 15 })
  })
  test("returns null for unbalanced", () => {
    expect(extractBlock('{"a":"b"', 0)).toBeNull()
  })
  test("skips braces inside strings", () => {
    const s = '{"a":"x{y}"}'
    const r = extractBlock(s, 0)
    expect(r).toEqual({ content: '"a":"x{y}"', end: 12 })
  })
})

describe("isDuplicate", () => {
  test("detects exact match", () => {
    const existing = '{"command":"pwd","description":"dir"'
    const block = '"command":"pwd","description":"dir"'
    expect(isDuplicate(existing, block)).toBe(true)
  })
  test("detects match with whitespace difference", () => {
    const existing = '{"command":"pwd","description":"Check current directory"'
    const block = '"command": "pwd", "description": "Check current directory"'
    expect(isDuplicate(existing, block)).toBe(true)
  })
  test("rejects non-duplicate", () => {
    const existing = '{"command":"pwd"'
    const block = '"command":"ls"'
    expect(isDuplicate(existing, block)).toBe(false)
  })
})

describe("sanitize", () => {
  test("passes through valid JSON", () => {
    const r = sanitize('{"a":"b"}')
    expect(r.output).toBe('{"a":"b"}')
    expect(r.actions).toEqual([])
  })

  test("strips control characters", () => {
    const r = sanitize('{"a":\x01"b"}')
    expect(r.output).toBe('{"a":"b"}')
    expect(r.actions).toContain("strip-control-char")
  })

  test('inserts comma for "value"{ pattern', () => {
    const r = sanitize('{"command":"echo"{"description":"test"}')
    expect(r.output).toBe('{"command":"echo", "description":"test"}')
    expect(r.actions).toContain("insert-comma")
  })

  test("removes duplicate block with same whitespace", () => {
    const r = sanitize('{"file":"path"{"file":"path"}')
    expect(r.output).toBe('{"file":"path"')
    expect(r.actions).toContain("remove-duplicate")
  })

  test("removes duplicate block with different whitespace (issue #17315)", () => {
    const input = '{"command":"pwd","description":"Check current directory"{"command": "pwd", "description": "Check current directory"}'
    const r = sanitize(input)
    expect(r.output).toBe('{"command":"pwd","description":"Check current directory"')
    expect(r.actions).toContain("remove-duplicate")
  })

  test("handles }{ pattern with duplicate", () => {
    const r = sanitize('{"a":"b"}{"a":"b"}')
    expect(r.output).toBe('{"a":"b"}')
    expect(r.actions).toContain("remove-duplicate")
  })

  test("inserts comma for }{ pattern with non-duplicate", () => {
    const r = sanitize('{"a":"b"}{"c":"d"}')
    expect(r.output).toBe('{"a":"b"}, "c":"d"}')
    expect(r.actions).toContain("insert-comma")
  })
})

describe("full repair pipeline", () => {
  test("missing closing brace", () => {
    const { repaired } = repair('{"command":"pwd"')
    expect(JSON.parse(repaired)).toEqual({ command: "pwd" })
  })

  test("stutter: exact duplicate block", () => {
    const { sanitized, repaired } = repair('{"file":"path"{"file":"path"}')
    expect(sanitized.actions).toContain("remove-duplicate")
    expect(JSON.parse(repaired)).toEqual({ file: "path" })
  })

  test("stutter: duplicate with whitespace difference (issue #17315)", () => {
    const input = '{"command":"pwd","description":"Check current directory"{"command": "pwd", "description": "Check current directory"}'
    const { sanitized, repaired } = repair(input)
    expect(sanitized.actions).toContain("remove-duplicate")
    expect(JSON.parse(repaired)).toEqual({
      command: "pwd",
      description: "Check current directory",
    })
  })

  test("missing comma between objects", () => {
    const { sanitized, repaired } = repair('{"a":"1"{"b":"2"}')
    expect(sanitized.actions).toContain("insert-comma")
    expect(JSON.parse(repaired)).toEqual({ a: "1", b: "2" })
  })

  test("truncated string", () => {
    const { repaired } = repair('{"command":"echo hello')
    expect(JSON.parse(repaired)).toEqual({ command: "echo hello" })
  })

  test("trailing comma", () => {
    const { repaired } = repair('{"a":"1","b":"2",}')
    expect(JSON.parse(repaired)).toEqual({ a: "1", b: "2" })
  })

  test("valid JSON passes through unchanged", () => {
    const input = '{"command":"ls","description":"list"}'
    const { sanitized, repaired } = repair(input)
    expect(sanitized.actions).toEqual([])
    expect(repaired).toBe(input)
  })

  test("nested JSON with missing brace", () => {
    const input = '{"command":"pwd","opts":{"verbose":true}'
    const { repaired } = repair(input)
    expect(JSON.parse(repaired)).toEqual({
      command: "pwd",
      opts: { verbose: true },
    })
  })

  test("control chars + missing brace", () => {
    const input = '{"command":\x02"pwd"'
    const { sanitized, repaired } = repair(input)
    expect(sanitized.actions).toContain("strip-control-char")
    expect(JSON.parse(repaired)).toEqual({ command: "pwd" })
  })

  test("GLM-style full payload repeat (issue #17315 exact case)", () => {
    const input =
      '{"command":"pwd","description":"Check current directory"{"command": "pwd", "description": "Check current directory"}'
    const { sanitized, repaired } = repair(input)
    expect(sanitized.actions).toContain("remove-duplicate")
    const parsed = JSON.parse(repaired)
    expect(parsed.command).toBe("pwd")
    expect(parsed.description).toBe("Check current directory")
  })

  test("duplicate }{ with whitespace difference", () => {
    const input = '{"command":"pwd","description":"dir"}{"command": "pwd","description": "dir"}'
    const { sanitized, repaired } = repair(input)
    expect(sanitized.actions).toContain("remove-duplicate")
    expect(JSON.parse(repaired)).toEqual({
      command: "pwd",
      description: "dir",
    })
  })
})
