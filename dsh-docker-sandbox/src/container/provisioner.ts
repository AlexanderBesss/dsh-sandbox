// ownership is the dsh.sandbox=1 + dsh.session labels — the GC loop and status route filter on them
// Docker Desktop shares host drives into its VM natively, so the workspace bind mount is the same bytes the host sees

import { mkdirSync } from "node:fs"
import { BootstrapLogger, installRipgrep, probeBootstrap, uploadRunnerScript } from "./bootstrap.ts"
import type { SandboxConfig } from "../config.ts"
import { PathMapper, type SandboxMount } from "./paths.ts"
import { containerNameFor, COMPOSE_PROJECT_LABEL, CONTAINER_PREFIX, composeProjectFor, DEFAULT_SESSION_ID, OWNERSHIP_LABEL, SESSION_LABEL, SandboxSessionError, type SandboxTarget } from "./session.ts"
import { DockerTransport, failureDetail, isMissingContainerError, SandboxUnavailableError } from "./transport.ts"
import type { WorktreeInfo } from "./worktrees.ts"

export interface SandboxStatus {
  container: string
  image: string
  phase: string
  ready: boolean
  // Windows path of the bind-mounted workspace
  workspace: string
  containerWorkspace: string
  createdAt?: string
  lastUsedAt: number
  error?: string
  worktree?: WorktreeInfo
  worktreeError?: string
}

interface ContainerInspect {
  Name?: string
  Created?: string
  State?: { Status?: string; StartedAt?: string }
  Config?: { Image?: string; Labels?: Record<string, string> }
}

export interface ProvisionerHooks {
  // reclaiming a live chat's container pulls the box out from under the user; true after a plugin reload cleared bookkeeping
  isSessionLive?(sessionId: string): boolean
  // a stale caller (header outliving the chat, a replay) must not raise a container for an archived chat
  isSessionArchived?(sessionId: string): boolean
  // fires once per container per process, fire-and-forget, never awaited
  onContainerReady?(target: SandboxTarget): void
}

function volumeArg(mount: SandboxMount): string {
  // Docker on Windows accepts forward slashes in the host part; argv never passes a shell, so spaces survive
  return `${mount.hostPath.replace(/\\/g, "/")}:${mount.containerPath}`
}

function phaseOfState(state: string): string {
  if (state === "") return "unknown"
  return state[0]!.toUpperCase() + state.slice(1)
}

function sessionFromName(name: string): string {
  return name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : name
}

function cancelled(target: SandboxTarget): SandboxUnavailableError {
  return new SandboxUnavailableError(`provisioning ${target.container} was cancelled`, "EXEC_FAILED")
}

export class Provisioner {
  private readonly tracked = new Map<string, { target: SandboxTarget; lastUsedAt: number; bootstrapped: boolean }>()
  private readonly inflight = new Map<string, Promise<SandboxTarget>>()
  private readonly errors = new Map<string, string>()
  private engineProbe: { at: number; reachable: boolean; error?: string } | undefined
  private readonly activeWork = new Map<string, number>()

  constructor(
    private readonly transport: DockerTransport,
    private readonly config: SandboxConfig,
    private readonly paths: PathMapper,
    private readonly logger?: BootstrapLogger,
    private readonly hooks: ProvisionerHooks = {},
  ) {}

  runArgs(target: SandboxTarget): string[] {
    const mounts = this.paths.mountsFor(target.workspace)
    const args: string[] = [
      "run",
      "-d",
      "--name",
      target.container,
      "--label",
      OWNERSHIP_LABEL,
      "--label",
      `${SESSION_LABEL}=${target.sessionId}`,
      "--label",
      `${COMPOSE_PROJECT_LABEL}=${composeProjectFor(target.workspace)}`,
      ...mounts.flatMap((mount) => ["-v", volumeArg(mount)]),
      "-w",
      this.paths.containerRoot(target.workspace),
    ]

    // the npm cache is platform-neutral tarballs, safe to share; a container's own cache dies with its writable layer
    if (this.config.npmCacheHost !== "") {
      args.push("-v", volumeArg({ hostPath: this.config.npmCacheHost, containerPath: "/root/.npm" }))
    }

    // the .git file holds a Windows path the container can't resolve; GIT_DIR/GIT_WORK_TREE pin git to the mounted gitdir
    const extra = this.paths.extraMountFor(target.workspace)
    if (extra !== undefined) {
      args.push(
        "-e",
        `GIT_DIR=${extra.containerGitDir}`,
        "-e",
        `GIT_WORK_TREE=${this.paths.containerRoot(target.workspace)}`,
      )
      // Git for Windows keeps autocrlf/identity in a config the container can't see; without them, phantom CRLF diffs
      const mirrored = Object.entries(extra.gitConfig)
      if (mirrored.length > 0) {
        args.push("-e", `GIT_CONFIG_COUNT=${mirrored.length}`)
        mirrored.forEach(([key, value], index) => {
          args.push("-e", `GIT_CONFIG_KEY_${index}=${key}`, "-e", `GIT_CONFIG_VALUE_${index}=${value}`)
        })
      }
    }

    const limits = this.config.resourceLimits
    const cpu = limits?.cpu.get()
    const memory = limits?.memory.get()
    const memorySwap = limits?.memorySwap.get()
    if (cpu) args.push("--cpus", cpu)
    if (memory) args.push("--memory", memory)
    if (memorySwap) args.push("--memory-swap", memorySwap)

    args.push(this.config.image.get(), ...this.config.command)
    return args
  }

  // the agentless container belongs to no chat, so it is exempt; an unwired hook never blocks
  private assertProvisionable(sessionId: string): void {
    if (sessionId === DEFAULT_SESSION_ID) return
    if (this.hooks.isSessionArchived?.(sessionId) === true) {
      throw new SandboxSessionError("this conversation is archived, so it has no sandbox container", "SESSION_ARCHIVED")
    }
    if (this.hooks.isSessionLive?.(sessionId) === false) {
      throw new SandboxSessionError("this conversation no longer exists, so it has no sandbox container", "SESSION_GONE")
    }
  }

  async ensure(target: SandboxTarget, opts: { signal?: AbortSignal } = {}): Promise<SandboxTarget> {
    this.assertProvisionable(target.sessionId)
    const entry = this.tracked.get(target.sessionId)
    if (entry) entry.lastUsedAt = Date.now()
    else this.tracked.set(target.sessionId, { target, lastUsedAt: Date.now(), bootstrapped: false })

    const running = this.inflight.get(target.sessionId)
    if (running !== undefined) return await this.awaitProvisioning(running, target, opts.signal)
    // the in-flight run uses the first caller's target: a later caller's differing workspace loses this round

    const run = this.provision(target)
    this.inflight.set(target.sessionId, run)
    // the run settles on its own result: a caller who stops waiting must not let a second docker run start for the same name
    const settle = (): void => {
      if (this.inflight.get(target.sessionId) === run) this.inflight.delete(target.sessionId)
    }
    run.then(settle, settle)
    return await this.awaitProvisioning(run, target, opts.signal)
  }

  // cancellation stops only this caller: the run is shared by the chat, and one caller cancelling must not fail the others
  private awaitProvisioning(
    run: Promise<SandboxTarget>,
    target: SandboxTarget,
    signal?: AbortSignal,
  ): Promise<SandboxTarget> {
    if (signal === undefined) return run
    if (signal.aborted) return Promise.reject(cancelled(target))
    return new Promise<SandboxTarget>((resolve, reject) => {
      const abort = (): void => reject(cancelled(target))
      signal.addEventListener("abort", abort, { once: true })
      run.then(
        (value) => {
          signal.removeEventListener("abort", abort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        },
      )
    })
  }

  private async provision(target: SandboxTarget): Promise<SandboxTarget> {
    const existing = await this.inspectState(target)

    if (existing.state !== undefined && existing.owned !== true) {
      // adopting it would run this chat in someone else's container; recreating it would delete their work
      const detail = `the container name "${target.container}" is already used by a container this plugin does not own`
      this.errors.set(target.sessionId, detail)
      throw new SandboxUnavailableError(
        `${detail}; rename that container, or free the name with \`docker rm\` if it is stale`,
        "NAME_CONFLICT",
        detail,
      )
    }

    if (existing.state === "running") {
      await this.bootstrap(target)
      return target
    }
    if (existing.state !== undefined) {
      await this.remove(target)
    }

    // docker creates a missing -v source itself, but as a VM-side path; mkdir keeps it a real host directory
    if (this.config.npmCacheHost !== "") {
      try {
        mkdirSync(this.config.npmCacheHost, { recursive: true })
      } catch {
        // the cache is an optimization, not a correctness requirement: docker run still answers without it
      }
    }

    try {
      await this.transport.docker(this.runArgs(target), { timeoutMs: this.config.provisionTimeoutMs })
    } catch (error) {
      const detail = failureDetail(error)
      this.errors.set(target.sessionId, detail)
      throw new SandboxUnavailableError(
        `the sandbox container "${target.container}" could not be created (is the Docker daemon running?): ${detail}`,
        error instanceof SandboxUnavailableError && error.code === "NAME_CONFLICT" ? "NAME_CONFLICT" : "DOCKER_UNREACHABLE",
        detail,
      )
    }
    try {
      await this.waitRunning(target)
    } catch (error) {
      const detail = failureDetail(error)
      this.errors.set(target.sessionId, detail)
      throw new SandboxUnavailableError(
        `the sandbox container "${target.container}" did not reach Running within ${this.config.provisionTimeoutMs} ms: ${detail}`,
        "DOCKER_UNREACHABLE",
        detail,
      )
    }
    await this.bootstrap(target)
    return target
  }

  private async waitRunning(target: SandboxTarget): Promise<void> {
    const deadline = Date.now() + this.config.provisionTimeoutMs
    while (Date.now() < deadline) {
      const state = await this.stateOf(target)
      if (state === "running") return
      if (state === undefined) throw new SandboxUnavailableError(`container "${target.container}" vanished after creation`, "EXEC_FAILED")
      if (state === "exited" || state === "dead") {
        throw new SandboxUnavailableError(`container "${target.container}" exited immediately (state: ${state})`, "EXEC_FAILED")
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new SandboxUnavailableError(`timed out waiting for "${target.container}" to be Running`, "EXEC_TIMEOUT")
  }

  private async inspectState(target: SandboxTarget): Promise<{ state?: string; owned?: boolean }> {
    try {
      // reading the rendered label map keeps the format string quote-free: Windows argv quoting would not survive quotes
      const result = await this.transport.docker(
        ["inspect", "--format", "{{.State.Status}}|{{.Config.Labels}}", target.container],
        { timeoutMs: 30000 },
      )
      const text = result.stdout.toString("utf8").trim()
      if (text === "") return {}
      const [state = "", labels = ""] = text.split("|")
      return { state: state === "" ? undefined : state, owned: /\bdsh\.sandbox:1\b/.test(labels) }
    } catch (error) {
      if (isMissingContainerError(error)) return {}
      throw error
    }
  }

  async stateOf(target: SandboxTarget): Promise<string | undefined> {
    return (await this.inspectState(target)).state
  }

  async engineReachable(maxAgeMs = 10000): Promise<{ reachable: boolean; error?: string }> {
    const now = Date.now()
    if (this.engineProbe !== undefined && now - this.engineProbe.at < maxAgeMs) return this.engineProbe
    try {
      await this.transport.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15000 })
      this.engineProbe = { at: now, reachable: true }
    } catch (error) {
      this.engineProbe = { at: now, reachable: false, error: failureDetail(error) }
    }
    return this.engineProbe
  }

  // idleness is measured from the last thing that happened to the container, so a long-running command can report progress
  touch(sessionId: string): void {
    const entry = this.tracked.get(sessionId)
    if (entry !== undefined) entry.lastUsedAt = Date.now()
  }

  // GC measures idleness from call start; without a lease it would reclaim a container whose command is still running
  beginWork(sessionId: string): () => void {
    this.activeWork.set(sessionId, (this.activeWork.get(sessionId) ?? 0) + 1)
    this.touch(sessionId)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.activeWork.get(sessionId) ?? 1) - 1
      if (remaining <= 0) this.activeWork.delete(sessionId)
      else this.activeWork.set(sessionId, remaining)
      this.touch(sessionId)
    }
  }

  hasActiveWork(sessionId: string): boolean {
    return this.activeWork.has(sessionId)
  }

  private async bootstrap(target: SandboxTarget): Promise<void> {
    const entry = this.tracked.get(target.sessionId)
    if (entry?.bootstrapped) return

    const facts = await probeBootstrap(this.transport, target)

    if (facts.agentsMissing) await this.uploadAgents(target)

    if (this.config.bootstrapTools === true && facts.rgMissing && this.config.ripgrepSource !== "none") {
      await installRipgrep(this.transport, target, this.config.ripgrepSource, this.logger)
    }

    if (entry) entry.bootstrapped = true
    this.hooks.onContainerReady?.(target)
  }

  async uploadAgents(target: SandboxTarget): Promise<void> {
    await uploadRunnerScript(this.transport, target)
  }

  async status(target: SandboxTarget): Promise<SandboxStatus> {
    const entry = this.tracked.get(target.sessionId)
    const base: SandboxStatus = {
      container: target.container,
      image: this.config.image.get(),
      phase: "absent",
      ready: false,
      workspace: target.workspace,
      containerWorkspace: this.paths.containerRoot(target.workspace),
      lastUsedAt: entry?.lastUsedAt ?? 0,
      error: this.errors.get(target.sessionId),
    }
    try {
      const inspected = await this.transport.dockerJson<ContainerInspect[]>(
        ["inspect", target.container],
        { timeoutMs: 30000 },
      )
      const container = inspected[0]
      const state = container?.State?.Status ?? "unknown"
      return {
        ...base,
        phase: phaseOfState(state),
        ready: state === "running",
        createdAt: container?.Created,
      }
    } catch (error) {
      if (isMissingContainerError(error)) return base
      return { ...base, phase: "unknown", error: (error as Error).message }
    }
  }

  async listOwned(): Promise<{ name: string; phase: string; createdAt?: string; sessionId?: string }[]> {
    const ids = await this.transport.docker(["ps", "-aq", "--filter", `label=${OWNERSHIP_LABEL}`], { timeoutMs: 30000 })
    const idList = ids.stdout
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
    if (idList.length === 0) return []
    const inspected = await this.transport.dockerJson<ContainerInspect[]>(["inspect", ...idList], { timeoutMs: 30000 })
    return inspected.map((container) => ({
      name: (container.Name ?? "").replace(/^\//, ""),
      phase: phaseOfState(container.State?.Status ?? ""),
      createdAt: container.Created,
      sessionId: container.Config?.Labels?.[SESSION_LABEL],
    }))
  }

  async release(target: SandboxTarget): Promise<void> {
    this.tracked.delete(target.sessionId)
    this.errors.delete(target.sessionId)
    await this.remove(target)
  }

  // app seam workspace/session-stop: the container name derives from the session id, no target lookup needed
  async releaseSession(sessionId: string): Promise<void> {
    this.tracked.delete(sessionId)
    this.errors.delete(sessionId)
    await this.remove({ container: containerNameFor(sessionId) })
  }

  // archiving emits no plugin event: the GC loop polls the archive set; older containers are covered by their labels
  async releaseArchived(archived: ReadonlySet<string>): Promise<string[]> {
    if (archived.size === 0) return []
    const deleted: string[] = []
    for (const sessionId of [...this.tracked.keys()]) {
      if (!archived.has(sessionId)) continue
      await this.releaseSession(sessionId)
      deleted.push(containerNameFor(sessionId))
    }
    const owned = await this.listOwned().catch(() => [])
    for (const container of owned) {
      if (container.sessionId === undefined || !archived.has(container.sessionId)) continue
      if (deleted.includes(container.name)) continue
      await this.remove({ container: container.name })
      deleted.push(container.name)
    }
    return deleted
  }

  private async remove(target: { container: string }): Promise<void> {
    await this.transport.docker(["rm", "-f", target.container], { timeoutMs: 60000 }).catch(() => undefined)
  }

  async releaseAll(): Promise<string[]> {
    const owned = await this.listOwned().catch(() => [])
    const deleted: string[] = []
    for (const container of owned) {
      await this.remove({ container: container.name })
      deleted.push(container.name)
    }
    this.tracked.clear()
    this.errors.clear()
    return deleted
  }

  async collectIdle(): Promise<string[]> {
    const deleted: string[] = []
    const now = Date.now()
    for (const [sessionId, entry] of [...this.tracked]) {
      if (this.activeWork.has(sessionId)) continue
      if (now - entry.lastUsedAt <= this.config.idleTtlMs.get()) continue
      await this.release(entry.target)
      deleted.push(entry.target.container)
      this.tracked.delete(sessionId)
    }

    const owned = await this.listOwned().catch(() => [])
    for (const container of owned) {
      const sessionId = container.sessionId ?? sessionFromName(container.name)
      if (this.tracked.has(sessionId) || this.activeWork.has(sessionId)) continue
      if (this.hooks.isSessionLive?.(sessionId) === true) continue
      const created = container.createdAt ? Date.parse(container.createdAt) : 0
      if (created === 0 || now - created <= this.config.idleTtlMs.get()) continue
      await this.remove({ container: container.name })
      deleted.push(container.name)
    }
    return deleted
  }
}
