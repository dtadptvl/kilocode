import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MAX_TRACE_TEXT_BYTES, MAX_TRACE_TEXT_CHARS, utf8Bytes, type Trace } from "../src/core"
import { PersistentIndex, type SessionInput } from "../src/store"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name = "index.json") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zero-mem-store-"))
  temps.push(dir)
  return path.join(dir, name)
}

function trace(partID: string, text: string, input: Partial<Trace> = {}): Trace {
  return {
    projectID: input.projectID ?? "p",
    sessionID: input.sessionID ?? "s",
    messageID: input.messageID ?? "m",
    partID,
    timestamp: input.timestamp ?? 1,
    role: input.role ?? "assistant",
    kind: input.kind ?? "text",
    directory: input.directory ?? "/repo",
    text,
    entities: input.entities ?? [],
    source: input.source,
  }
}

function session(id: string, updated: number, text = "needle", projectID = "p"): SessionInput {
  return {
    projectID,
    sessionID: id,
    directory: "/repo",
    updated,
    fingerprint: `${id}:v:${updated}`,
    traces: [trace("part-" + id, text, { projectID, sessionID: id, messageID: "m-" + id, timestamp: updated })],
  }
}

describe("persistent derived index", () => {
  test("persists and reloads session data", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()
    store.reconcileFamily(["p"], new Set(["s"]), true, 10)
    store.upsert(["p"], session("s", 10))
    expect(await store.save()).toBe(true)

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("s")?.fingerprint).toBe("s:v:10")
    expect(next.session("s")?.traces[0]?.text).toBe("needle")
  })

  test("authoritative reconciliation removes deleted indexed sessions", async () => {
    const file = await tempFile()
    const first = new PersistentIndex(file)
    await first.load()
    first.reconcileFamily(["p"], new Set(["x"]), true, 10)
    first.upsert(["p"], session("x", 9, "deletedNeedle"))
    await first.save()
    expect(first.session("x")).toBeDefined()

    const second = new PersistentIndex(file)
    await second.load()
    second.reconcileFamily(["p"], new Set(), true, 20)
    await second.save()

    const reloaded = new PersistentIndex(file)
    await reloaded.load()
    expect(reloaded.session("x")).toBeUndefined()
  })

  test("independent concurrent writers preserve both mutations", async () => {
    const file = await tempFile()
    const a = new PersistentIndex(file)
    const b = new PersistentIndex(file)
    await Promise.all([a.load(), b.load()])

    a.upsert(["p"], session("a", 10, "prime"))
    b.upsert(["p"], session("b", 11, "sub"))
    const results = await Promise.all([a.save(), b.save()])
    expect(results).toEqual([true, true])

    const reloaded = new PersistentIndex(file)
    await reloaded.load()
    expect(reloaded.session("a")?.traces[0]?.text).toBe("prime")
    expect(reloaded.session("b")?.traces[0]?.text).toBe("sub")
  })

  test("same-session concurrent updates deterministically keep the newest mutation", async () => {
    const file = await tempFile()
    const older = new PersistentIndex(file)
    const newer = new PersistentIndex(file)
    await Promise.all([older.load(), newer.load()])

    older.upsert(["p"], session("same", 10, "old"))
    newer.upsert(["p"], session("same", 20, "new"))
    await newer.save()
    await older.save()

    const reloaded = new PersistentIndex(file)
    await reloaded.load()
    expect(reloaded.session("same")?.updated).toBe(20)
    expect(reloaded.session("same")?.traces[0]?.text).toBe("new")
  })

  test("stale lock is recovered deterministically", async () => {
    const file = await tempFile()
    const lock = file + ".lock"
    await mkdir(lock)
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 999999, created: 1 }), "utf8")
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)

    const store = new PersistentIndex(file, { lockStaleMs: 20, lockTimeoutMs: 250, lockPollMs: 5 })
    await store.load()
    store.upsert(["p"], session("s", 10))
    expect(await store.save()).toBe(true)
    expect(store.session("s")).toBeDefined()
  })

  test("fresh lock timeout fails open without overwriting disk", async () => {
    const file = await tempFile()
    await mkdir(file + ".lock")

    const store = new PersistentIndex(file, { lockStaleMs: 10_000, lockTimeoutMs: 25, lockPollMs: 5 })
    await store.load()
    store.upsert(["p"], session("s", 10))
    expect(await store.save()).toBe(false)
    expect(await stat(file).then(() => true).catch(() => false)).toBe(false)
  })

  test("oversized trace text and aggregate session storage are bounded", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file, { maxSessionBytes: 4_000 })
    await store.load()
    const many = Array.from({ length: 20 }, (_, index) =>
      trace("p-" + index, "🙂".repeat(MAX_TRACE_TEXT_CHARS * 2), {
        sessionID: "big",
        messageID: "m-" + index,
        timestamp: index,
      }),
    )
    store.upsert(["p"], {
      projectID: "p",
      sessionID: "big",
      directory: "/repo",
      updated: 20,
      fingerprint: "big:v:20",
      traces: many,
    })

    const indexed = store.session("big")!
    expect(indexed.traces.every((item) => item.text.length <= MAX_TRACE_TEXT_CHARS)).toBe(true)
    expect(indexed.traces.every((item) => utf8Bytes(item.text) <= MAX_TRACE_TEXT_BYTES)).toBe(true)
    expect(indexed.traces.reduce((sum, item) => sum + utf8Bytes(JSON.stringify(item)), 0)).toBeLessThanOrEqual(4_000)
  })

  test("store byte and family retention bounds prevent unbounded stale growth", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file, {
      maxStoreBytes: 6_000,
      maxFamilies: 2,
      maxSessions: 100,
      maxSessionBytes: 2_000,
    })
    await store.load()

    for (let index = 0; index < 6; index++) {
      const project = "project-" + index
      store.reconcileFamily([project], new Set(["s-" + index]), true, 100 + index)
      store.upsert([project], session("s-" + index, 100 + index, "z".repeat(1800), project))
    }
    expect(await store.save()).toBe(true)

    const parsed = JSON.parse(await readFile(file, "utf8"))
    expect(Object.keys(parsed.families).length).toBeLessThanOrEqual(2)
    expect((await stat(file)).size).toBeLessThanOrEqual(6_000)
  })

  test("corrupted index is quarantined and recreated fail-open", async () => {
    const file = await tempFile()
    await writeFile(file, "{not-json", "utf8")

    const store = new PersistentIndex(file)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.session("missing")).toBeUndefined()

    store.upsert(["p"], session("s", 10, "recovered"))
    expect(await store.save()).toBe(true)

    const parsed = JSON.parse(await readFile(file, "utf8"))
    expect(parsed.version).toBe(3)
    expect(parsed.sessions.s.traces[0].text).toBe("recovered")
  })

  test("migrates existing v2 index from legacy filename into version-neutral file", async () => {
    const file = await tempFile("zero-mem-index.json")
    const legacy = path.join(path.dirname(file), "zero-mem-index-v1.json")
    const oldTrace = trace("old-part", "legacyNeedle", { sessionID: "old", messageID: "old-message" })
    await writeFile(
      legacy,
      JSON.stringify({
        version: 2,
        projects: {
          p: {
            sessions: {
              old: {
                projectID: "p",
                sessionID: "old",
                directory: "/repo",
                updated: 7,
                fingerprint: "old:v:7",
                traces: [oldTrace],
                lookup: {},
              },
            },
          },
        },
      }),
      "utf8",
    )

    const store = new PersistentIndex(file, { legacyFile: legacy })
    await store.load()
    expect(store.session("old")?.traces[0]?.text).toBe("legacyNeedle")
    store.reconcileFamily(["p"], new Set(["old"]), true, 8)
    expect(await store.save()).toBe(true)

    const parsed = JSON.parse(await readFile(file, "utf8"))
    expect(parsed.version).toBe(3)
    expect(parsed.sessions.old).toBeDefined()
    expect(await stat(legacy).then(() => true).catch(() => false)).toBe(false)
  })
})
