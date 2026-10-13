/**
 * The `shell` terminal backend, running inside the conversation's container.
 *
 * The terminal panel keeps a persistent shell per session, so `cd` in one send
 * is still in effect in the next. Without a PTY there is no prompt and no
 * Ctrl-C, so completion is detected with a sentinel: each send is followed by
 * `printf '\n__DSH_DONE_<n>__ %s\n' "$?"`, and the session settles when that
 * line comes back. This is the same trick the shipped bash backend uses to
 * decide that a command has finished, and it is what makes the viewport text
 * trustworthy rather than a guess from a quiet period.
 *
 * Signals reach the session shell's recorded process group through the same
 * `agent/run.sh` runner the shell tool uses, so `signal()` works with or
 * without a PTY for the standard stop signals. Closing a session signals the
 * group too, escalating to KILL after `graceMs` — killing only the local
 * `docker` client would leave the command running in the container.
 *
 * @module dsh-docker-sandbox/terminal
 */

import type { SandboxContext } from "./context.ts"
import { TerminalError, type TerminalBackend, type TerminalBackendSession, type TerminalSendOperation, type TerminalWaitReason } from "@deepseek-ai/dsh-terminal"
import type { SandboxConfig } from "./config.ts"
import { PathMapper } from "./paths.ts"
import { Provisioner } from "./provisioner.ts"
import { resolveTarget, targetForSession, type SandboxTarget } from "./session.ts"
import { signalProcessGroup, type ProcessGroupSignal } from "./process-group.ts"
import { type DockerTransport, type LiveProcess } from "./transport.ts"

/** Rolling transcript cap per session. */
const TRANSCRIPT_CAP = 200_000

/** Distinguishes the pidfiles of terminal sessions in one container. */
let terminalOpSeq = 0

/**
 * Per-process nonce: `terminalOpSeq` restarts at 1 after a plugin reload, and
 * a session shell from the previous fiber can still hold a reused container;
 * the nonce keeps the new fiber's signals off the old shell's process group.
 */
const OP_NONCE = Math.random().toString(36).slice(2, 8)

/** The completion sentinel, as it appears on an output line. */
const MARKER_PATTERN = /^__DSH_DONE_(\d+)__ (\d+|null)$/

interface PendingSend {
  /** The send this marker belongs to; a marker for another one is noise. */
  seq: number
  delta: string[]
  truncated: boolean
  settle: (reason: TerminalWaitReason, exitCode: number | null) => void
  settled: boolean
  timer?: NodeJS.Timeout
  /** The caller's abort listener, detached once this send settles. */
  abortSignal?: AbortSignal
  abortListener?: () => void
}

class ContainerTerminalSession implements TerminalBackendSession {
  private live: LiveProcess | undefined
  private transcript = ""
  private pending: PendingSend | undefined
  private sendSeq = 0
  private closed = false
  /** The runner op id whose pidfile records this session shell's process group. */
  private readonly runnerOp = `dsh-t${OP_NONCE}${++terminalOpSeq}`
  /** Keeps the container alive while this session holds it. */
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
    // A terminal session is long-lived work: without a lease, the GC sweep
    // would reclaim the container out from under a shell that is simply idle
    // on screen (or busy running a dev server).
    this.releaseWork = this.provisioner.beginWork(this.target.sessionId)
    try {
      await this.provisioner.ensure(this.target)
      // The shell runs through the command runner so `close()` can stop the
      // command it started: killing the local `docker` client does not stop
      // the process inside the container. The runner also `cd`s to the
      // session's container cwd before starting the shell.
      const live = this.transport.spawnInContainer(this.target, [
        "/bin/sh",
        "/tmp/.dsh-run.sh",
        this.runnerOp,
        this.cwd,
        "/bin/sh",
      ], { pty: this.config.terminalPty === true })
      this.live = live
      live.child.stdin.on("error", () => {
        // The session's shell may be gone by the time a send flushes to it; the
        // exit handler below reports that as a settled session.
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
      // A failed start must not leak the lease: nothing is running, and a
      // stuck lease would exempt the container from the idle GC forever.
      this.releaseWork?.()
      this.releaseWork = undefined
      throw error
    }
  }

  /** Route one output line to the pending send, or to the idle transcript. */
  private ingest(line: string): void {
    const marker = MARKER_PATTERN.exec(line)
    const pending = this.pending
    if (marker !== null) {
      // A marker for any other send — one this session already stopped waiting
      // on after a timeout or an abort — is protocol noise. It must not reach a
      // viewport, and it must not be mistaken for the current send's verdict.
      if (pending !== undefined && !pending.settled && marker[1] === String(pending.seq)) {
        this.settlePending("stdin_read", marker[2] === "null" ? null : Number(marker[2]), pending)
      }
      // The sentinel is protocol, not output: like the delta, it never reaches
      // the transcript the panel reads back.
      return
    }
    if (pending !== undefined && !pending.settled) {
      pending.delta.push(line)
    }
    this.transcript = (this.transcript + line + "\n").slice(-TRANSCRIPT_CAP)
  }

  /**
   * Settle one specific send.
   *
   * The target is explicit, never "whatever is pending now": a late timer or a
   * stale abort signal from a send that already finished must not settle the
   * send that happens to be running.
   */
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
    // A send must not be dropped unsettled: its timer and abort listener would
    // otherwise outlive it and settle whatever send runs next. The service
    // contract makes sends exclusive, so this only fires on a caller that
    // abandoned one; settle it before starting the new one.
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

  /** Signals the terminal service may deliver, mapped onto the recorded group. */
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
    // The session shell runs through the runner, so its process group is
    // recorded; a group signal reaches the shell and the command it is running,
    // with or without a PTY. The pidfile stays in place: the session lives on
    // after a signal, and its next signal (and its close) needs the group.
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
    // Stop the command the session started, not just the local client: the
    // shell runs through the runner, so its process group is recorded. TERM
    // first; a shell that ignores it gets KILL after the grace period, the
    // same escalation the subprocess runtime applies.
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
}

/**
 * The backend this plugin registers for the `shell` terminal type.
 *
 * The conversation comes from the spawn request, not from the initiating agent:
 * a terminal is usually opened from the UI, where no agent chain is running, so
 * resolving through `agents` would either fail the spawn or — worse, with
 * `allowAgentless` on — put every chat's terminal in one shared container.
 */
export function createShellBackend(ctx: SandboxContext, deps: TerminalDeps): TerminalBackend {
  return {
    type: "shell",
    spawn: async (request) => {
      const sessionId = request.sessionId === undefined || request.sessionId === ""
        ? resolveTarget(ctx, deps.config).sessionId
        : String(request.sessionId)
      const target = targetForSession(ctx, deps.config, sessionId)
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
