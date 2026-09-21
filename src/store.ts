import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { MAX_INDEX_SESSIONS, MAX_TRACES_PER_SESSION, type Trace } from "./core.js"

const VERSION = 1

export type IndexedSession = {
  projectID: string
  sessionID: string
  directory: string
  updated: number
  fingerprint: string
  traces: Trace[]
}

type ProjectIndex = {
  sessions: Record<string, IndexedSession>
}

type IndexFile = {
  version: 1
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

  traces(projectID: string) {
    const sessions = Object.values(this.data.projects[projectID]?.sessions ?? {})
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_INDEX_SESSIONS)
    return sessions.flatMap((session) => session.traces)
  }

  sessions(projectID: string) {
    return Object.values(this.data.projects[projectID]?.sessions ?? {})
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_INDEX_SESSIONS)
  }

  upsert(session: IndexedSession) {
    const project = this.project(session.projectID)
    project.sessions[session.sessionID] = {
      ...session,
      traces: session.traces.slice(-MAX_TRACES_PER_SESSION),
    }

    const keep = Object.values(project.sessions)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, MAX_INDEX_SESSIONS)
    project.sessions = Object.fromEntries(keep.map((item) => [item.sessionID, item]))
  }

  removeUnknown(projectID: string, knownSessionIDs: Set<string>) {
    const project = this.data.projects[projectID]
    if (!project) return
    for (const sessionID of Object.keys(project.sessions)) {
      if (!knownSessionIDs.has(sessionID)) delete project.sessions[sessionID]
    }
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
