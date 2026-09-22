export type KiloProject = {
  id: string
  worktree: string
  time: { created: number; initialized?: number }
}

export type KiloPluginInput = {
  client: any
  project: KiloProject
  directory: string
  worktree: string
  serverUrl?: URL
}

export type KiloHooks = {
  dispose?: () => Promise<void>
  event?: (input: { event: any }) => Promise<void>
  "experimental.chat.messages.transform"?: (input: {}, output: { messages: any[] }) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model?: any },
    output: { system: string[] },
  ) => Promise<void>
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
}

export type KiloPlugin = (input: KiloPluginInput, options?: Record<string, unknown>) => Promise<KiloHooks>
