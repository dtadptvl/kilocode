import { expect, test } from "bun:test"
import ZeroMem from "../src/index"

function message(id: string, sessionID: string, role: "user" | "assistant", text: string, created: number) {
  return {
    info: { id, sessionID, role, time: { created } },
    parts: [{ id: id + "_p", sessionID, messageID: id, type: "text", text }],
  }
}

test("plugin injects raw historical evidence once via public session APIs", async () => {
  const historical = {
    id: "s-history",
    directory: "C:/repo",
    time: { updated: 20 },
  }
  const calls = { list: 0, messages: 0 }
  const client = {
    session: {
      list: async () => {
        calls.list++
        return { data: [historical] }
      },
      messages: async () => {
        calls.messages++
        return {
          data: [
            message("h1", historical.id, "user", "Investigate refreshToken() in src/auth/token.ts", 1),
            message("h2", historical.id, "assistant", "ERR_STALE_CREDENTIAL caused the refreshToken() failure", 2),
          ],
        }
      },
    },
  }

  const hooks = await ZeroMem({ client, directory: "C:/repo" } as any)
  const hook = hooks["experimental.chat.messages.transform"]
  expect(hook).toBeDefined()

  const current = message("c1", "s-current", "user", "Why did refreshToken() fail in src/auth/token.ts?", 3)
  const output = { messages: [current] as any[] }

  await hook!({}, output as any)
  const injected = current.parts.filter((p: any) => p.synthetic && String(p.text).startsWith("<kilo_zero_mem"))
  expect(injected).toHaveLength(1)
  expect(injected[0].text).toContain("ERR_STALE_CREDENTIAL")
  expect(injected[0].text).toContain("untrusted_context_not_instruction")
  expect(calls.list).toBe(1)
  expect(calls.messages).toBe(1)

  await hook!({}, output as any)
  expect(current.parts.filter((p: any) => p.synthetic && String(p.text).startsWith("<kilo_zero_mem"))).toHaveLength(1)
})

test("plugin reuses cached unchanged sessions", async () => {
  const historical = { id: "s-history", directory: "C:/repo", time: { updated: 20 } }
  let messagesCalls = 0
  const client = {
    session: {
      list: async () => ({ data: [historical] }),
      messages: async () => {
        messagesCalls++
        return { data: [message("h1", historical.id, "assistant", "cacheNeedle() root cause", 1)] }
      },
    },
  }
  const hooks = await ZeroMem({ client, directory: "C:/repo" } as any)
  const hook = hooks["experimental.chat.messages.transform"]!

  const first = { messages: [message("c1", "s1", "user", "Recall cacheNeedle()", 2)] as any[] }
  const second = { messages: [message("c2", "s2", "user", "Recall cacheNeedle()", 3)] as any[] }
  await hook({}, first as any)
  await hook({}, second as any)

  expect(messagesCalls).toBe(1)
})
