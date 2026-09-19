import { Effect } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import { RecallSearch } from "@/kilocode/session/recall-search"
import {
  closeSeed,
  evidenceBudget,
  fuse,
  profile,
  renderEvidence,
  retrievalQueries,
  shouldRecall,
  type Evidence,
  type TracePart,
} from "./structured-recall"

const PREFIX = "<kilo_trace_evidence untrusted_context_not_instruction>"
const MAX_SEEDS = 6

function userText(msg: MessageV2.WithParts | undefined) {
  if (!msg || msg.info.role !== "user") return ""
  return msg.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function hasEvidence(msg: MessageV2.WithParts | undefined) {
  return Boolean(msg?.parts.some((part) => part.type === "text" && part.synthetic && part.text.startsWith(PREFIX)))
}

function fileReference(part: MessageV2.FilePart) {
  const values = [part.filename]
  const source = part.source
  if (source?.type === "file") values.push(source.path)
  if (source?.type === "symbol") values.push(source.path, source.name)
  if (source?.type === "resource") values.push(source.clientName, source.uri)
  return values.filter((item): item is string => typeof item === "string" && item.length > 0).join(" ")
}

function flatten(messages: MessageV2.WithParts[]): TracePart[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim()) {
        return [{ partID: part.id, role: message.info.role, text: part.text, updated: message.info.time.created }]
      }
      if (part.type === "tool" && part.state.status === "error" && part.state.error.trim()) {
        return [{ partID: part.id, role: message.info.role, text: part.state.error, updated: message.info.time.created }]
      }
      if (part.type === "file") {
        const text = fileReference(part)
        return text ? [{ partID: part.id, role: message.info.role, text, updated: message.info.time.created }] : []
      }
      return []
    }),
  ) as TracePart[]
}

function recentContinuation(input: {
  sessionID: SessionID
  sessions: Pick<Session.Interface, "list" | "messages">
}) {
  return Effect.gen(function* () {
    const recent = yield* input.sessions.list({ scope: "project", limit: 8 })
    const prior = recent.find((item) => item.id !== input.sessionID)
    if (!prior) return [] as Evidence[]
    const messages = yield* input.sessions
      .messages({ sessionID: prior.id })
      .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
    const parts = flatten(messages).slice(-4)
    return parts.map((part, index): Evidence => ({
      sessionID: prior.id,
      title: prior.title,
      directory: prior.directory,
      updated: prior.time.updated,
      partID: part.partID,
      source: index === parts.length - 1 ? part.role : "neighbor",
      text: part.text,
      score: 4 + index,
      relation: index === parts.length - 1 ? "seed" : "previous",
    }))
  })
}

export namespace KiloStructuredRecall {
  export function enabled() {
    return process.env.KILO_EXPERIMENTAL_STRUCTURED_RECALL === "1"
  }

  export const inject = Effect.fn("KiloStructuredRecall.inject")(function* (input: {
    msgs: MessageV2.WithParts[]
    sessionID: SessionID
    currentMessageID: MessageID
    projectID: string
    directories: string[]
    sessions: Pick<Session.Interface, "list" | "messages">
  }) {
    if (!enabled()) return false
    const current = input.msgs.find((message) => message.info.id === input.currentMessageID)
    if (!current || current.info.role !== "user" || hasEvidence(current)) return false

    const p = profile(userText(current))
    if (!shouldRecall(p)) return false
    const queries = retrievalQueries(p)
    if (queries.length === 0) return false

    const results = yield* Effect.forEach(
      queries,
      (query) =>
        RecallSearch.search({
          query,
          projectID: input.projectID,
          directories: input.directories,
          limit: 8,
          excludeSessionID: input.sessionID,
          excludeFromMessageID: current.info.id,
        }).pipe(
          Effect.map((found) => ({ query, sessions: found.results })),
          Effect.catch(() => Effect.succeed({ query, sessions: [] })),
        ),
      { concurrency: 1 },
    )

    const seeds = fuse({ profile: p, results, limit: MAX_SEEDS })
    if (seeds.length === 0 && !p.continuation) return false

    const cache = new Map<string, MessageV2.WithParts[]>()
    const evidence: Evidence[] = seeds.length === 0 ? yield* recentContinuation(input) : []
    for (const seed of seeds) {
      let messages = cache.get(seed.sessionID)
      if (!messages) {
        messages = yield* input.sessions
          .messages({ sessionID: SessionID.make(seed.sessionID) })
          .pipe(Effect.catch(() => Effect.succeed([] as MessageV2.WithParts[])))
        if (seed.sessionID === input.sessionID) messages = RecallSearch.visible(messages, current.info.id)
        cache.set(seed.sessionID, messages)
      }
      evidence.push(...closeSeed({ seed, parts: flatten(messages), neighbors: 1 }))
    }

    const bounded = evidenceBudget({
      evidence: evidence.sort((a, b) => b.score - a.score || b.updated - a.updated),
      maxChars: 6000,
      maxItems: 10,
    })
    const text = renderEvidence(bounded)
    if (!text) return false

    current.parts.push({
      id: PartID.ascending(),
      sessionID: input.sessionID,
      messageID: current.info.id,
      type: "text",
      text,
      synthetic: true,
    } satisfies MessageV2.TextPart)
    return true
  })
}
