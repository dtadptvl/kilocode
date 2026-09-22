import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  MAX_INDEX_FAMILIES,
  MAX_SESSION_BYTES,
  MAX_TRACE_TEXT_BYTES,
  MAX_TRACE_TEXT_CHARS,
  utf8Bytes,
  type Trace,
} from "../src/core"
import { PersistentIndex } from "../src/store"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile(name = "index.json") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zero-mem-store-"))
  temps.push(dir)
  return path.join(dir, name)
}

function trace(sessionID: string, partID: string, text: string, timestamp = 1): Trace {
  return {
    projectID: "p",
    sessionID,
    messageID: "m-" + partID,
    partID,
    timestamp,
    role: "assistant",
    kind: "text",
    directory: "/repo",
    text,
    entities: [],
  }
}

function upsert(
  store: PersistentIndex,
  familyKey: string,
  sessionID: string,
  updated: number,
  text: string,
  indexedAt = updated,
) {
  store.upsert(familyKey, {
    projectID: "p",
    sessionID,
    directory: "/repo",
    updated,
    indexedAt,
    fingerprint: `${sessionID}:v:${updated}`,
    traces: [trace(sessionID, "part-" + updated, text, updated)],
  })
}

describe("persistent derived index", () => {
  test("persists and reloads family-scoped session data", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()
    upsert(store, "/repo", "s", 10, "needle")
    expect(await store.save()).toBe(true)

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("/repo", "s")?.fingerprint).toBe("s:v:10")
    expect(next.session("/repo", "s")?.traces[0]?.text).toBe("needle")
  })

  test("authoritative reconciliation removes deleted sessions", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()
    upsert(store, "/repo", "s-live", 10, "live", 10)
    upsert(store, "/repo", "s-deleted", 11, "deletedNeedle()", 11)
    await store.save()

    store.reconcile("/repo", ["s-live"], 20)
    await store.save()

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("/repo", "s-live")).toBeDefined()
    expect(next.session("/repo", "s-deleted")).toBeUndefined()
    expect(next.candidates("/repo", "deletedNeedle()")).toEqual([])
  })

  test("concurrent independent writers preserve both mutations", async () => {
    const file = await tempFile()
    const a = new PersistentIndex(file)
    const b = new PersistentIndex(file)
    await Promise.all([a.load(), b.load()])

    upsert(a, "/repo", "session-a", 10, "alphaNeedle()")
    upsert(b, "/repo", "session-b", 11, "betaNeedle()")
    const saved = await Promise.all([a.save(), b.save()])
    expect(saved).toEqual([true, true])

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("/repo", "session-a")?.traces[0]?.text).toContain("alphaNeedle()")
    expect(next.session("/repo", "session-b")?.traces[0]?.text).toContain("betaNeedle()")
  })

  test("concurrent same-session updates deterministically keep newest version", async () => {
    const file = await tempFile()
    const older = new PersistentIndex(file)
    const newer = new PersistentIndex(file)
    await Promise.all([older.load(), newer.load()])

    upsert(older, "/repo", "same", 10, "oldVersion()")
    upsert(newer, "/repo", "same", 20, "newVersion()")
    await Promise.all([newer.save(), older.save()])

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("/repo", "same")?.updated).toBe(20)
    expect(next.session("/repo", "same")?.traces[0]?.text).toContain("newVersion()")
  })

  test("stale lock is recovered deterministically", async () => {
    const file = await tempFile()
    const lock = file + ".lock"
    await writeFile(lock, '{"token":"stale"}', "utf8")
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)

    const store = new PersistentIndex(file, { lockTimeoutMs: 150, lockStaleMs: 20, lockPollMs: 5 })
    await store.load()
    upsert(store, "/repo", "s", 1, "staleLockNeedle()")
    expect(await store.save()).toBe(true)

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("/repo", "s")).toBeDefined()
  })

  test("live lock timeout returns false without corrupting pending data", async () => {
    const file = await tempFile()
    await writeFile(file + ".lock", '{"token":"live"}', "utf8")

    const store = new PersistentIndex(file, { lockTimeoutMs: 35, lockStaleMs: 10_000, lockPollMs: 10 })
    await store.load()
    upsert(store, "/repo", "s", 1, "lockTimeoutNeedle()")
    const start = Date.now()
    expect(await store.save()).toBe(false)
    expect(Date.now() - start).toBeLessThan(300)
    expect(store.session("/repo", "s")).toBeDefined()
  })

  test("oversized raw trace text is bounded by chars and UTF-8 bytes", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()
    upsert(store, "/repo", "s", 1, "🙂".repeat(MAX_TRACE_TEXT_CHARS * 3))

    const text = store.session("/repo", "s")!.traces[0].text
    expect(text.length).toBeLessThanOrEqual(MAX_TRACE_TEXT_CHARS)
    expect(utf8Bytes(text)).toBeLessThanOrEqual(MAX_TRACE_TEXT_BYTES)
  })

  test("aggregate session storage is bounded deterministically", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()
    store.upsert("/repo", {
      projectID: "p",
      sessionID: "large",
      directory: "/repo",
      updated: 1,
      fingerprint: "large:v:1",
      traces: Array.from({ length: 200 }, (_, index) =>
        trace("large", "part-" + index, String(index).padStart(4, "0") + ":" + "x".repeat(10_000), index),
      ),
    })

    const session = store.session("/repo", "large")!
    const bytes = session.traces.reduce((total, item) => total + utf8Bytes(JSON.stringify(item)), 0)
    expect(bytes).toBeLessThanOrEqual(MAX_SESSION_BYTES)
    expect(session.traces.at(-1)?.partID).toBe("part-199")
  })

  test("family retention and total file bytes are bounded", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file, { maxStoreBytes: 24_000 })
    await store.load()

    for (let family = 0; family < MAX_INDEX_FAMILIES + 4; family++) {
      for (let session = 0; session < 4; session++) {
        upsert(
          store,
          "/family-" + family,
          `s-${family}-${session}`,
          family * 10 + session,
          "x".repeat(3000),
          family * 10 + session,
        )
      }
    }

    expect(await store.save()).toBe(true)
    expect((await stat(file)).size).toBeLessThanOrEqual(24_000)

    const parsed = JSON.parse(await readFile(file, "utf8"))
    expect(Object.keys(parsed.families).length).toBeLessThanOrEqual(MAX_INDEX_FAMILIES)
  })

  test("legacy v2 filename is preserved for safe rebuild under neutral filename", async () => {
    const file = await tempFile("zero-mem-index.json")
    const legacy = path.join(path.dirname(file), "zero-mem-index-v1.json")
    await writeFile(legacy, JSON.stringify({ version: 2, projects: { p: { sessions: {} } } }), "utf8")

    const store = new PersistentIndex(file, { legacyFile: legacy })
    await store.load()
    expect(store.sessions("/repo")).toEqual([])
    expect(await stat(legacy + ".legacy-v2")).toBeDefined()
  })

  test("corrupted index is quarantined and recreated fail-open", async () => {
    const file = await tempFile()
    await writeFile(file, "{not-json", "utf8")

    const store = new PersistentIndex(file)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.sessions("/repo")).toEqual([])

    upsert(store, "/repo", "s", 10, "recovered")
    expect(await store.save()).toBe(true)

    const parsed = JSON.parse(await readFile(file, "utf8"))
    expect(parsed.version).toBe(3)
    expect(parsed.families["/repo"].sessions.s.traces[0].text).toBe("recovered")
  })
})
