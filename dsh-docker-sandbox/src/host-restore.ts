/**
 * Sandbox integration watchdog.
 *
 * Two jobs, both about surviving enable/disable of `docker-sandbox`:
 *
 * 1. **Host-provider restore.** The bundle patch withdraws `pwsh-sandbox`,
 *    `subprocess`, and `fs-sandbox` unconditionally, so a persisted disable
 *    of `docker-sandbox` — the `- id: docker-sandbox` / `disabled: true` row
 *    the plugin manager writes into the profile's `cordis.patch.yml` — would
 *    otherwise leave every tool waiting on providers nobody offers. A `!!js`
 *    guard on those rows cannot work: the loader evaluates `disabled` when
 *    each entry is created, entries are created in list order, and bundle
 *    inserts append, so the host rows are evaluated long before the
 *    `docker-sandbox` row exists. This entry is mounted after them instead: at
 *    boot it re-enables the withdrawn rows when the sandbox entry is
 *    disabled, and while the sandbox is mounted it watches for the sandbox
 *    fiber unloading under a disabled entry (a live toggle off) and restores
 *    the host providers without a restart.
 *
 * 2. **File-upload resolver shim.** Live re-composition (any toggle that
 *    churns `fs` / `shell` / `subprocess`) re-applies `session-controller`
 *    before the previous fiber's effect disposer has run, and the shipped
 *    `registerAgentResolver` guard turns that benign race into a fatal apply
 *    error — `"file-upload: Agent resolver is already registered"` — which
 *    takes `session-controller`, `ui-deliverables`, `schedule`, and
 *    `session/create` down with it (0.2.0-rc.2). The shim makes
 *    re-registration replace the stale resolver instead of throwing; the old
 *    fiber's disposer then no-ops. Delete this once upstream makes the
 *    registration idempotent.
 *
 * @module dsh-docker-sandbox/host-restore
 */

import type { Context } from "@deepseek-ai/cordis"

/** The loader entry shape this watchdog touches. */
interface LoaderEntry {
  options: { id?: string }
  readonly disabled: boolean
  update(options: { disabled?: boolean }): Promise<unknown>
}

/** The fiber shape the `internal/plugin` event carries. */
interface Fiber {
  entry?: { options?: { id?: string } }
  uid?: unknown
}

/** The slice of the file-upload service the shim touches. */
interface AgentRegistrar {
  agentResolver?: unknown
  registerAgentResolver?: (resolve: unknown) => () => void
}

/** The host providers the bundle patch withdraws alongside the sandbox. */
const WITHDRAWN = ["pwsh-sandbox", "subprocess", "fs-sandbox"]

/** Marker so the shim installs itself exactly once per prototype. */
const SHIMMED = Symbol.for("dsh-docker-sandbox.fileUploads-resolver-shim")

/** Make one file-upload instance's resolver registration replace, not throw. */
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
  // Cover the file-upload service however it arrives: already mounted now,
  // or provided (or re-provided) later.
  shimFileUploads(ctx.get("fileUploads"))
  ctx.on("internal/service", (service: unknown, impl: unknown) => {
    if (service === "fileUploads") shimFileUploads(impl)
  })

  const find = (id: string) => [...ctx.loader.entries()].find((entry) => entry.options.id === id)
  const restoreHostProviders = () => {
    for (const id of WITHDRAWN) {
      const entry = find(id)
      if (entry?.disabled) void entry.update({ disabled: false })
    }
  }

  const sandbox = find("docker-sandbox")
  if (sandbox !== undefined && !sandbox.disabled) {
    // Mounted at boot. If its fiber later unloads while its entry is
    // disabled — a live toggle off, not an app shutdown or a config restart
    // — put the host providers back so tools keep working without a restart.
    ctx.on("internal/plugin", (fiber: Fiber) => {
      if (fiber.uid || fiber.entry?.options?.id !== "docker-sandbox") return
      if (find("docker-sandbox")?.disabled) restoreHostProviders()
    })
    return
  }
  restoreHostProviders()
}
