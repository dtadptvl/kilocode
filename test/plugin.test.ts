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
  return path.join(dir, "index.json")
}

function textPart(id: string, sessionID: string, messageID: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, sessionID, messageID, type: "text", text, ...extra }
}

function toolPart(id: string, sessionID: string, messageID: string, tool: string, state: any) {
  return { id, sessionID, messageID, type: "tool", callID: "call-" + id, tool, state }
}

function message(id: string, sessionID: string, role: "user" | "assistant", parts: any[], created: number) {
  return { info: { id, sessionID, role, time: { created } }, parts }
}

function session(id: string, projectID: string, directory: string, updated: number, title = id) {
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
  sessions: any[]
  messages: Record<string, any[] | Error | (() => Promise<any>)>
  projectID?: string
  directory?: string
  listError?: Error
  timeoutMs?: number
  file?: string
}) {
  const calls = { list: 0, messages: [] as string[], listParams: undefined as any }
  const client = {
    experimental: {
      session: {
        list: async (params: any) => {
          calls.list++
          calls.listParams = params
          if (input.listError) throw input.listError
          return { data: input.sessions }
        },
      },
    },
    session: {
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
    timeoutMs: input.timeoutMs ?? 800,
  })
  const hooks = await factory({
    client,
    directory: input.directory ?? "/repo/main",
    worktree: input.directory ?? "/repo/main",
    project: { id: input.projectID ?? "project-A", worktree: "/repo/main", time: { created: 1 } },
    serverUrl: new URL("http://localhost"),
  } as any)
  return { hooks, calls }
}

function injected(current: any) {
  return current.parts.filter(
    (part: any) => part.synthetic && String(part.text ?? "").startsWith("<kilo_zero_mem"),
  )
}

describe("plugin behavior", () => {
  test("normal historical recall injects once and uses Kilo worktree-family listing", async () => {
    const historical = session("history", "project-A", "/repo/main", 10)
    const { hooks, calls } = await plugin({
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
    expect(calls.listParams).toMatchObject({ projectID: "project-A", worktrees: true, archived: true })

    const system = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as any, system)
    expect(system.system.join("\n")).toContain("historical data only")
  })

  test("different project IDs in the same Kilo worktree family recall bidirectionally", async () => {
    const prime = session("prime", "project-A", "/repo/main", 30)
    const sub = session("sub", "project-B", "/repo/worktree-sub", 20)

    const fromPrime = await plugin({
      projectID: "project-A",
      sessions: [prime, sub],
      messages: {
        prime: [message("p1", "prime", "assistant", [textPart("pp", "prime", "p1", "primeNeedle() evidence")], 1)],
        sub: [message("s1", "sub", "assistant", [textPart("sp", "sub", "s1", "subNeedle() evidence")], 1)],
      },
    })
    const primeTurn = currentOutput("prime-current", "Recall subNeedle()")
    await fromPrime.hooks["experimental.chat.messages.transform"]!({}, primeTurn.output as any)
    expect(injected(primeTurn.current)[0]?.text).toContain("subNeedle()")
    expect(injected(primeTurn.current)[0]?.text).toContain("directory=/repo/worktree-sub")

    const fromSub = await plugin({
      projectID: "project-B",
      directory: "/repo/worktree-sub",
      sessions: [prime, sub],
      messages: {
        prime: [message("p1", "prime", "assistant", [textPart("pp", "prime", "p1", "primeNeedle() evidence")], 1)],
        sub: [message("s1", "sub", "assistant", [textPart("sp", "sub", "s1", "subNeedle() evidence")], 1)],
      },
    })
    const subTurn = currentOutput("sub-current", "Recall primeNeedle()")
    await fromSub.hooks["experimental.chat.messages.transform"]!({}, subTurn.output as any)
    expect(injected(subTurn.current)[0]?.text).toContain("primeNeedle()")
    expect(injected(subTurn.current)[0]?.text).toContain("directory=/repo/main")
  })

  test("unrelated project is outside the authoritative Kilo family list and never fetched", async () => {
    const family = session("family", "project-B", "/repo/worktree-sub", 20)
    const { hooks, calls } = await plugin({
      projectID: "project-A",
      sessions: [family],
      messages: {
        family: [
          message("f1", "family", "assistant", [textPart("fp", "family", "f1", "familyNeedle() evidence")], 1),
        ],
        unrelated: [
          message("u1", "unrelated", "assistant", [textPart("up", "unrelated", "u1", "unrelatedNeedle() secret")], 1),
        ],
      },
    })
    const { current, output } = currentOutput("current", "Recall familyNeedle() unrelatedNeedle()")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    const text = injected(current)[0]?.text ?? ""
    expect(text).toContain("familyNeedle()")
    expect(text).not.toContain("unrelatedNeedle()")
    expect(calls.messages).not.toContain("unrelated")
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
    const listFailure = await plugin({
      sessions: [],
      messages: {},
      listError: new Error("offline"),
    })
    const a = currentOutput("s", "Recall anything useful")
    await expect(listFailure.hooks["experimental.chat.messages.transform"]!({}, a.output as any)).resolves.toBeUndefined()
    expect(injected(a.current)).toHaveLength(0)

    const hangingClient = {
      experimental: { session: { list: async () => new Promise(() => undefined) } },
      session: { messages: async () => ({ data: [] }) },
    }
    const file = await indexFile()
    const hooks = await createZeroMem({ indexFile: file, timeoutMs: 15 })({
      client: hangingClient,
      directory: "/repo",
      worktree: "/repo",
      project: { id: "project-A", worktree: "/repo", time: { created: 1 } },
      serverUrl: new URL("http://localhost"),
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

  test("successful authoritative listing reconciles deleted session out of recall", async () => {
    const file = await indexFile()
    const x = session("x", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [x],
      messages: {
        x: [message("x1", "x", "assistant", [textPart("xp", "x", "x1", "deletedNeedle() evidence")], 1)],
      },
    })
    const before = currentOutput("current-a", "Recall deletedNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    expect(injected(before.current)[0]?.text).toContain("deletedNeedle()")

    const second = await plugin({ file, sessions: [], messages: {} })
    const after = currentOutput("current-b", "Recall deletedNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, after.output as any)
    expect(injected(after.current)).toHaveLength(0)
  })

  test("failed family listing does not purge existing index", async () => {
    const file = await indexFile()
    const x = session("x", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [x],
      messages: {
        x: [message("x1", "x", "assistant", [textPart("xp", "x", "x1", "survivesListFailure() evidence")], 1)],
      },
    })
    const initial = currentOutput("current-a", "Recall survivesListFailure()")
    await first.hooks["experimental.chat.messages.transform"]!({}, initial.output as any)

    const failed = await plugin({ file, sessions: [], messages: {}, listError: new Error("transient") })
    const failureTurn = currentOutput("current-b", "Recall survivesListFailure()")
    await failed.hooks["experimental.chat.messages.transform"]!({}, failureTurn.output as any)
    expect(injected(failureTurn.current)).toHaveLength(0)

    const recovered = await plugin({
      file,
      sessions: [x],
      messages: { x: new Error("unchanged session must not be refetched") },
    })
    const recoveredTurn = currentOutput("current-c", "Recall survivesListFailure()")
    await recovered.hooks["experimental.chat.messages.transform"]!({}, recoveredTurn.output as any)
    expect(recovered.calls.messages).toEqual([])
    expect(injected(recoveredTurn.current)[0]?.text).toContain("survivesListFailure()")
  })

  test("session.deleted event removes indexed evidence immediately", async () => {
    const file = await indexFile()
    const x = session("x", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [x],
      messages: {
        x: [message("x1", "x", "assistant", [textPart("xp", "x", "x1", "eventDeleteNeedle() evidence")], 1)],
      },
    })
    const before = currentOutput("current-a", "Recall eventDeleteNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    await first.hooks.event!({ event: { type: "session.deleted", properties: { info: x } } as any })

    const second = await plugin({ file, sessions: [], messages: {} })
    const after = currentOutput("current-b", "Recall eventDeleteNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, after.output as any)
    expect(injected(after.current)).toHaveLength(0)
  })

  test("cold start opportunistically reaches relevant evidence outside first ingest batch", async () => {
    const sessions = Array.from({ length: MAX_INGEST_PER_TURN + 4 }, (_, index) =>
      session("s-" + index, "project-A", "/repo/main", 100 - index, "generic session " + index),
    )
    const target = sessions[MAX_INGEST_PER_TURN + 1]
    const messages: Record<string, any[]> = {}
    for (const item of sessions) {
      messages[item.id] = [
        message(
          "m-" + item.id,
          item.id,
          "assistant",
          [textPart("p-" + item.id, item.id, "m-" + item.id, item.id === target.id ? "coldStartNeedle() evidence" : "unrelated evidence")],
          1,
        ),
      ]
    }

    const { hooks, calls } = await plugin({ sessions, messages })
    const { current, output } = currentOutput("current", "Recall coldStartNeedle()")
    await hooks["experimental.chat.messages.transform"]!({}, output as any)
    expect(calls.messages.length).toBeLessThanOrEqual(MAX_INGEST_PER_TURN * 2)
    expect(calls.messages).toContain(target.id)
    expect(injected(current)[0]?.text).toContain("coldStartNeedle()")
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

  test("does not recall stale evidence when authoritative metadata changed but refresh fetch fails", async () => {
    const file = await indexFile()
    const oldSession = session("history", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [oldSession],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("h1p", "history", "h1", "staleNeedle() old evidence")], 1),
        ],
      },
    })
    const one = currentOutput("current-a", "Recall staleNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, one.output as any)
    expect(injected(one.current)[0]?.text).toContain("staleNeedle()")

    const changedSession = session("history", "project-A", "/repo/main", 11)
    const second = await plugin({
      file,
      sessions: [changedSession],
      messages: { history: new Error("refresh unavailable") },
    })
    const two = currentOutput("current-b", "Recall staleNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, two.output as any)
    expect(second.calls.messages).toContain("history")
    expect(injected(two.current)).toHaveLength(0)
  })

  test("message.part.removed invalidates indexed part and refetches raw transcript", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    let source = [
      message("h1", "history", "assistant", [textPart("part-old", "history", "h1", "deletedPartNeedle() evidence")], 1),
    ]
    const instance = await plugin({
      file,
      sessions: [historical],
      messages: { history: async () => ({ data: source }) },
    })

    const before = currentOutput("current-a", "Recall deletedPartNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    expect(injected(before.current)[0]?.text).toContain("deletedPartNeedle()")

    source = [message("h1", "history", "assistant", [], 1)]
    await instance.hooks.event!({
      event: {
        type: "message.part.removed",
        properties: { sessionID: "history", messageID: "h1", partID: "part-old" },
      } as any,
    })

    const after = currentOutput("current-b", "Recall deletedPartNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, after.output as any)
    expect(injected(after.current)).toHaveLength(0)
  })

  test("message.removed invalidates indexed message and refetches raw transcript", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    let source = [
      message("h1", "history", "assistant", [textPart("part-old", "history", "h1", "deletedMessageNeedle() evidence")], 1),
    ]
    const instance = await plugin({
      file,
      sessions: [historical],
      messages: { history: async () => ({ data: source }) },
    })

    const before = currentOutput("current-a", "Recall deletedMessageNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    expect(injected(before.current)[0]?.text).toContain("deletedMessageNeedle()")

    source = []
    await instance.hooks.event!({
      event: { type: "message.removed", properties: { sessionID: "history", messageID: "h1" } } as any,
    })

    const after = currentOutput("current-b", "Recall deletedMessageNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, after.output as any)
    expect(injected(after.current)).toHaveLength(0)
  })

  test("message.part.updated replaces stale content without session metadata bump", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    let source = [
      message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "oldPartNeedle() evidence")], 1),
    ]
    const instance = await plugin({
      file,
      sessions: [historical],
      messages: { history: async () => ({ data: source }) },
    })

    const before = currentOutput("current-a", "Recall oldPartNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    expect(injected(before.current)[0]?.text).toContain("oldPartNeedle()")

    source = [
      message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "newPartNeedle() evidence")], 1),
    ]
    await instance.hooks.event!({
      event: {
        type: "message.part.updated",
        properties: { part: textPart("part-1", "history", "h1", "newPartNeedle() evidence") },
      } as any,
    })

    const oldQuery = currentOutput("current-b", "Recall oldPartNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, oldQuery.output as any)
    expect(injected(oldQuery.current)).toHaveLength(0)

    const newQuery = currentOutput("current-c", "Recall newPartNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, newQuery.output as any)
    expect(injected(newQuery.current)[0]?.text).toContain("newPartNeedle()")
  })

  test("message.updated replaces stale message content without session metadata bump", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    let source = [
      message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "oldMessageNeedle() evidence")], 1),
    ]
    const instance = await plugin({
      file,
      sessions: [historical],
      messages: { history: async () => ({ data: source }) },
    })

    const before = currentOutput("current-a", "Recall oldMessageNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    expect(injected(before.current)[0]?.text).toContain("oldMessageNeedle()")

    source = [
      message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "newMessageNeedle() evidence")], 1),
    ]
    await instance.hooks.event!({
      event: {
        type: "message.updated",
        properties: { info: { id: "h1", sessionID: "history", role: "assistant", time: { created: 1 } } },
      } as any,
    })

    const oldQuery = currentOutput("current-b", "Recall oldMessageNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, oldQuery.output as any)
    expect(injected(oldQuery.current)).toHaveLength(0)

    const newQuery = currentOutput("current-c", "Recall newMessageNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, newQuery.output as any)
    expect(injected(newQuery.current)[0]?.text).toContain("newMessageNeedle()")
  })

  test("dirty transcript refetch failure keeps stale evidence unavailable", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    let fail = false
    const instance = await plugin({
      file,
      sessions: [historical],
      messages: {
        history: async () => {
          if (fail) throw new Error("raw transcript unavailable")
          return {
            data: [
              message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "dirtyFailureNeedle() evidence")], 1),
            ],
          }
        },
      },
    })

    const before = currentOutput("current-a", "Recall dirtyFailureNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, before.output as any)
    expect(injected(before.current)[0]?.text).toContain("dirtyFailureNeedle()")

    fail = true
    await instance.hooks.event!({
      event: {
        type: "message.part.removed",
        properties: { sessionID: "history", messageID: "h1", partID: "part-1" },
      } as any,
    })

    const after = currentOutput("current-b", "Recall dirtyFailureNeedle()")
    await instance.hooks["experimental.chat.messages.transform"]!({}, after.output as any)
    expect(injected(after.current)).toHaveLength(0)
  })

  test("independent plugin instance verifies selected stale evidence against raw Kilo transcript", async () => {
    const file = await indexFile()
    const historical = session("history", "project-A", "/repo/main", 10)
    const first = await plugin({
      file,
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "crossProcessOldNeedle() evidence")], 1),
        ],
      },
    })
    const initial = currentOutput("current-a", "Recall crossProcessOldNeedle()")
    await first.hooks["experimental.chat.messages.transform"]!({}, initial.output as any)
    expect(injected(initial.current)[0]?.text).toContain("crossProcessOldNeedle()")

    const second = await plugin({
      file,
      sessions: [historical],
      messages: {
        history: [
          message("h1", "history", "assistant", [textPart("part-1", "history", "h1", "crossProcessNewNeedle() evidence")], 1),
        ],
      },
    })
    const staleQuery = currentOutput("current-b", "Recall crossProcessOldNeedle()")
    await second.hooks["experimental.chat.messages.transform"]!({}, staleQuery.output as any)
    expect(second.calls.messages).toContain("history")
    expect(injected(staleQuery.current)).toHaveLength(0)
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
})
