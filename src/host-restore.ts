import type { Context } from "@deepseek-ai/cordis"

interface LoaderEntry {
  options: { id?: string }
  readonly disabled: boolean
  update(options: { disabled?: boolean }): Promise<unknown>
}

interface Fiber {
  entry?: { options?: { id?: string } }
  uid?: unknown
}

interface AgentRegistrar {
  agentResolver?: unknown
  registerAgentResolver?: (resolve: unknown) => () => void
}

const WITHDRAWN = ["pwsh-sandbox", "subprocess", "fs-sandbox"]

const SHIMMED = Symbol.for("dsh-docker-sandbox.fileUploads-resolver-shim")

function shimFileUploads(candidate: unknown): void {
  if (typeof candidate !== "object" || candidate === null) return
  const proto = Object.getPrototypeOf(candidate) as AgentRegistrar | null
  if (proto === null || typeof proto.registerAgentResolver !== "function") return
  if ((proto as Record<symbol, unknown>)[SHIMMED] === true) return
  const original = proto.registerAgentResolver
  Object.defineProperty(proto, SHIMMED, { value: true })
  proto.registerAgentResolver = function (this: AgentRegistrar, resolve: unknown) {
    this.agentResolver = void 0
    return original.call(this, resolve)
  }
}

export const name = "docker-sandbox-host-restore"

export const inject = ["loader"]

export function apply(ctx: Context & { loader: { entries(): Iterable<LoaderEntry> } }): void {
  shimFileUploads(ctx.get("fileUploads"))
  ctx.on("internal/service", (service: unknown, impl: unknown) => {
    if (service === "fileUploads") shimFileUploads(impl)
  })

  const findEntry = (id: string) => [...ctx.loader.entries()].find((entry) => entry.options.id === id)
  const restoreHostProviders = () => {
    for (const id of WITHDRAWN) {
      const entry = findEntry(id)
      if (entry?.disabled) void entry.update({ disabled: false })
    }
  }

  const sandboxEntry = findEntry("docker-sandbox")
  if (sandboxEntry !== undefined && !sandboxEntry.disabled) {
    ctx.on("internal/plugin", (fiber: Fiber) => {
      if (fiber.uid || fiber.entry?.options?.id !== "docker-sandbox") return
      if (findEntry("docker-sandbox")?.disabled) restoreHostProviders()
    })
    return
  }
  restoreHostProviders()
}
