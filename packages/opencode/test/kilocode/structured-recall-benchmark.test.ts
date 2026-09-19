import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { expect } from "bun:test"
import { Effect } from "effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { RecallSearch } from "../../src/kilocode/session/recall-search"
import {
  closeSeed,
  fuse,
  profile,
  retrievalQueries,
  type Evidence,
  type TracePart,
} from "../../src/kilocode/session/structured-recall"
import { Instance } from "../../src/kilocode/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { seedProject } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

type Stored<T> = T extends unknown ? Omit<T, "id" | "sessionID" | "messageID"> : never

const it = testEffect(LayerNode.compile(LayerNode.group([Session.node, SessionProjector.node, Database.node])))

const add = Effect.fn("StructuredRecallBenchmark.add")(function* (
  sessionID: SessionID,
  role: "user" | "assistant",
  text: string,
  opts?: { parentID?: MessageID },
) {
  const messageID = MessageID.ascending()
  const message: Stored<MessageV2.Info> =
    role === "user"
      ? {
          role,
          time: { created: Date.now() },
          agent: "code",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        }
      : {
          role,
          time: { created: Date.now(), completed: Date.now() },
          parentID: opts?.parentID ?? MessageID.ascending(),
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          mode: "code",
          agent: "code",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
  const partID = PartID.ascending()
  const sessions = yield* Session.Service
  yield* sessions.updateMessage({ id: messageID, sessionID, ...message } as MessageV2.Info)
  yield* sessions.updatePart({
    id: partID,
    messageID,
    sessionID,
    type: "text",
    text,
  } satisfies MessageV2.TextPart)
  return { messageID, partID }
})

function coverage(found: Iterable<string>, expected: Set<string>) {
  const seen = new Set(found)
  let hits = 0
  for (const id of expected) if (seen.has(id)) hits++
  return expected.size === 0 ? 1 : hits / expected.size
}

function trace(messages: MessageV2.WithParts[]): TracePart[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "text" && !part.synthetic && !part.ignored
        ? [{ partID: part.id, role: message.info.role, text: part.text, updated: message.info.time.created }]
        : [],
    ),
  ) as TracePart[]
}

it.instance(
  "A/B: multi-query fusion plus temporal closure improves source-part coverage over flat recall",
  () =>
    Effect.gen(function* () {
      yield* seedProject
      const sessions = yield* Session.Service
      const history = yield* sessions.create({ title: "Auth retry investigation" })

      const p1 = yield* add(history.id, "user", "Failure happens in src/auth/token.ts during the refresh flow")
      const p2 = yield* add(
        history.id,
        "assistant",
        "refreshToken() retries credentials after an expired session",
        { parentID: p1.messageID },
      )
      const p3 = yield* add(
        history.id,
        "assistant",
        "ERR_STALE_CREDENTIAL is the root cause; the cached credential must be invalidated before retry",
        { parentID: p1.messageID },
      )

      const query = "Why did refreshToken() fail in src/auth/token.ts?"
      const expected = new Set([p1.partID, p2.partID, p3.partID])

      const baseline = yield* RecallSearch.search({
        query,
        projectID: String(Instance.project.id),
        directories: [Instance.worktree],
        limit: 8,
      })
      const baselineIDs = baseline.results.flatMap((session) => session.matches.map((match) => match.partID))

      const p = profile(query)
      const batches = yield* Effect.forEach(
        retrievalQueries(p),
        (subquery) =>
          RecallSearch.search({
            query: subquery,
            projectID: String(Instance.project.id),
            directories: [Instance.worktree],
            limit: 8,
          }).pipe(Effect.map((result) => ({ query: subquery, sessions: result.results }))),
        { concurrency: 1 },
      )
      const seeds = fuse({ profile: p, results: batches, limit: 6 })
      const messages = yield* sessions.messages({ sessionID: history.id })
      const parts = trace(messages)
      const evidence: Evidence[] = seeds.flatMap((seed) =>
        seed.sessionID === history.id ? closeSeed({ seed, parts, neighbors: 1 }) : [],
      )
      const structuredIDs = evidence.map((item) => item.partID)

      const baselineCoverage = coverage(baselineIDs, expected)
      const structuredCoverage = coverage(structuredIDs, expected)

      expect(structuredCoverage).toBeGreaterThanOrEqual(baselineCoverage)
      expect(structuredCoverage).toBe(1)
      const structuredSet = new Set(structuredIDs)
      expect(structuredSet.has(p1.partID)).toBe(true)
      expect(structuredSet.has(p2.partID)).toBe(true)
      expect(structuredSet.has(p3.partID)).toBe(true)

      console.log(
        JSON.stringify({
          benchmark: "auth-retry-source-coverage",
          baseline: { coverage: baselineCoverage, parts: [...new Set(baselineIDs)].length },
          structured: {
            coverage: structuredCoverage,
            parts: [...new Set(structuredIDs)].length,
            queries: retrievalQueries(p).length,
          },
        }),
      )
    }),
  { git: true },
)
