import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MAX_INGEST_PER_TURN } from "../src/core"
import { createZeroMem } from "../src/index"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function indexFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zero-mem-test-"))
  temps.push(dir)
  return path.join(dir, "zero-mem-index.json")
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

function session(
  id: string,
  projectID: string,
  directory: string,
  updated: number,
  title = id,
) {
  return { id, projectID, directory, title, version: "test", time: { created: 1, updated } }
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
  sessions?: any[]
  messages?: Record<string, any[] | Error | (() => Promise<any>)>
  familyError?: Error
  familyList?: () => Promise<any[]>
  projectID?: string
  projectWorktree?: string
  directory?: string
  timeoutMs?: number
  file?: string
}) {
  const calls = { familyList: 0, messages: [] as string[] }
  const messages = input.messages ?? {}
  const client = {
    session: {
      messages: async ({ path: requestPath }: any) => {
        calls.messages.push(requestPath.id)
        const value = messages[requestPath.id]
        if (typeof value === "function") return value()
        if (value instanceof Error) throw value
        return { data: value ?? [] }
      },
      list: async () => ({ data: input.sessions ?? [] }),
    },
  }

  const factory = createZeroMem({
    indexFile: input.file ?? (await indexFile()),
    timeoutMs: input.timeoutMs ?? 500,
    familyList: async () => {
      calls.familyList++
      if (input.familyError) throw input.familyError
      if (input.familyList) return input.familyList()
      return input.sessions ?? []
    },
  })
  const hooks = await factory({
    client,
    directory: input.directory ?? "/repo/main",
    worktree: input.directory ?? "/repo/main",
    project: {
      id: input.projectID ?? "project-A",
      worktree: input.projectWorktree ?? "/repo/main",
      time: { created: 1 },
    },
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
    const historical = session("history", "project-A", "/repo/main", 10)
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

  test("sibling worktrees with different project IDs recall both directions and exclude unrelated family", async () => {
    const file = await indexFile()
    const prime = session("prime-history", "project-A", "/repo/main", 30)
    const sub = session("sub-history", "project-B", "/repo/worktree-sub", 20)
    const unrelated = session("unrelated", "project-C", "/unrelated/repo", 40)
    const family = [prime, sub]
    const messages = {
      "prime-history": [
        message("p1", "prime-history", "assistant", [textPart("p1p", "prime-history", "p1", "primeNeedle() evidence")], 1),
      ],
      "sub-history": [
        message("s1", "sub-history", "assistant", [textPart("s1p", "sub-history", "s1", "subNeedle() evidence")], 1),
      ],
      unrelated: [
        message("u1", "unrelated", "assistant", [textPart("u1p", "unrelated", "u1", "unrelatedNeedle() secret")], 1),
      ],
    }

    const primePlugin = await plugin({
      file,
      sessions: family,
      messages,
      projectID: "project-A",
      projectWorktree: "/repo/main",
      directory: "/repo/main",
    })
    const fromPrime = currentOutput("prime-current", "Recall subNeedle() unrelatedNeedle()")
    await primePlugin.hooks["experimental.chat.messages.transform"]!({}, fromPrime.output as any)
    const primeText = injected(fromPrime.current)[0]?.text ?? ""
    expect(primeText).toContain("subNeedle()")
    expect(primeText).not.toContain("unrelatedNeedle()")
    expect(primePlugin.calls.messages).not.toContain("unrelated")

    const subPlugin = await plugin({
      file,
      sessions: family,
      messages,
      projectID: "project-B",
      projectWorktree: "/repo/main",
      directory: "/repo/worktree-sub",
    })
    const fromSub = currentOutput("sub-current", "Recall primeNeedle() unrelatedNeedle()")
    await subPlugin.hooks["experimental.chat.messages.transform"]!({}, fromSub.output as any)
    const subText = injected(fromSub.current)[0]?.text ?? ""
    expect(subText).toContain("primeNeedle()")
    expect(subText).not.toContain("unrelatedNeedle()")
    expect(subPlugin.calls.messages).not.toContain("unrelated")
  })

  test("successful authoritative listing reconciles deleted indexed sessions", async () => {
    const file = await indexFile()
    const historical = session("deleted-later", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [historical],
      messages: {
        "deleted-later": [
          message("d1", "deleted-later", "assistant", [textPart("d1p", "deleted-later", "d1", "deletedNeedle() evidence")], 1),
        ],
      },
    })
    const one = currentOutput("current-a", "Recall deletedNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, one.output as any)
    expect(injected(one.current)[0]?.text).toContain("deletedNeedle()")

    const second = await plugin({ file, sessions: [], messages: {} })
    const two = currentOutput("current-b", "Recall deletedNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, two.output as any)
    expect(injected(two.current)).toHaveLength(0)

    const third = await plugin({ file, sessions: [], messages: {} })
    const three = currentOutput("current-c", "Recall deletedNeedle()")
    await third.hooks["experimental.chat.messages.transform"]!({}, three.output as any)
    expect(injected(three.current)).toHaveLength(0)
  })

  test("session.list failure does not purge existing index", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "survivesListFailure() evidence")], 1),
        ],
      },
    })
    const one = currentOutput("current-a", "Recall survivesListFailure()")
    await first.hooks["experimental.chat.messages.transform"]!({}, one.output as any)

    const failed = await plugin({ file, familyError: new Error("offline") })
    const two = currentOutput("current-b", "Recall survivesListFailure()")
    await failed.hooks["experimental.chat.messages.transform"]!({}, two.output as any)
    expect(injected(two.current)).toHaveLength(0)

    const recovered = await plugin({
      file,
      sessions: [historical],
      messages: { history: new Error("unchanged session should not refetch") },
    })
    const three = currentOutput("current-c", "Recall survivesListFailure()")
    await recovered.hooks["experimental.chat.messages.transform"]!({}, three.output as any)
    expect(recovered.calls.messages).toEqual([])
    expect(injected(three.current)[0]?.text).toContain("survivesListFailure()")
  })

  test("session.deleted event removes indexed evidence immediately", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "eventDeleteNeedle() evidence")], 1),
        ],
      },
    })
    const one = currentOutput("current-a", "Recall eventDeleteNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, one.output as any)
    await first.hooks.event!({
      event: { type: "session.deleted", properties: { info: historical } } as any,
    })

    const second = await plugin({ file, sessions: [], messages: {} })
    const two = currentOutput("current-b", "Recall eventDeleteNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, two.output as any)
    expect(injected(two.current)).toHaveLength(0)
  })

  test("skips compaction and resumes after compaction completes", async () => {
    const historical = session("history", "project-A", "/repo/main", 10)
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
    const historical = session("history", "project-A", "/repo/main", 10)
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

  test("family listing failure and retrieval timeout fail open", async () => {
    const listFailure = await plugin({ familyError: new Error("offline") })
    const a = currentOutput("s", "Recall anything useful")
    await expect(listFailure.hooks["experimental.chat.messages.transform"]!({}, a.output as any)).resolves.toBeUndefined()
    expect(injected(a.current)).toHaveLength(0)

    const file = await indexFile()
    const hooks = await createZeroMem({
      indexFile: file,
      timeoutMs: 15,
      familyList: async () => new Promise<any[]>(() => undefined),
    })({
      client: { session: { messages: async () => ({ data: [] }) } },
      directory: "/repo",
      worktree: "/repo",
      project: { id: "project-A", worktree: "/repo", time: { created: 1 } },
    } as any)
    const b = currentOutput("s", "Recall timeoutNeedle()")
    const start = Date.now()
    await expect(hooks["experimental.chat.messages.transform"]!({}, b.output as any)).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(250)
    expect(injected(b.current)).toHaveLength(0)
  })

  test("one session fetch failure does not block evidence from another session", async () => {
    const bad = session("bad", "project-A", "/repo/a", 20)
    const good = session("good", "project-A", "/repo/b", 10)
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
    const currentSession = session("current", "project-A", "/repo/main", 30)
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

  test("indexes bounded tool/error evidence with provenance", async () => {
    const historical = session("tool-session", "project-A", "/repo/main", 10)
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
    const firstSession = session("history", "project-A", "/repo/main", 10)
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

    const updatedSession = session("history", "project-A", "/repo/main", 11)
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
    const historical = session("history", "project-A", "/repo/main", 10)
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

  test("cold start inspects one extra bounded batch when first batch has no hit", async () => {
    const sessions = Array.from({ length: MAX_INGEST_PER_TURN + 4 }, (_, index) =>
      session("cold-" + index, "project-A", "/repo/main", 100 - index, "neutral"),
    )
    const relevant = sessions[MAX_INGEST_PER_TURN + 1]
    const messages: Record<string, any[]> = Object.fromEntries(
      sessions.map((item) => [
        item.id,
        [
          message(
            "m-" + item.id,
            item.id,
            "assistant",
            [
              textPart(
                "p-" + item.id,
                item.id,
                "m-" + item.id,
                item.id === relevant.id ? "deepColdNeedle() old evidence" : "unrelated historical note",
              ),
            ],
            item.time.updated,
          ),
        ],
      ]),
    )

    const { hooks, calls } = await plugin({ sessions, messages })
    const { current, output } = currentOutput("current", "Recall deepColdNeedle()")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)

    expect(calls.messages.length).toBeLessThanOrEqual(MAX_INGEST_PER_TURN * 2)
    expect(calls.messages).toContain(relevant.id)
    expect(injected(current)[0]?.text).toContain("deepColdNeedle()")
  })
})
