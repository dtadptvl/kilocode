import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  INDEX_LOCK_POLL_MS,
  INDEX_LOCK_STALE_MS,
  INDEX_LOCK_TIMEOUT_MS,
  MAX_INDEX_FAMILIES,
  MAX_INDEX_SESSIONS,
  MAX_SESSION_BYTES,
  MAX_STORE_BYTES,
  MAX_TRACES_PER_SESSION,
  clipRawText,
  entities,
  normalize,
  tokens,
  utf8Bytes,
  type Trace,
} from "./core.js"

const VERSION = 3

export type IndexedSession = {
  familyKey: string
  projectID: string
  sessionID: string
  directory: string
  updated: number
  indexedAt: number
  fingerprint: string
  traces: Trace[]
  lookup: Record<string, number[]>
}

type FamilyIndex = {
  touched: number
  sessions: Record<string, IndexedSession>
}

type IndexFile = {
  version: 3
  families: Record<string, FamilyIndex>
}

type Mutation =
  | { type: "upsert"; familyKey: string; session: IndexedSession }
  | { type: "remove"; familyKey: string; sessionID: string }
  | { type: "reconcile"; familyKey: string; live: string[]; observedAt: number }

type StoreOptions = {
  legacyFile?: string
  lockTimeoutMs?: number
  lockStaleMs?: number
  lockPollMs?: number
  now?: () => number
  maxStoreBytes?: number
}

function empty(): IndexFile {
  return { version: VERSION, families: {} }
}

function valid(value: unknown): value is IndexFile {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return row.version === VERSION && !!row.families && typeof row.families === "object"
}

function buildLookup(traces: Trace[]) {
  const lookup: Record<string, number[]> = {}
  traces.forEach((trace, index) => {
    const keys = new Set([...trace.entities, ...entities(trace.text), ...tokens(trace.text)].map(normalize))
    for (const key of keys) {
      if (!key) continue
      ;(lookup[key] ??= []).push(index)
    }
  })
  return lookup
}

function boundTrace(trace: Trace): Trace {
  const text = clipRawText(trace.text)
  return { ...trace, text, entities: entities(text) }
}

function boundSession(input: Omit<IndexedSession, "lookup"> & { lookup?: Record<string, number[]> }): IndexedSession {
  const clipped = input.traces.slice(-MAX_TRACES_PER_SESSION).map(boundTrace)
  const kept: Trace[] = []
  let bytes = 0

  for (let index = clipped.length - 1; index >= 0; index--) {
    const trace = clipped[index]
    const size = utf8Bytes(JSON.stringify(trace))
    if (kept.length > 0 && bytes + size > MAX_SESSION_BYTES) break
    if (size > MAX_SESSION_BYTES) continue
    kept.push(trace)
    bytes += size
  }

  kept.reverse()
  return { ...input, traces: kept, lookup: buildLookup(kept) }
}

function newer(left: IndexedSession | undefined, right: IndexedSession) {
  if (!left) return right
  if (right.updated !== left.updated) return right.updated > left.updated ? right : left
  if (right.fingerprint !== left.fingerprint) return right.fingerprint > left.fingerprint ? right : left
  return right.indexedAt >= left.indexedAt ? right : left
}

function compact(data: IndexFile, maxStoreBytes = MAX_STORE_BYTES) {
  const families = Object.entries(data.families)
    .sort(([ak, a], [bk, b]) => b.touched - a.touched || ak.localeCompare(bk))
    .slice(0, MAX_INDEX_FAMILIES)

  data.families = Object.fromEntries(
    families.map(([key, family]) => {
      const sessions = Object.values(family.sessions)
        .sort((a, b) => b.updated - a.updated || a.sessionID.localeCompare(b.sessionID))
        .slice(0, MAX_INDEX_SESSIONS)
      return [key, { ...family, sessions: Object.fromEntries(sessions.map((session) => [session.sessionID, session])) }]
    }),
  )

  if (utf8Bytes(JSON.stringify(data)) <= maxStoreBytes) return

  const oldest = Object.entries(data.families)
    .flatMap(([familyKey, family]) =>
      Object.values(family.sessions).map((session) => ({ familyKey, sessionID: session.sessionID, updated: session.updated })),
    )
    .sort((a, b) => a.updated - b.updated || a.familyKey.localeCompare(b.familyKey) || a.sessionID.localeCompare(b.sessionID))

  for (const item of oldest) {
    const family = data.families[item.familyKey]
    if (!family) continue
    delete family.sessions[item.sessionID]
    if (Object.keys(family.sessions).length === 0) delete data.families[item.familyKey]
    if (utf8Bytes(JSON.stringify(data)) <= maxStoreBytes) break
  }
}

function apply(data: IndexFile, mutation: Mutation) {
  if (mutation.type === "upsert") {
    const family = (data.families[mutation.familyKey] ??= { touched: mutation.session.indexedAt, sessions: {} })
    family.touched = Math.max(family.touched, mutation.session.indexedAt)
    family.sessions[mutation.session.sessionID] = newer(family.sessions[mutation.session.sessionID], mutation.session)
    return
  }

  const family = data.families[mutation.familyKey]
  if (!family) return

  if (mutation.type === "remove") {
    delete family.sessions[mutation.sessionID]
    if (Object.keys(family.sessions).length === 0) delete data.families[mutation.familyKey]
    return
  }

  family.touched = Math.max(family.touched, mutation.observedAt)
  const live = new Set(mutation.live)
  for (const [sessionID, session] of Object.entries(family.sessions)) {
    if (!live.has(sessionID) && session.indexedAt <= mutation.observedAt) delete family.sessions[sessionID]
  }
  if (Object.keys(family.sessions).length === 0) delete data.families[mutation.familyKey]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class PersistentIndex {
  private data: IndexFile = empty()
  private loaded = false
  private pending: Mutation[] = []
  private writeChain: Promise<boolean> = Promise.resolve(true)
  private readonly now: () => number
  private readonly lockTimeoutMs: number
  private readonly lockStaleMs: number
  private readonly lockPollMs: number
  private readonly legacyFile?: string
  private readonly maxStoreBytes: number

  constructor(
    readonly file: string,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.lockTimeoutMs = options.lockTimeoutMs ?? INDEX_LOCK_TIMEOUT_MS
    this.lockStaleMs = options.lockStaleMs ?? INDEX_LOCK_STALE_MS
    this.lockPollMs = options.lockPollMs ?? INDEX_LOCK_POLL_MS
    this.legacyFile = options.legacyFile
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES
  }

  private async preserveLegacy() {
    if (!this.legacyFile || this.legacyFile === this.file) return
    try {
      await stat(this.legacyFile)
    } catch {
      return
    }

    const preserved = this.legacyFile + ".legacy-v2"
    await rm(preserved, { force: true }).catch(() => undefined)
    await rename(this.legacyFile, preserved).catch(() => undefined)
  }

  private async readDisk(quarantine = true): Promise<IndexFile> {
    try {
      const text = await readFile(this.file, "utf8")
      const parsed = JSON.parse(text) as unknown
      if (!valid(parsed)) throw new Error("unsupported or invalid index schema")
      return parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === "ENOENT") return empty()
      if (quarantine) {
        const corrupt = this.file + ".corrupt-" + this.now()
        await rename(this.file, corrupt).catch(() => undefined)
      }
      return empty()
    }
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      await stat(this.file)
    } catch {
      await this.preserveLegacy()
    }
    this.data = await this.readDisk()
  }

  family(familyKey: string) {
    return this.data.families[familyKey]
  }

  session(familyKey: string, sessionID: string) {
    return this.data.families[familyKey]?.sessions[sessionID]
  }

  sessions(familyKey: string) {
    return Object.values(this.data.families[familyKey]?.sessions ?? {})
      .sort((a, b) => b.updated - a.updated || a.sessionID.localeCompare(b.sessionID))
      .slice(0, MAX_INDEX_SESSIONS)
  }

  candidates(familyKey: string, query: string) {
    const keys = new Set([...entities(query), ...tokens(query)].map(normalize))
    if (!keys.size) return [] as Trace[]

    const out: Trace[] = []
    const seen = new Set<string>()
    for (const session of this.sessions(familyKey)) {
      const indexes = new Set<number>()
      for (const key of keys) {
        for (const index of session.lookup[key] ?? []) indexes.add(index)
      }
      for (const index of indexes) {
        const trace = session.traces[index]
        if (!trace) continue
        const id = trace.sessionID + ":" + trace.partID
        if (seen.has(id)) continue
        seen.add(id)
        out.push(trace)
      }
    }
    return out
  }

  upsert(
    familyKey: string,
    input: Omit<IndexedSession, "familyKey" | "lookup" | "indexedAt"> & {
      indexedAt?: number
      lookup?: Record<string, number[]>
    },
  ) {
    const session = boundSession({
      ...input,
      familyKey,
      indexedAt: input.indexedAt ?? this.now(),
    })
    const family = (this.data.families[familyKey] ??= { touched: session.indexedAt, sessions: {} })
    family.touched = Math.max(family.touched, session.indexedAt)
    family.sessions[session.sessionID] = newer(family.sessions[session.sessionID], session)
    this.pending.push({ type: "upsert", familyKey, session })
    compact(this.data, this.maxStoreBytes)
  }

  remove(familyKey: string, sessionID: string) {
    const family = this.data.families[familyKey]
    if (family) {
      delete family.sessions[sessionID]
      if (Object.keys(family.sessions).length === 0) delete this.data.families[familyKey]
    }
    this.pending.push({ type: "remove", familyKey, sessionID })
  }

  reconcile(familyKey: string, liveSessionIDs: Iterable<string>, observedAt = this.now()) {
    const live = [...new Set(liveSessionIDs)].sort()
    const family = this.data.families[familyKey]
    if (family) {
      const set = new Set(live)
      for (const [sessionID, session] of Object.entries(family.sessions)) {
        if (!set.has(sessionID) && session.indexedAt <= observedAt) delete family.sessions[sessionID]
      }
      if (Object.keys(family.sessions).length === 0) delete this.data.families[familyKey]
    }
    this.pending.push({ type: "reconcile", familyKey, live, observedAt })
  }

  private async acquireLock() {
    const lock = this.file + ".lock"
    const deadline = this.now() + this.lockTimeoutMs

    while (this.now() <= deadline) {
      const token = `${process.pid}:${this.now()}:${randomUUID()}`
      try {
        await mkdir(path.dirname(this.file), { recursive: true })
        const handle = await open(lock, "wx")
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: this.now() }), "utf8")
        return { lock, token, handle }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return undefined
        try {
          const info = await stat(lock)
          if (this.now() - info.mtimeMs > this.lockStaleMs) {
            await rm(lock, { force: true })
            continue
          }
        } catch {
          continue
        }
        await sleep(this.lockPollMs)
      }
    }

    return undefined
  }

  private async releaseLock(lock: { lock: string; token: string; handle: Awaited<ReturnType<typeof open>> }) {
    await lock.handle.close().catch(() => undefined)
    try {
      const current = JSON.parse(await readFile(lock.lock, "utf8")) as { token?: string }
      if (current.token === lock.token) await rm(lock.lock, { force: true })
    } catch {
      // A stale-lock recovery may already have removed it.
    }
  }

  private async saveOnce() {
    await this.load()
    if (this.pending.length === 0) return true

    const count = this.pending.length
    const mutations = this.pending.slice(0, count)
    const lock = await this.acquireLock()
    if (!lock) return false

    try {
      const merged = await this.readDisk()
      for (const mutation of mutations) apply(merged, mutation)
      compact(merged, this.maxStoreBytes)

      const dir = path.dirname(this.file)
      await mkdir(dir, { recursive: true })
      const tmp = this.file + ".tmp-" + process.pid + "-" + this.now()
      await writeFile(tmp, JSON.stringify(merged), "utf8")
      await rename(tmp, this.file)
      this.data = merged
      this.pending.splice(0, count)
      return true
    } catch {
      return false
    } finally {
      await this.releaseLock(lock)
    }
  }

  async save() {
    const task = () => this.saveOnce()
    this.writeChain = this.writeChain.then(task, task)
    return this.writeChain
  }

  async reset() {
    this.data = empty()
    this.pending = []
    this.loaded = true
    await rm(this.file, { force: true }).catch(() => undefined)
  }
}
