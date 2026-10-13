/**
 * One container per conversation.
 *
 * The provisioner owns the container lifecycle: it creates a container on
 * first use (`docker run -d`), keeps it Running for the life of the chat, and
 * deletes containers that have gone idle. Containers are plain named
 * containers — the identity that matters is *a name a human can read in the
 * app*, the container this chat is running in — and ownership is tracked with
 * the `dsh.sandbox=1` label plus a `dsh.session` label, which is what the GC
 * loop and the status route filter on.
 *
 * The workspace is a bind mount of the Windows workspace itself: Docker
 * Desktop shares drives into its VM natively, so the mount is the same bytes
 * the host file tools see — a file written by a container command shows up in
 * Windows Explorer and a file written in an editor shows up inside the
 * container.
 *
 * @module dsh-docker-sandbox/container/provisioner
 */

import { BootstrapLogger, installRipgrep, probeBootstrap, uploadRunnerScript } from "./bootstrap.ts"
import type { SandboxConfig } from "../config.ts"
import { PathMapper, type SandboxMount } from "./paths.ts"
import { containerNameFor, COMPOSE_PROJECT_LABEL, CONTAINER_PREFIX, composeProjectFor, OWNERSHIP_LABEL, SESSION_LABEL, type SandboxTarget } from "./session.ts"
import { DockerTransport, failureDetail, isMissingContainerError, SandboxUnavailableError } from "./transport.ts"
import type { WorktreeInfo } from "./worktrees.ts"

/** What the UI and the status route need to know about one sandbox. */
export interface SandboxStatus {
  container: string
  image: string
  /** Container state as the engine reports it, or `absent` / `unknown`. */
  phase: string
  ready: boolean
  /** Windows path of the bind-mounted workspace. */
  workspace: string
  /** Container path that workspace appears at. */
  containerWorkspace: string
  /** Engine-side creation time (ISO), when the container exists. */
  createdAt?: string
  /** Epoch millis of the last call routed to this container. */
  lastUsedAt: number
  /** Last provisioning failure, kept so the UI can show why. */
  error?: string
  /** This session's git worktree, when worktree mode gave it one. */
  worktree?: WorktreeInfo
  /** Why worktree creation failed, when it did. */
  worktreeError?: string
}

/** A container as `docker inspect` reports it, narrowed to the fields used here. */
interface ContainerInspect {
  Name?: string
  Created?: string
  State?: { Status?: string; StartedAt?: string }
  Config?: { Image?: string; Labels?: Record<string, string> }
}

/** Host facts the provisioner consults before reclaiming a container. */
export interface ProvisionerHooks {
  /**
   * True when the app still holds this conversation open.
   *
   * A container the engine still carries for a live chat is not an orphan even
   * when this process never provisioned it — a plugin reload clears the
   * in-memory bookkeeping, and reclaiming then would pull the box out from
   * under a chat the user is looking at.
   */
  isSessionLive?(sessionId: string): boolean
}

/** Fold a mount into one `docker run -v` argument. */
function volumeArg(mount: SandboxMount): string {
  // Docker on Windows accepts forward slashes in the host part, and they
  // survive spaces (the argument is passed as one argv entry, never through
  // a shell).
  return `${mount.hostPath.replace(/\\/g, "/")}:${mount.containerPath}`
}

/** Map the engine's lower-case state to the phase name the UI shows. */
function phaseOfState(state: string): string {
  if (state === "") return "unknown"
  return state[0]!.toUpperCase() + state.slice(1)
}

/** The session id a sandbox container name was derived from, best effort. */
function sessionFromName(name: string): string {
  return name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : name
}

/** A cancelled wait for a container. */
function cancelled(target: SandboxTarget): SandboxUnavailableError {
  return new SandboxUnavailableError(`provisioning ${target.container} was cancelled`, "EXEC_FAILED")
}

export class Provisioner {
  /** Per-conversation bookkeeping, keyed by session id. */
  private readonly tracked = new Map<string, { target: SandboxTarget; lastUsedAt: number; bootstrapped: boolean }>()
  /** In-flight provisioning, so concurrent tool calls share one container creation. */
  private readonly inflight = new Map<string, Promise<SandboxTarget>>()
  /** Last provisioning error, surfaced to the UI. */
  private readonly errors = new Map<string, string>()
  /** Conversations with work still running; their containers are never idle. */
  private readonly activeWork = new Map<string, number>()

  constructor(
    private readonly transport: DockerTransport,
    private readonly config: SandboxConfig,
    private readonly paths: PathMapper,
    private readonly logger?: BootstrapLogger,
    private readonly hooks: ProvisionerHooks = {},
  ) {}

  /** Build the `docker run` argv for one conversation. */
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

    // A worktree session's gitdir lives in the main repo's `.git` (mounted
    // above at its drive form). `GIT_DIR`/`GIT_WORK_TREE` stop git from
    // following the worktree's `.git` file — a Windows path the container
    // cannot resolve — and pin every git call in this box to this session's
    // worktree.
    const extra = this.paths.extraMountFor(target.workspace)
    if (extra !== undefined) {
      args.push(
        "-e",
        `GIT_DIR=${extra.containerGitDir}`,
        "-e",
        `GIT_WORK_TREE=${this.paths.containerRoot(target.workspace)}`,
      )
      // Mirror the host's effective git settings (autocrlf, identity) into
      // the container: Git for Windows keeps them in a system config the
      // container cannot see, and without them container git reads a CRLF
      // checkout as phantom-modified.
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

  /**
   * Make sure the conversation's container exists and is Running.
   *
   * Idempotent and concurrent-safe: parallel tool calls in one chat share a
   * single provisioning run, and a chat whose container was deleted (engine
   * restart, manual `docker rm`) is re-provisioned on the next call.
   *
   * @param target - the conversation to provision for.
   * @param opts.signal - caller cancellation; it stops *this* caller waiting,
   *   it does not cancel the shared provisioning run (see `awaitProvisioning`).
   * @returns the same target, now backed by a Running container.
   */
  async ensure(target: SandboxTarget, opts: { signal?: AbortSignal } = {}): Promise<SandboxTarget> {
    const entry = this.tracked.get(target.sessionId)
    if (entry) entry.lastUsedAt = Date.now()
    else this.tracked.set(target.sessionId, { target, lastUsedAt: Date.now(), bootstrapped: false })

    const running = this.inflight.get(target.sessionId)
    if (running !== undefined) return await this.awaitProvisioning(running, target, opts.signal)
    // A joiner above shares the in-flight run, which was built from the *first*
    // caller's target: if a second caller's workspace differs (a session header
    // changed mid-flight), the first caller's mount wins for this round. The
    // next call after the header settles provisions against the new workspace.

    const run = this.provision(target)
    this.inflight.set(target.sessionId, run)
    // The entry outlives the caller that started it: a caller who stops waiting
    // must not leave the next one starting a second `docker run` for the same
    // name while the first is still in flight.
    const settle = (): void => {
      if (this.inflight.get(target.sessionId) === run) this.inflight.delete(target.sessionId)
    }
    run.then(settle, settle)
    return await this.awaitProvisioning(run, target, opts.signal)
  }

  /**
   * Wait for a provisioning run without owning it.
   *
   * Provisioning creates a container the whole chat shares, so one caller
   * walking away must not cancel the others: a chat with two parallel tool
   * calls would fail the second one because the user cancelled the first. A
   * cancelled caller stops waiting; the run finishes on its own, and anything
   * it created that nobody used is reclaimed by the GC sweep.
   */
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
      // The name is held by a container this plugin does not own. Adopting it
      // would run this chat's commands inside someone else's container;
      // recreating it would delete their work. Refuse and say which.
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
      // Exists but not Running: crashed entrypoint, manual stop, or an engine
      // restart that left it Exited. Recreate it fresh.
      await this.remove(target)
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

  /** Poll until the engine reports the container Running, or the budget runs out. */
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

  /**
   * Container state and whether the engine still carries our ownership label.
   *
   * The label is read in the same round trip as the state: a container that
   * merely shares our name is not ours to use.
   */
  private async inspectState(target: SandboxTarget): Promise<{ state?: string; owned?: boolean }> {
    try {
      // `{{.Config.Labels}}` renders as `map[dsh.sandbox:1 dsh.session:…]`.
      // Reading the rendered map keeps the format string free of quotes, which
      // Windows argv quoting would otherwise have to survive.
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

  /** Current container state, or undefined when the container does not exist. */
  async stateOf(target: SandboxTarget): Promise<string | undefined> {
    return (await this.inspectState(target)).state
  }

  /**
   * Refresh the idle clock for a conversation this provisioner already tracks.
   *
   * Idleness is measured from the last thing that happened to the container,
   * not from the last time someone asked for it, so a long-running command has
   * somewhere to report progress.
   */
  touch(sessionId: string): void {
    const entry = this.tracked.get(sessionId)
    if (entry !== undefined) entry.lastUsedAt = Date.now()
  }

  /**
   * Lease one unit of work against a conversation's container.
   *
   * The GC sweep measures idleness from when a call *started*, which on its own
   * would reclaim a container whose command is still running — a build, an
   * install, a dev server held open in a terminal session — once that call
   * passed `idleTtlMs`. Holding a lease keeps the container in place until the
   * work finishes, and releases the idle clock when it does.
   *
   * @param sessionId - the conversation the work belongs to.
   * @returns a function releasing the lease; calling it twice releases once.
   */
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

  /** True while a conversation has leased work running. */
  hasActiveWork(sessionId: string): boolean {
    return this.activeWork.has(sessionId)
  }

  /**
   * Make a container usable: copy the helper scripts in, and install `rg` so
   * `glob` / `grep` work. Runs once per container per process; a container
   * recreated under us is detected by the probe and re-prepared.
   */
  private async bootstrap(target: SandboxTarget): Promise<void> {
    const entry = this.tracked.get(target.sessionId)
    if (entry?.bootstrapped) return

    const facts = await probeBootstrap(this.transport, target)

    if (facts.agentsMissing) await this.uploadAgents(target)

    if (this.config.bootstrapTools === true && facts.rgMissing && this.config.ripgrepSource !== "none") {
      await installRipgrep(this.transport, target, this.config.ripgrepSource, this.logger)
    }

    if (entry) entry.bootstrapped = true
  }

  /**
   * Copy the in-container command runner to `/tmp`.
   *
   * It travels through stdin rather than the command line: a multi-line POSIX
   * shell script embedded in an argv element is exactly what Windows argument
   * quoting corrupts.
   */
  async uploadAgents(target: SandboxTarget): Promise<void> {
    await uploadRunnerScript(this.transport, target)
  }

  /** Snapshot for the UI: what container this chat has, and its state. */
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

  /** List every sandbox container this plugin owns. */
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

  /** Delete one conversation's container. */
  async release(target: SandboxTarget): Promise<void> {
    this.tracked.delete(target.sessionId)
    this.errors.delete(target.sessionId)
    await this.remove(target)
  }

  /**
   * Delete the container of one conversation, named from its session id.
   *
   * Used by the app's archive seam: when the registry stops an archived
   * conversation's work (`workspace/session-stop`), the container is this
   * plugin's part of that work, and the name is derived so no target lookup
   * is needed.
   */
  async releaseSession(sessionId: string): Promise<void> {
    this.tracked.delete(sessionId)
    this.errors.delete(sessionId)
    await this.remove({ container: containerNameFor(sessionId) })
  }

  /**
   * Release the containers of conversations the app has archived.
   *
   * Archiving an idle conversation writes only the durable archive set — no
   * event reaches plugins — so the GC loop consults the registry and deletes
   * the plugin's containers for archived ids. Containers left by an earlier
   * process are covered too: the engine still labels them with their
   * conversation. A later unarchive re-provisions lazily on the next call.
   *
   * @param archived - the registry's current archive set.
   * @returns the names deleted.
   */
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

  /** `docker rm -f`, swallowing "no such container". */
  private async remove(target: { container: string }): Promise<void> {
    await this.transport.docker(["rm", "-f", target.container], { timeoutMs: 60000 }).catch(() => undefined)
  }

  /**
   * Delete every container this plugin owns.
   *
   * Used when the plugin unloads with `gcOnUnload` on: leaving sandbox
   * containers behind after nothing is driving them is a leak.
   *
   * @returns the names deleted.
   */
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

  /**
   * Delete containers that have gone idle, plus containers the engine still
   * holds for conversations this plugin no longer tracks.
   *
   * A conversation with leased work running (a command still executing, a
   * terminal session still open) is never idle, however long that work has
   * been running.
   *
   * @returns the names deleted.
   */
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

    // Orphans: created before the TTL window and not tracked in this process
    // (a plugin reload, or a chat that ended without unloading).
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
