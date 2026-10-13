/**
 * `ctx.subprocess` backed by `docker exec`.
 *
 * One spawn is one `docker exec` into the conversation's container. The
 * command is passed as a plain argv vector — no shell is inserted between the
 * caller's argv and the executable — which is what the search tools rely on
 * ("every model value an unquoted argv element").
 *
 * Two details make the seam honest rather than approximate:
 *
 * **Termination.** Killing the local `docker` client does not stop the process
 * running inside the container. So every command runs through `agent/run.sh`,
 * which `setsid`s the command, records its process-group id in
 * `/tmp/.dsh-pid-<op>`, and exec's it. `terminate()` then signals that process
 * group with a second short `docker exec` (see `process-group.ts`),
 * escalating to `KILL` after the grace period.
 *
 * **Ripgrep.** `glob` and `grep` spawn the app's packaged Windows `rg.exe`
 * through this seam. A Windows binary cannot run in the container, so the
 * packaged path is rewritten to the container's own `rg` (installed during
 * provisioning). Any other Windows path is rejected with a clear message
 * instead of failing inside the container.
 *
 * The supporting pieces live beside this module: the bounded output tail in
 * `output-tail.ts`, the pre-attach stdin buffer in `deferred-stdin.ts`.
 *
 * @module dsh-docker-sandbox/seams/subprocess
 */

import { PassThrough } from "node:stream"
import type { SandboxContext } from "../context.ts"
import {
  SubprocessExecutableNotFoundError,
  SubprocessRuntime,
  type SubprocessHandle,
  type SubprocessOutcome,
  type SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess"
import type { SandboxConfig } from "../config.ts"
import { DeferredStdin } from "../utils/deferred-stdin.ts"
import { isWindowsPath, type PathMapper } from "../container/paths.ts"
import { signalProcessGroup } from "../container/process-group.ts"
import { OutputTail, tailView } from "../utils/output-tail.ts"
// Re-exported: `OutputTail` was part of this module's public surface (the
// shell tests build fake handles from it), and the extraction to
// `output-tail.ts` must not break that import path.
export { OutputTail, tailView }
import { Provisioner } from "../container/provisioner.ts"
import { resolveTarget } from "../container/session.ts"
import { DockerTransport } from "../container/transport.ts"
import type { WorktreeManager } from "../container/worktrees.ts"

/** True for the ripgrep binary the app ships (`…\@vscode\ripgrep*\bin\rg.exe`). */
export function isPackagedRipgrep(executable: string): boolean {
  return /[\\/]rg\.exe$/i.test(executable) && /ripgrep/i.test(executable)
}

export interface SubprocessDeps {
  transport: DockerTransport
  provisioner: Provisioner
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

/**
 * Per-process nonce for pidfile ids. `nextOp` restarts at 1 when the plugin
 * reloads, and a command started by the previous fiber can still be running
 * inside a reused container; without the nonce the new fiber's `op1` would
 * signal (and clear) the old command's process group.
 */
const OP_NONCE = Math.random().toString(36).slice(2, 8)

export class DockerSubprocessRuntime extends SubprocessRuntime {
  /** The same context, seen with the services this plugin reads. */
  protected declare ctx: SandboxContext

  private nextOp = 0

  constructor(
    ctx: SandboxContext,
    private readonly deps: SubprocessDeps,
  ) {
    super(ctx, "subprocess")
  }

  /** Map a caller's executable onto its container equivalent. */
  private mapExecutable(executable: string): string {
    if (isPackagedRipgrep(executable)) return "rg"
    if (executable.startsWith("/")) return executable
    if (isWindowsPath(executable)) {
      throw new SubprocessExecutableNotFoundError(
        `"${executable}" is a Windows binary and cannot run inside the Docker sandbox; `
        + "only executables installed in the sandbox container are available",
      )
    }
    return executable
  }

  /** Resolve an executable name inside the conversation's container. */
  async resolveExecutable(name: string, cwd?: string): Promise<string> {
    void cwd
    const target = resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    await this.deps.provisioner.ensure(target)
    const result = await this.deps.transport.execInContainer(
      target,
      // The name travels as its own argv element (`$1`), never interpolated
      // into the script: a name carrying `$(...)` or backticks would otherwise
      // be expanded by the shell inside the container.
      ["sh", "-c", 'command -v "$1" 2>/dev/null', "sh", name],
      { timeoutMs: 30000 },
    )
    const path = result.stdout.toString("utf8").trim()
    if (result.code !== 0 || path === "") {
      throw new SubprocessExecutableNotFoundError(
        `"${name}" is not installed in the sandbox container "${target.container}" (image ${this.deps.config.image.get()})`,
      )
    }
    return path
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const config = this.deps.config
    if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
      throw new TypeError("subprocess spawn requires a non-empty argv")
    }
    const target = resolveTarget(this.ctx, config, this.deps.worktrees)
    const op = `op${OP_NONCE}${++this.nextOp}`
    const executable = this.mapExecutable(String(spec.argv[0]))

    const stdio = spec.stdio ?? {}
    const wantStdout = stdio.stdout !== "ignore"
    const wantStderr = stdio.stderr !== "ignore"
    const stdoutCap = typeof stdio.stdout === "object" ? stdio.stdout.maxBytes ?? config.maxOutputBytes.get() : config.maxOutputBytes.get()
    const stderrCap = typeof stdio.stderr === "object" ? stdio.stderr.maxBytes ?? config.maxOutputBytes.get() : config.maxOutputBytes.get()
    const graceMs = spec.graceMs ?? config.graceMs.get()

    const stdoutTail = wantStdout ? new OutputTail(stdoutCap) : undefined
    const stderrTail = wantStderr ? new OutputTail(stderrCap) : undefined
    // Live streams only on request: an unread PassThrough would buffer forever.
    const stdoutStream = stdio.stdout === "pipe" ? new PassThrough() : undefined
    const stderrStream = stdio.stderr === "pipe" ? new PassThrough() : undefined
    const stdin = stdio.stdin === "ignore" ? undefined : new DeferredStdin()

    const envPairs = Object.entries(spec.env ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value as string}`)

    // Callers pass the session's Windows cwd; the container needs its own form.
    const cwd = spec.cwd === undefined ? "-" : this.deps.paths.toContainer(spec.cwd, target.workspace)

    const containerArgv = [
      ...(envPairs.length > 0 ? ["env", ...envPairs] : []),
      "/bin/sh",
      "/tmp/.dsh-run.sh",
      op,
      cwd,
      executable,
      ...spec.argv.slice(1).map(String),
    ]

    const outcome = Promise.withResolvers<SubprocessOutcome>()
    let killRequested = false
    let escalated = false
    let settled = false
    let escalationTimer: NodeJS.Timeout | undefined
    let kill: ((signal?: NodeJS.Signals) => void) | undefined

    // Hold the container in place for as long as this command runs: the GC
    // sweep measures idleness from when the call started, so without a lease a
    // command longer than `idleTtlMs` would have its container deleted under
    // it. The lease also refreshes the idle clock when the command finishes.
    const releaseWork = this.deps.provisioner.beginWork(target.sessionId)

    const run = (async (): Promise<SubprocessOutcome> => {
      await this.deps.provisioner.ensure(target, { signal: spec.signal })
      const live = this.deps.transport.spawnInContainer(target, containerArgv)
      kill = live.kill

      live.child.stdout.on("data", (chunk: Buffer) => {
        stdoutTail?.append(chunk)
        stdoutStream?.write(chunk)
      })
      live.child.stderr.on("data", (chunk: Buffer) => {
        stderrTail?.append(chunk)
        stderrStream?.write(chunk)
      })
      live.child.stdin.on("error", () => {
        // The command may exit before consuming everything written to it.
      })

      if (stdin) stdin.attach(live.child.stdin)
      else live.child.stdin.end()

      const exit = await live.done
      stdoutStream?.end()
      stderrStream?.end()
      return killRequested || escalated
        ? { exitCode: null, signal: escalated ? "SIGKILL" : "SIGTERM", killed: true }
        : { exitCode: exit.code, signal: exit.signal, killed: false }
    })()

    run.then(
      (result) => {
        settled = true
        if (escalationTimer !== undefined) clearTimeout(escalationTimer)
        releaseWork()
        outcome.resolve(result)
      },
      (error: unknown) => {
        settled = true
        if (escalationTimer !== undefined) clearTimeout(escalationTimer)
        releaseWork()
        stdoutStream?.end()
        stderrStream?.end()
        outcome.reject(error)
      },
    )

    // The grace timer belongs to the termination, not to whoever happens to be
    // awaiting the exit: a caller that starts `waitForExit` before the cancel
    // lands must still get the SIGKILL escalation, and a plain await of a
    // healthy command must never arm it.
    const armEscalation = (): void => {
      if (settled || escalationTimer !== undefined) return
      escalationTimer = setTimeout(() => {
        escalated = true
        kill?.()
        void signalProcessGroup(this.deps.transport, target, op, "KILL", { waitForPidfileMs: 1000 }).catch(() => undefined)
      }, graceMs)
      escalationTimer.unref?.()
    }

    const terminate = () => {
      killRequested = true
      kill?.()
      // The pidfile appears a moment after the exec starts, so a cancellation
      // landing in that window has to keep looking; otherwise the signal finds
      // nothing and the command runs on with nobody watching its output.
      void signalProcessGroup(this.deps.transport, target, op, "TERM", { waitForPidfileMs: 2000 }).catch(() => undefined)
      armEscalation()
    }
    if (spec.signal) {
      if (spec.signal.aborted) terminate()
      else spec.signal.addEventListener("abort", terminate, { once: true })
    }

    return {
      ...(stdin ? { stdin: stdin.stream } : {}),
      ...(stdoutStream ? { stdout: stdoutStream } : {}),
      ...(stderrStream ? { stderr: stderrStream } : {}),
      collected: {
        ...(stdoutTail ? { stdout: tailView(stdoutTail) } : {}),
        ...(stderrTail ? { stderr: tailView(stderrTail) } : {}),
      },
      done: outcome.promise,
      terminate,
      waitForExit: async (signal?: AbortSignal) => {
        // The wait owns no grace timer: escalation is armed by `terminate()`
        // itself (see `armEscalation`), so a termination requested during the
        // wait escalates just the same, and a plain await never SIGKILLs a
        // healthy command.
        try {
          if (signal) {
            await new Promise<void>((resolve, reject) => {
              const abort = (): void => reject(new Error("aborted"))
              signal.addEventListener("abort", abort, { once: true })
              void outcome.promise.then(
                () => {
                  signal.removeEventListener("abort", abort)
                  resolve()
                },
                () => {
                  signal.removeEventListener("abort", abort)
                  resolve()
                },
              )
            })
          } else {
            await outcome.promise.catch(() => undefined)
          }
          return !escalated
        } catch {
          return false
        }
      },
    }
  }

}
