import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  INDEX_LOCK_POLL_MS,
  INDEX_LOCK_STALE_MS,
  INDEX_LOCK_TIMEOUT_MS,
  MAX_INDEX_FAMILIES,
  MAX_INDEX_SESSIONS,
  MAX_SESSION_INDEX_BYTES,
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
  familyID: string
  projectID: string
  sessionID: string
  directory: string
  updated: number
  fingerprint: string
  traces: Trace[]
  lookup: Record<string, number[]>
}

export type SessionInput = Omit<IndexedSession, "familyID" | "lookup" | "traces"> & { traces: Trace[] }

type Family = {
  id: string
  projectIDs: string[]
  updated: number
}

type IndexFile = {
  version: 3
  families: Record<string, Family>
  sessions: Record<string, IndexedSession>
}

type V2Index = {
  version: 2
  projects: Record<
    string,
    {
      sessions: Record<
        string,
        Omit<IndexedSession, "familyID"> & { familyID?: string }
      >
    }
  >
}

type Mutation =
  | { kind: "upsert"; projectIDs: string[]; session: SessionInput }
  | { kind: "remove"; sessionID: string }
  | {
      kind: "reconcile"
      projectIDs: string[]
      liveSessionIDs: string[]
      authoritative: boolean
      snapshotAt: number
    }

export type StoreOptions = {
  legacyFile?: string
  lockTimeoutMs?: number
  lockStaleMs?: number
  lockPollMs?: number
  maxSessionBytes?: number
  maxStoreBytes?: number
  maxFamilies?: number
  maxSessions?: number
}

function empty(): IndexFile {
  return { version: VERSION, families: {}, sessions: {} }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validV3(value: unknown): value is IndexFile {
  if (!record(value) || value.version !== VERSION) return false
  return record(value.families) && record(value.sessions)
}

function validV2(value: unknown): value is V2Index {
  return record(value) && value.version === 2 && record(value.projects)
}

function familyID(projectIDs: string[]) {
  const first = [...new Set(projectIDs.filter(Boolean))].sort()[0] ?? "unknown"
  return "family:" + first
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

function migrateV2(value: V2Index, maxSessionBytes: number): IndexFile {
  const data = empty()
  for (const [projectID, project] of Object.entries(value.projects)) {
    const id = familyID([projectID])
    data.families[id] = { id, projectIDs: [projectID], updated: 0 }
    for (const raw of Object.values(project.sessions ?? {})) {
      const traces = boundTraces(Array.isArray(raw.traces) ? raw.traces : [], maxSessionBytes)
      const session: IndexedSession = {
        ...raw,
        familyID: id,
        projectID: raw.projectID || projectID,
        traces,
        lookup: buildLookup(traces),
      }
      data.sessions[session.sessionID] = session
      data.families[id].updated = Math.max(data.families[id].updated, session.updated || 0)
    }
  }
  return data
}

function compareSession(a: Pick<IndexedSession, "updated" | "fingerprint">, b: Pick<SessionInput, "updated" | "fingerprint">) {
  if (a.updated !== b.updated) return a.updated - b.updated
  return a.fingerprint.localeCompare(b.fingerprint)
}

function resolveFamily(data: IndexFile, projectIDs: string[], now: number) {
  const projects = [...new Set(projectIDs.filter(Boolean))].sort()
  const set = new Set(projects)
  const matches = Object.values(data.families)
    .filter((family) => family.projectIDs.some((id) => set.has(id)))
    .map((family) => family.id)
    .sort()

  const canonical = matches[0] ?? familyID(projects)
  const mergedProjects = new Set(projects)
  for (const id of matches) {
    for (const projectID of data.families[id]?.projectIDs ?? []) mergedProjects.add(projectID)
  }

  for (const session of Object.values(data.sessions)) {
    if (matches.includes(session.familyID) && session.familyID !== canonical) session.familyID = canonical
  }
  for (const id of matches) {
    if (id !== canonical) delete data.families[id]
  }

  const current = data.families[canonical]
  data.families[canonical] = {
    id: canonical,
    projectIDs: [...new Set([...(current?.projectIDs ?? []), ...mergedProjects])].sort(),
    updated: Math.max(current?.updated ?? 0, now),
  }
  return canonical
}

function traceBytes(trace: Trace) {
  return utf8Bytes(JSON.stringify(trace))
}

function boundTraces(traces: Trace[], maxSessionBytes: number) {
  const bounded = traces
    .slice(-MAX_TRACES_PER_SESSION)
    .map((trace) => {
      const text = clipRawText(trace.text)
      return { ...trace, text, entities: entities(text) }
    })

  let bytes = bounded.reduce((sum, trace) => sum + traceBytes(trace), 0)
  while (bounded.length > 1 && bytes > maxSessionBytes) {
    const removed = bounded.shift()!
    bytes -= traceBytes(removed)
  }
  if (bounded.length === 1 && bytes > maxSessionBytes) {
    const only = bounded[0]
    const original = only.text
    let low = 0
    let high = original.length
    let best = { ...only, text: "", entities: [] as string[] }

    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const text = clipRawText(original, middle)
      const candidate = { ...only, text, entities: entities(text) }
      if (traceBytes(candidate) <= maxSessionBytes) {
        best = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    bounded[0] = best
  }
  return bounded
}

function applyMutation(data: IndexFile, mutation: Mutation, maxSessionBytes: number) {
  if (mutation.kind === "remove") {
    delete data.sessions[mutation.sessionID]
    return
  }

  if (mutation.kind === "reconcile") {
    const id = resolveFamily(data, mutation.projectIDs, mutation.snapshotAt)
    if (!mutation.authoritative) return
    const live = new Set(mutation.liveSessionIDs)
    for (const [sessionID, session] of Object.entries(data.sessions)) {
      if (session.familyID !== id) continue
      if (live.has(sessionID)) continue
      // Preserve a session indexed after this listing snapshot to avoid a stale
      // reconciliation deleting a concurrently-created session.
      if (session.updated > mutation.snapshotAt) continue
      delete data.sessions[sessionID]
    }

    const retainedProjectIDs = Object.values(data.sessions)
      .filter((session) => session.familyID === id)
      .map((session) => session.projectID)
      .filter(Boolean)
    data.families[id].projectIDs = [
      ...new Set([...mutation.projectIDs.filter(Boolean), ...retainedProjectIDs]),
    ].sort()
    return
  }

  const id = resolveFamily(data, mutation.projectIDs, mutation.session.updated)
  const existing = data.sessions[mutation.session.sessionID]
  if (existing && compareSession(existing, mutation.session) >= 0) return

  const traces = boundTraces(mutation.session.traces, maxSessionBytes)
  data.sessions[mutation.session.sessionID] = {
    ...mutation.session,
    familyID: id,
    traces,
    lookup: buildLookup(traces),
  }
  data.families[id].updated = Math.max(data.families[id].updated, mutation.session.updated)
}

function prune(data: IndexFile, options: Required<Pick<StoreOptions, "maxFamilies" | "maxSessions" | "maxStoreBytes">>) {
  const keepFamilies = Object.values(data.families)
    .sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id))
    .slice(0, options.maxFamilies)
  const familyIDs = new Set(keepFamilies.map((family) => family.id))
  for (const id of Object.keys(data.families)) if (!familyIDs.has(id)) delete data.families[id]
  for (const [id, session] of Object.entries(data.sessions)) {
    if (!familyIDs.has(session.familyID)) delete data.sessions[id]
  }

  const keepSessions = Object.values(data.sessions)
    .sort((a, b) => b.updated - a.updated || a.sessionID.localeCompare(b.sessionID))
    .slice(0, options.maxSessions)
  const sessionIDs = new Set(keepSessions.map((session) => session.sessionID))
  for (const id of Object.keys(data.sessions)) if (!sessionIDs.has(id)) delete data.sessions[id]

  const oldest = () =>
    Object.values(data.sessions).sort((a, b) => a.updated - b.updated || b.sessionID.localeCompare(a.sessionID))[0]

  while (utf8Bytes(JSON.stringify(data)) > options.maxStoreBytes) {
    const session = oldest()
    if (!session) break
    delete data.sessions[session.sessionID]
  }

  const usedFamilies = new Set(Object.values(data.sessions).map((session) => session.familyID))
  const families = Object.values(data.families).sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id))
  for (const family of families) {
    if (usedFamilies.has(family.id)) continue
    if (Object.keys(data.families).length <= options.maxFamilies) break
    delete data.families[family.id]
  }

  // MAX_STORE_BYTES is absolute, including family metadata. If sessions are
  // already gone, evict the oldest remaining family metadata until the file fits.
  while (utf8Bytes(JSON.stringify(data)) > options.maxStoreBytes) {
    const family = Object.values(data.families)
      .sort((a, b) => a.updated - b.updated || b.id.localeCompare(a.id))[0]
    if (!family) break
    delete data.families[family.id]
    for (const [sessionID, session] of Object.entries(data.sessions)) {
      if (session.familyID === family.id) delete data.sessions[sessionID]
    }
  }
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export class PersistentIndex {
  private data: IndexFile = empty()
  private loaded = false
  private pending: Mutation[] = []
  private writeChain: Promise<boolean> = Promise.resolve(true)

  readonly legacyFile?: string
  readonly lockTimeoutMs: number
  readonly lockStaleMs: number
  readonly lockPollMs: number
  readonly maxSessionBytes: number
  readonly maxStoreBytes: number
  readonly maxFamilies: number
  readonly maxSessions: number

  constructor(readonly file: string, options: StoreOptions = {}) {
    this.legacyFile = options.legacyFile
    this.lockTimeoutMs = options.lockTimeoutMs ?? INDEX_LOCK_TIMEOUT_MS
    this.lockStaleMs = options.lockStaleMs ?? INDEX_LOCK_STALE_MS
    this.lockPollMs = options.lockPollMs ?? INDEX_LOCK_POLL_MS
    this.maxSessionBytes = options.maxSessionBytes ?? MAX_SESSION_INDEX_BYTES
    this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES
    this.maxFamilies = options.maxFamilies ?? MAX_INDEX_FAMILIES
    this.maxSessions = options.maxSessions ?? MAX_INDEX_SESSIONS
  }

  private async decode(file: string) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
    if (validV3(parsed)) return parsed
    if (validV2(parsed)) return migrateV2(parsed, this.maxSessionBytes)
    throw new Error("unsupported or invalid index schema")
  }

  private async disk() {
    try {
      return await this.decode(this.file)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== "ENOENT") {
        await rename(this.file, this.file + ".corrupt-" + Date.now()).catch(() => undefined)
      }
    }

    if (this.legacyFile) {
      try {
        return await this.decode(this.legacyFile)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== "ENOENT") {
          await rename(this.legacyFile, this.legacyFile + ".corrupt-" + Date.now()).catch(() => undefined)
        }
      }
    }
    return empty()
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    this.data = await this.disk().catch(() => empty())
    prune(this.data, {
      maxFamilies: this.maxFamilies,
      maxSessions: this.maxSessions,
      maxStoreBytes: this.maxStoreBytes,
    })
  }

  private local(mutation: Mutation) {
    applyMutation(this.data, mutation, this.maxSessionBytes)
    prune(this.data, {
      maxFamilies: this.maxFamilies,
      maxSessions: this.maxSessions,
      maxStoreBytes: this.maxStoreBytes,
    })
    this.pending.push(mutation)
  }

  reconcileFamily(projectIDs: string[], liveSessionIDs: Set<string>, authoritative: boolean, snapshotAt = Date.now()) {
    const mutation: Mutation = {
      kind: "reconcile",
      projectIDs: [...projectIDs],
      liveSessionIDs: [...liveSessionIDs],
      authoritative,
      snapshotAt,
    }
    this.local(mutation)
    return resolveFamily(this.data, projectIDs, snapshotAt)
  }

  upsert(projectIDs: string[], session: SessionInput) {
    this.local({ kind: "upsert", projectIDs: [...projectIDs], session })
  }

  remove(sessionID: string) {
    this.local({ kind: "remove", sessionID })
  }

  async refresh() {
    await this.load()
    const merged = await this.disk()
    for (const mutation of this.pending) applyMutation(merged, mutation, this.maxSessionBytes)
    prune(merged, {
      maxFamilies: this.maxFamilies,
      maxSessions: this.maxSessions,
      maxStoreBytes: this.maxStoreBytes,
    })
    this.data = merged
  }

  session(sessionID: string) {
    return this.data.sessions[sessionID]
  }

  sessions(family: string) {
    return Object.values(this.data.sessions)
      .filter((session) => session.familyID === family)
      .sort((a, b) => b.updated - a.updated || a.sessionID.localeCompare(b.sessionID))
  }

  candidates(family: string, query: string) {
    const keys = new Set([...entities(query), ...tokens(query)].map(normalize))
    if (!keys.size) return [] as Trace[]

    const out: Trace[] = []
    const seen = new Set<string>()
    for (const session of this.sessions(family)) {
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

  private async acquireLock() {
    const lock = this.file + ".lock"
    const started = Date.now()
    while (Date.now() - started <= this.lockTimeoutMs) {
      try {
        await mkdir(lock)
        await writeFile(
          path.join(lock, "owner.json"),
          JSON.stringify({ pid: process.pid, created: Date.now() }),
          "utf8",
        ).catch(() => undefined)
        return async () => {
          await rm(lock, { recursive: true, force: true }).catch(() => undefined)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") return undefined
        const info = await stat(lock).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs > this.lockStaleMs) {
          await rm(lock, { recursive: true, force: true }).catch(() => undefined)
          continue
        }
        await delay(this.lockPollMs)
      }
    }
    return undefined
  }

  async save() {
    await this.load()
    const task = async () => {
      if (!this.pending.length) return true
      const count = this.pending.length
      const pending = this.pending.slice(0, count)
      const release = await this.acquireLock()
      if (!release) return false

      try {
        const merged = await this.disk()
        for (const mutation of pending) applyMutation(merged, mutation, this.maxSessionBytes)
        prune(merged, {
          maxFamilies: this.maxFamilies,
          maxSessions: this.maxSessions,
          maxStoreBytes: this.maxStoreBytes,
        })

        await mkdir(path.dirname(this.file), { recursive: true })
        const tmp = this.file + ".tmp-" + process.pid + "-" + Date.now()
        await writeFile(tmp, JSON.stringify(merged), "utf8")
        await rename(tmp, this.file)
        if (this.legacyFile && this.legacyFile !== this.file) {
          await rm(this.legacyFile, { force: true }).catch(() => undefined)
        }

        this.data = merged
        this.pending.splice(0, count)
        return true
      } catch {
        return false
      } finally {
        await release()
      }
    }

    this.writeChain = this.writeChain.then(task, task)
    return this.writeChain
  }

  async reset() {
    this.data = empty()
    this.pending = []
    this.loaded = true
    await rm(this.file, { force: true }).catch(() => undefined)
    if (this.legacyFile) await rm(this.legacyFile, { force: true }).catch(() => undefined)
  }
}
