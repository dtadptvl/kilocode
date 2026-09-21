import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  MAX_INDEX_SESSIONS,
  MAX_TRACES_PER_SESSION,
  entities,
  normalize,
  tokens,
  type Trace,
} from "./core.js"

const VERSION = 2

export type IndexedSession = {
  projectID: string
  sessionID: string
  directory: string
  updated: number
  fingerprint: string
  traces: Trace[]
  lookup: Record<string, number[]>
}

type ProjectIndex = {
  sessions: Record<string, IndexedSession>
}

type IndexFile = {
  version: 2
  projects: Record<string, ProjectIndex>
}

function empty(): IndexFile {
  return { version: VERSION, projects: {} }
}

function valid(value: unknown): value is IndexFile {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return row.version === VERSION && !!row.projects && typeof row.projects === "object"
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

export class PersistentIndex {
  private data: IndexFile = empty()
  private loaded = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(readonly file: string) {}

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const text = await readFile(this.file, "utf8")
      const parsed = JSON.parse(text) as unknown
      if (!valid(parsed)) throw new Error("unsupported or invalid index schema")
      this.data = parsed
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === "ENOENT") {
        this.data = empty()
        return
      }
      const corrupt = this.file + ".corrupt-" + Date.now()
      await rename(this.file, corrupt).catch(() => undefined)
      this.data = empty()
    }
  }

  project(projectID: string) {
    return (this.data.projects[projectID] ??= { sessions: {} })
  }

  session(projectID: string, sessionID: string) {
    return this.data.projects[projectID]?.sessions[sessionID]
  }

  sessions(projectID: string) {
    return Object.values(this.data.projects[projectID]?.sessions ?? {})
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_INDEX_SESSIONS)
  }

  candidates(projectID: string, query: string) {
    const keys = new Set([...entities(query), ...tokens(query)].map(normalize))
    if (!keys.size) return [] as Trace[]

    const out: Trace[] = []
    const seen = new Set<string>()
    for (const session of this.sessions(projectID)) {
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

  upsert(input: Omit<IndexedSession, "lookup"> & { lookup?: Record<string, number[]> }) {
    const project = this.project(input.projectID)
    const traces = input.traces.slice(-MAX_TRACES_PER_SESSION)
    project.sessions[input.sessionID] = {
      ...input,
      traces,
      lookup: buildLookup(traces),
    }

    const keep = Object.values(project.sessions)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_INDEX_SESSIONS)
    project.sessions = Object.fromEntries(keep.map((item) => [item.sessionID, item]))
  }

  async save() {
    await this.load()
    const task = async () => {
      const dir = path.dirname(this.file)
      await mkdir(dir, { recursive: true })
      const tmp = this.file + ".tmp-" + process.pid + "-" + Date.now()
      const text = JSON.stringify(this.data)
      await writeFile(tmp, text, "utf8")
      await rename(tmp, this.file)
    }
    this.writeChain = this.writeChain.then(task, task)
    return this.writeChain
  }

  async reset() {
    this.data = empty()
    this.loaded = true
    await rm(this.file, { force: true }).catch(() => undefined)
  }
}
