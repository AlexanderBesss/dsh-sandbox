
import type { SandboxContext } from "../context.ts"
import { TerminalError, type TerminalBackend, type TerminalBackendSession, type TerminalSendOperation, type TerminalWaitReason } from "@deepseek-ai/dsh-terminal"
import type { SandboxConfig } from "../config.ts"
import { PathMapper } from "../container/paths.ts"
import { Provisioner } from "../container/provisioner.ts"
import { resolveTarget, targetForSession, type SandboxTarget } from "../container/session.ts"
import { signalProcessGroup, type ProcessGroupSignal } from "../container/process-group.ts"
import { type DockerTransport, type LiveProcess } from "../container/transport.ts"
import type { WorktreeManager } from "../container/worktrees.ts"

const TRANSCRIPT_CAP = 200_000

let terminalOpSeq = 0

const OP_NONCE = Math.random().toString(36).slice(2, 8)

const MARKER_PATTERN = /^__DSH_DONE_(\d+)__ (\d+|null)$/

interface PendingSend {
  seq: number
  delta: string[]
  truncated: boolean
  settle: (reason: TerminalWaitReason, exitCode: number | null) => void
  settled: boolean
  timer?: NodeJS.Timeout
  abortSignal?: AbortSignal
  abortListener?: () => void
}

class ContainerTerminalSession implements TerminalBackendSession {
  private live: LiveProcess | undefined
  private transcript = ""
  private pending: PendingSend | undefined
  private sendSeq = 0
  private closed = false
  private readonly runnerOp = `dsh-t${OP_NONCE}${++terminalOpSeq}`
  private releaseWork: (() => void) | undefined

  constructor(
    private readonly transport: DockerTransport,
    private readonly provisioner: Provisioner,
    private readonly config: SandboxConfig,
    private readonly target: SandboxTarget,
    private readonly cwd: string,
  ) {}

  get motd(): string {
    return [
      `dsh-docker-sandbox — container ${this.target.container}`,
      `image ${this.config.image.get()} · workspace ${this.cwd}`,
      "",
    ].join("\n")
  }

  get pid(): number | undefined {
    return this.live?.child.pid
  }

  async start(): Promise<void> {
    this.releaseWork = this.provisioner.beginWork(this.target.sessionId)
    try {
      await this.provisioner.ensure(this.target)
      const live = this.transport.spawnInContainer(this.target, [
        "/bin/sh",
        "/tmp/.dsh-run.sh",
        this.runnerOp,
        this.cwd,
        "/bin/sh",
      ], { pty: this.config.terminalPty === true })
      this.live = live
      live.child.stdin.on("error", () => {
      })
      for (const stream of [live.child.stdout, live.child.stderr] as NodeJS.ReadableStream[]) {
        stream.setEncoding("utf8")
        let partial = ""
        stream.on("data", (chunk: string) => {
          partial += chunk
          const lines = partial.split("\n")
          partial = lines.pop() ?? ""
          for (const line of lines) this.ingest(line)
        })
      }
      void live.done.then(() => {
        if (this.closed) return
        this.live = undefined
        this.settlePending("session_exit", null)
      })
    } catch (error) {
      this.releaseWork?.()
      this.releaseWork = undefined
      throw error
    }
  }

  private ingest(line: string): void {
    const marker = MARKER_PATTERN.exec(line)
    const pending = this.pending
    if (marker !== null) {
      if (pending !== undefined && !pending.settled && marker[1] === String(pending.seq)) {
        this.settlePending("stdin_read", marker[2] === "null" ? null : Number(marker[2]), pending)
      }
      return
    }
    if (pending !== undefined && !pending.settled) {
      pending.delta.push(line)
    }
    this.transcript = (this.transcript + line + "\n").slice(-TRANSCRIPT_CAP)
  }

  private settlePending(reason: TerminalWaitReason, exitCode: number | null, pending: PendingSend | undefined = this.pending): void {
    if (pending === undefined || pending !== this.pending || pending.settled) return
    pending.settled = true
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.abortSignal !== undefined && pending.abortListener !== undefined) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener)
    }
    pending.settle(reason, exitCode)
  }

  startSend(request: { text: string; submit?: boolean; signal?: AbortSignal; timeoutMs?: number }): TerminalSendOperation {
    const live = this.live
    if (!live || this.closed) {
      throw new TerminalError("the sandbox terminal session has already exited", "TERMINAL_EXITED")
    }
    this.settlePending("timeout", null)
    const seq = ++this.sendSeq
    const timeoutMs = Math.min(request.timeoutMs ?? this.config.timeoutMs.get(), this.config.maxTimeoutMs.get())
    let resolveDone: (value: { viewport: string; waitReason: TerminalWaitReason; sessionStatus: string; truncated: boolean }) => void = () => undefined
    let settled = false
    let cancelRequested = false

    const pending: PendingSend = {
      seq,
      delta: [],
      truncated: false,
      settled: false,
      settle: (waitReason, exitCode) => {
        settled = true
        const viewport = pending.delta.join("\n")
        resolveDone({
          viewport: exitCode === null || waitReason !== "stdin_read"
            ? viewport
            : `${viewport}${viewport.endsWith("\n") ? "" : "\n"}[exit ${exitCode}]`,
          waitReason,
          sessionStatus: this.closed ? "exited" : "ready",
          truncated: pending.truncated,
        })
      },
    }
    pending.timer = timeoutMs > 0
      ? setTimeout(() => this.settlePending("timeout", null, pending), timeoutMs)
      : undefined
    pending.timer?.unref?.()
    this.pending = pending
    this.provisioner.touch(this.target.sessionId)

    const body = request.text
    live.child.stdin.write(`${body}${request.submit === false ? "" : "\n"}`)
    if (request.submit !== false) {
      live.child.stdin.write(`printf '\\n__DSH_DONE_${seq}__ %s\\n' "$?"\n`)
    }

    if (request.signal) {
      const abortListener = (): void => {
        cancelRequested = true
        this.settlePending("timeout", null, pending)
      }
      pending.abortSignal = request.signal
      pending.abortListener = abortListener
      request.signal.addEventListener("abort", abortListener, { once: true })
    }

    return {
      done: new Promise((resolve) => {
        resolveDone = resolve
      }),
      get settled() {
        return settled
      },
      get cancelRequested() {
        return cancelRequested
      },
      startedAt: Date.now(),
      readOutput: () => {
        const delta = pending.delta.join("\n")
        pending.delta = []
        return { delta, truncated: pending.truncated }
      },
    }
  }

  async read(request?: { offset?: number; lines?: number }): Promise<{ text: string; lineBegin: number; lineEnd: number; totalLines?: number; truncated: boolean }> {
    const all = this.transcript.split("\n")
    const lines = request?.lines ?? all.length
    const begin = Math.max(0, Math.min(request?.offset ?? 0, all.length))
    const slice = all.slice(begin, begin + lines)
    return {
      text: slice.join("\n"),
      lineBegin: begin + 1,
      lineEnd: begin + slice.length,
      totalLines: all.length,
      truncated: this.transcript.length >= TRANSCRIPT_CAP,
    }
  }

  private static readonly SIGNAL_WHITELIST: ReadonlySet<ProcessGroupSignal> = new Set([
    "HUP", "INT", "QUIT", "TERM", "USR1", "USR2", "KILL",
  ])

  async signal(name: string): Promise<{ processGroupId?: number }> {
    const signal = name.replace(/^SIG/i, "").toUpperCase()
    if (!ContainerTerminalSession.SIGNAL_WHITELIST.has(signal as ProcessGroupSignal)) {
      throw new TerminalError(
        `sending ${name} is not available: the sandbox terminal can signal the session's process group `
        + "with SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 or SIGKILL",
        "TERMINAL_SIGNAL_UNSUPPORTED",
      )
    }
    if (this.live === undefined || this.closed) {
      throw new TerminalError("the terminal session is no longer running", "TERMINAL_EXITED")
    }
    const signaled = await signalProcessGroup(
      this.transport,
      this.target,
      this.runnerOp,
      signal as ProcessGroupSignal,
      { waitForPidfileMs: 1500, keepPidfile: true },
    )
    if (!signaled) {
      throw new TerminalError("the terminal session's shell is gone; nothing was signalled", "TERMINAL_EXITED")
    }
    return {}
  }

  async close(): Promise<void> {
    this.closed = true
    this.settlePending("session_exit", null)
    const live = this.live
    if (live !== undefined) {
      await signalProcessGroup(this.transport, this.target, this.runnerOp, "TERM", { waitForPidfileMs: 1500 })
        .catch(() => undefined)
      const exited = await Promise.race([
        live.done.then(() => true, () => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), this.config.graceMs.get())
          timer.unref?.()
        }),
      ])
      if (!exited) {
        await signalProcessGroup(this.transport, this.target, this.runnerOp, "KILL", { waitForPidfileMs: 0 })
          .catch(() => undefined)
      }
    }
    live?.kill()
    this.live = undefined
    this.releaseWork?.()
    this.releaseWork = undefined
  }
}

export interface TerminalDeps {
  transport: DockerTransport
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

export function createShellBackend(ctx: SandboxContext, deps: TerminalDeps): TerminalBackend {
  return {
    type: "shell",
    spawn: async (request) => {
      const sessionId = request.sessionId === undefined || request.sessionId === ""
        ? resolveTarget(ctx, deps.config, deps.worktrees).sessionId
        : String(request.sessionId)
      const target = targetForSession(ctx, deps.config, sessionId, undefined, deps.worktrees)
      const cwd = request.cwd === undefined
        ? deps.paths.containerRoot(target.workspace)
        : deps.paths.toContainer(request.cwd, target.workspace)
      const session = new ContainerTerminalSession(
        deps.transport,
        deps.provisioner,
        deps.config,
        target,
        cwd,
      )
      await session.start()
      return session as unknown as TerminalBackendSession
    },
  }
}

export { ContainerTerminalSession }
