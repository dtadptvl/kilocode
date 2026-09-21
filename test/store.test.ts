import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PersistentIndex } from "../src/store"
import type { Trace } from "../src/core"

const temps: string[] = []
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zero-mem-store-"))
  temps.push(dir)
  return path.join(dir, "index.json")
}

function trace(partID: string, text: string): Trace {
  return {
    projectID: "p",
    sessionID: "s",
    messageID: "m",
    partID,
    timestamp: 1,
    role: "assistant",
    kind: "text",
    directory: "/repo",
    text,
    entities: [],
  }
}

describe("persistent derived index", () => {
  test("incrementally persists and reloads unchanged session data", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()
    store.upsert({
      projectID: "p",
      sessionID: "s",
      directory: "/repo",
      updated: 10,
      fingerprint: "s:v:10",
      traces: [trace("part", "needle")],
    })
    await store.save()

    const next = new PersistentIndex(file)
    await next.load()
    expect(next.session("p", "s")?.fingerprint).toBe("s:v:10")
    expect(next.traces("p")[0]?.text).toBe("needle")
  })

  test("bounds retained sessions and traces", async () => {
    const file = await tempFile()
    const store = new PersistentIndex(file)
    await store.load()

    for (let index = 0; index < 505; index++) {
      store.upsert({
        projectID: "p",
        sessionID: "s-" + index,
        directory: "/repo",
        updated: index,
        fingerprint: "fp-" + index,
        traces: index === 504 ? Array.from({ length: 820 }, (_, part) => trace("p-" + part, "x")) : [trace("p", "x")],
      })
    }

    expect(store.sessions("p")).toHaveLength(500)
    expect(store.session("p", "s-504")?.traces).toHaveLength(800)
  })

  test("corrupted index is quarantined and recreated fail-open", async () => {
    const file = await tempFile()
    await writeFile(file, "{not-json", "utf8")

    const store = new PersistentIndex(file)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.traces("p")).toEqual([])

    store.upsert({
      projectID: "p",
      sessionID: "s",
      directory: "/repo",
      updated: 10,
      fingerprint: "s:v:10",
      traces: [trace("part", "recovered")],
    })
    await store.save()

    const parsed = JSON.parse(await readFile(file, "utf8"))
    expect(parsed.version).toBe(1)
    expect(parsed.projects.p.sessions.s.traces[0].text).toBe("recovered")
  })
})
