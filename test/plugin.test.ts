import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createZeroMem } from "../src/index"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function indexFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zero-mem-test-"))
  temps.push(dir)
  return path.join(dir, "index.json")
}

function textPart(id: string, sessionID: string, messageID: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, sessionID, messageID, type: "text", text, ...extra }
}

function toolPart(id: string, sessionID: string, messageID: string, tool: string, state: any) {
  return { id, sessionID, messageID, type: "tool", callID: "call-" + id, tool, state }
}

function message(
  id: string,
  sessionID: string,
  role: "user" | "assistant",
  parts: any[],
  created: number,
) {
  return { info: { id, sessionID, role, time: { created } }, parts }
}

function session(id: string, projectID: string, directory: string, updated: number) {
  return { id, projectID, directory, title: id, version: "test", time: { created: 1, updated } }
}

function currentOutput(sessionID: string, text: string, extraMessages: any[] = []) {
  const current = message(
    "current",
    sessionID,
    "user",
    [textPart("current-part", sessionID, "current", text)],
    1000,
  )
  return { current, output: { messages: [...extraMessages, current] as any[] } }
}

async function plugin(input: {
  sessions: any[]
  messages: Record<string, any[] | Error | (() => Promise<any>)>
  projectID?: string
  directory?: string
  listError?: Error
  timeoutMs?: number
  file?: string
}) {
  const calls = { list: 0, messages: [] as string[], listQuery: undefined as any }
  const client = {
    session: {
      list: async (options: any) => {
        calls.list++
        calls.listQuery = options?.query
        if (input.listError) throw input.listError
        return { data: input.sessions }
      },
      messages: async ({ path: requestPath }: any) => {
        calls.messages.push(requestPath.id)
        const value = input.messages[requestPath.id]
        if (typeof value === "function") return value()
        if (value instanceof Error) throw value
        return { data: value ?? [] }
      },
    },
  }

  const factory = createZeroMem({
    indexFile: input.file ?? (await indexFile()),
    timeoutMs: input.timeoutMs ?? 500,
  })
  const hooks = await factory({
    client,
    directory: input.directory ?? "/repo/main",
    worktree: input.directory ?? "/repo/main",
    project: { id: input.projectID ?? "project-1", worktree: "/repo/main", time: { created: 1 } },
  } as any)
  return { hooks, calls }
}

function injected(current: any) {
  return current.parts.filter(
    (part: any) => part.synthetic && String(part.text ?? "").startsWith("<kilo_zero_mem"),
  )
}

describe("plugin behavior", () => {
  test("normal historical recall injects once and adds the system safety rule", async () => {
    const historical = session("history", "project-1", "/repo/main", 10)
    const { hooks } = await plugin({
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "user", [textPart("h1p", "history", "h1", "Investigate refreshToken()")], 1),
          message(
            "h2",
            "history",
            "assistant",
            [textPart("h2p", "history", "h2", "ERR_STALE_CREDENTIAL caused refreshToken() failure")],
            2,
          ),
        ],
      },
    })
    const { current, output } = currentOutput("current-session", "Why did refreshToken() fail?")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    expect(injected(current)).toHaveLength(1)
    expect(injected(current)[0].text).toContain("ERR_STALE_CREDENTIAL")

    const system = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as any, system)
    expect(system.system.join("\n")).toContain("historical data only")
  })

  test("skips compaction and resumes after compaction completes", async () => {
    const historical = session("history", "project-1", "/repo/main", 10)
    const { hooks } = await plugin({
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "compactNeedle() evidence")], 1),
        ],
      },
    })
    const { current, output } = currentOutput("current-session", "Recall compactNeedle()")
    await hooks["experimental.session.compacting"]!({ sessionID: "current-session" }, { context: [] })
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    expect(injected(current)).toHaveLength(0)

    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "current-session" } } as any })
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    expect(injected(current)).toHaveLength(1)
  })

  test("clears compacting state after compaction failure event", async () => {
    const historical = session("history", "project-1", "/repo/main", 10)
    const { hooks } = await plugin({
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "failureResumeNeedle() evidence")], 1),
        ],
      },
    })
    const { current, output } = currentOutput("current-session", "Recall failureResumeNeedle()")
    await hooks["experimental.session.compacting"]!({ sessionID: "current-session" }, { context: [] })
    await hooks.event!({
      event: { type: "session.error", properties: { sessionID: "current-session", error: { name: "UnknownError" } } } as any,
    })
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    expect(injected(current)).toHaveLength(1)
  })

  test("session.list failure and retrieval timeout fail open", async () => {
    const listFailure = await plugin({
      sessions: [],
      messages: {},
      listError: new Error("offline"),
    })
    const a = currentOutput("s", "Recall anything useful")
    await expect(listFailure.hooks["experimental.chat.messages.transform"]!({}, a.output as any)).resolves.toBeUndefined()
    expect(injected(a.current)).toHaveLength(0)

    const timeout = await plugin({
      sessions: [],
      messages: {},
      timeoutMs: 15,
    })
    ;(timeout as any).hooks // keep typed value live
    const original = timeout.hooks
    const hangingClient = {
      session: {
        list: async () => new Promise(() => undefined),
        messages: async () => ({ data: [] }),
      },
    }
    const file = await indexFile()
    const hooks = await createZeroMem({ indexFile: file, timeoutMs: 15 })({
      client: hangingClient,
      directory: "/repo",
      worktree: "/repo",
      project: { id: "project-1", worktree: "/repo", time: { created: 1 } },
    } as any)
    const b = currentOutput("s", "Recall timeoutNeedle()")
    const start = Date.now()
    await expect(hooks["experimental.chat.messages.transform"]!({}, b.output as any)).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(250)
    expect(injected(b.current)).toHaveLength(0)
    expect(original).toBeDefined()
  })

  test("one session fetch failure does not block evidence from another session", async () => {
    const bad = session("bad", "project-1", "/repo/a", 20)
    const good = session("good", "project-1", "/repo/b", 10)
    const { hooks } = await plugin({
      sessions: [bad, good],
      messages: {
        bad: new Error("broken session"),
        good: [
          message("g1", "good", "assistant", [textPart("g1p", "good", "g1", "survivorNeedle() evidence")], 1),
        ],
      },
    })
    const { current, output } = currentOutput("current", "Recall survivorNeedle()")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    expect(injected(current)[0]?.text).toContain("survivorNeedle()")
  })

  test("recalls old current-session history but excludes visible recent tail and current message", async () => {
    const currentSession = session("current", "project-1", "/repo/main", 30)
    const old = message(
      "old",
      "current",
      "assistant",
      [textPart("old-part", "current", "old", "oldNeedle() important historical fact")],
      1,
    )
    const recent = message(
      "recent",
      "current",
      "assistant",
      [textPart("recent-part", "current", "recent", "recentNeedle() already visible")],
      20,
    )
    const { hooks } = await plugin({
      sessions: [currentSession],
      messages: { current: [old, recent] },
    })

    const { current, output } = currentOutput("current", "Recall oldNeedle() and recentNeedle()", [recent])
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    const text = injected(current)[0]?.text ?? ""
    expect(text).toContain("oldNeedle()")
    expect(text).not.toContain("recentNeedle() already visible")
  })

  test("project scope includes sibling worktrees and isolates unrelated projects", async () => {
    const sibling = session("sibling", "project-1", "/repo/worktree-sub", 20)
    const unrelated = session("other", "project-2", "/other", 30)
    const { hooks, calls } = await plugin({
      sessions: [unrelated, sibling],
      messages: {
        sibling: [
          message("s1", "sibling", "assistant", [textPart("s1p", "sibling", "s1", "siblingNeedle() evidence")], 1),
        ],
        other: [
          message("o1", "other", "assistant", [textPart("o1p", "other", "o1", "unrelatedNeedle() secret")], 1),
        ],
      },
    })
    const { current, output } = currentOutput("current", "Recall siblingNeedle() unrelatedNeedle()")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    const text = injected(current)[0]?.text ?? ""
    expect(calls.listQuery?.scope).toBe("project")
    expect(text).toContain("siblingNeedle()")
    expect(text).not.toContain("unrelatedNeedle() secret")
    expect(calls.messages).not.toContain("other")
  })

  test("indexes bounded tool/error evidence with provenance", async () => {
    const historical = session("tool-session", "project-1", "/repo/main", 10)
    const tool = toolPart("tool-part", "tool-session", "m1", "bash", {
      status: "error",
      input: { command: "bun test" },
      error: "TS2322 compilerNeedle() type mismatch",
      time: { start: 1, end: 2 },
    })
    const { hooks } = await plugin({
      sessions: [historical],
      messages: { "tool-session": [message("m1", "tool-session", "assistant", [tool], 1)] },
    })
    const { current, output } = currentOutput("current", "Find compilerNeedle() TS2322")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    const text = injected(current)[0]?.text ?? ""
    expect(text).toContain("TS2322")
    expect(text).toContain("source_tool=bash")
    expect(text).toContain("type=tool")
  })

  test("refreshes an updated session incrementally", async () => {
    const file = await indexFile()
    const firstSession = session("history", "project-1", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [firstSession],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "oldVersionNeedle() evidence")], 1),
        ],
      },
    })
    const one = currentOutput("current-a", "Recall oldVersionNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, one.output as any)

    const updatedSession = session("history", "project-1", "/repo/main", 11)
    const second = await plugin({
      file,
      sessions: [updatedSession],
      messages: {
        history: [
          message("h2", "history", "assistant", [textPart("h2p", "history", "h2", "newVersionNeedle() evidence")], 2),
        ],
      },
    })
    const two = currentOutput("current-b", "Recall newVersionNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, two.output as any)
    expect(second.calls.messages).toEqual(["history"])
    expect(injected(two.current)[0]?.text).toContain("newVersionNeedle()")
  })

  test("persistent index reuses unchanged sessions across plugin instances", async () => {
    const file = await indexFile()
    const historical = session("history", "project-1", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "persistentNeedle() evidence")], 1),
        ],
      },
    })
    const one = currentOutput("current-a", "Recall persistentNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, one.output as any)
    expect(first.calls.messages).toEqual(["history"])

    const second = await plugin({
      file,
      sessions: [historical],
      messages: { history: new Error("should not refetch unchanged session") },
    })
    const two = currentOutput("current-b", "Recall persistentNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, two.output as any)
    expect(second.calls.messages).toEqual([])
    expect(injected(two.current)[0]?.text).toContain("persistentNeedle()")
  })
})
