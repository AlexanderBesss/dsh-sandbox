import { mkdirSync } from "node:fs"
import { raceAbort } from "../utils/abort-race.ts"
import { BootstrapLogger, installPlaywright, installRipgrep, probeBootstrap, uploadRunnerScript } from "./bootstrap.ts"
import type { SandboxConfig } from "../config.ts"
import { inspectContainerState, listOwnedContainers, phaseOfState, type ContainerInspect, type OwnedContainer } from "./provisioner/inspect.ts"
import { buildRunArgs } from "./provisioner/run-args.ts"
import type { PathMapper } from "./paths.ts"
import { containerNameFor, CONTAINER_PREFIX, DEFAULT_SESSION_ID, SandboxSessionError, type SandboxTarget } from "./session.ts"
import { DockerTransport, failureDetail, isMissingContainerError, SandboxUnavailableError, type SandboxFailureCode } from "./transport.ts"
import type { WorktreeInfo } from "./worktrees.ts"

export interface SandboxStatus {
  container: string
  image: string
  phase: string
  ready: boolean
  workspace: string
  containerWorkspace: string
  createdAt?: string
  lastUsedAt: number
  error?: string
  worktree?: WorktreeInfo
  worktreeError?: string
}

export interface ProvisionerHooks {
  isSessionLive?(sessionId: string): boolean
  isSessionArchived?(sessionId: string): boolean
  onContainerReady?(target: SandboxTarget): void
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
    return buildRunArgs(this.config, this.paths, target)
  }

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

    const run = this.provision(target)
    this.inflight.set(target.sessionId, run)
    const settle = (): void => {
      if (this.inflight.get(target.sessionId) === run) this.inflight.delete(target.sessionId)
    }
    run.then(settle, settle)
    return await this.awaitProvisioning(run, target, opts.signal)
  }

  private awaitProvisioning(
    run: Promise<SandboxTarget>,
    target: SandboxTarget,
    signal?: AbortSignal,
  ): Promise<SandboxTarget> {
    if (signal === undefined) return run
    if (signal.aborted) return Promise.reject(cancelled(target))
    return raceAbort(run, signal, () => {
      throw cancelled(target)
    })
  }

  private async provision(target: SandboxTarget): Promise<SandboxTarget> {
    const existing = await inspectContainerState(this.transport, target.container)

    if (existing.state !== undefined && existing.owned !== true) {
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

    if (this.config.npmCacheHost !== "") {
      try {
        mkdirSync(this.config.npmCacheHost, { recursive: true })
      } catch {
      }
    }

    try {
      await this.transport.docker(this.runArgs(target), { timeoutMs: this.config.provisionTimeoutMs })
    } catch (error) {
      const code: SandboxFailureCode =
        error instanceof SandboxUnavailableError && error.code === "NAME_CONFLICT" ? "NAME_CONFLICT" : "DOCKER_UNREACHABLE"
      this.failCreate(
        target,
        error,
        `the sandbox container "${target.container}" could not be created (is the Docker daemon running?)`,
        code,
      )
    }
    try {
      await this.waitRunning(target)
    } catch (error) {
      this.failCreate(
        target,
        error,
        `the sandbox container "${target.container}" did not reach Running within ${this.config.provisionTimeoutMs} ms`,
        "DOCKER_UNREACHABLE",
      )
    }
    await this.bootstrap(target)
    return target
  }

  private failCreate(target: SandboxTarget, error: unknown, prefix: string, code: SandboxFailureCode): never {
    const detail = failureDetail(error)
    this.errors.set(target.sessionId, detail)
    throw new SandboxUnavailableError(`${prefix}: ${detail}`, code, detail)
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

  async stateOf(target: SandboxTarget): Promise<string | undefined> {
    return (await inspectContainerState(this.transport, target.container)).state
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

  touch(sessionId: string): void {
    const entry = this.tracked.get(sessionId)
    if (entry !== undefined) entry.lastUsedAt = Date.now()
  }

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

    if (this.config.bootstrapPlaywright === true && facts.playwrightMissing) {
      await installPlaywright(
        this.transport,
        target,
        this.config.playwrightBrowsers,
        this.config.playwrightVersion,
        this.config.playwrightInstallTimeoutMs,
        this.logger,
      )
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

  async listOwned(): Promise<OwnedContainer[]> {
    return await listOwnedContainers(this.transport)
  }

  private async ownedContainers(): Promise<OwnedContainer[]> {
    return await this.listOwned().catch(() => [])
  }

  async release(target: SandboxTarget): Promise<void> {
    this.tracked.delete(target.sessionId)
    this.errors.delete(target.sessionId)
    await this.remove(target)
  }

  async releaseSession(sessionId: string): Promise<void> {
    this.tracked.delete(sessionId)
    this.errors.delete(sessionId)
    await this.remove({ container: containerNameFor(sessionId) })
  }

  async releaseArchived(archived: ReadonlySet<string>): Promise<string[]> {
    if (archived.size === 0) return []
    const deleted: string[] = []
    for (const sessionId of [...this.tracked.keys()]) {
      if (!archived.has(sessionId)) continue
      await this.releaseSession(sessionId)
      deleted.push(containerNameFor(sessionId))
    }
    const owned = await this.ownedContainers()
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
    const owned = await this.ownedContainers()
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

    const owned = await this.ownedContainers()
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
