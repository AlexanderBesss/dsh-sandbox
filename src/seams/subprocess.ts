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
import { raceAbort } from "../utils/abort-race.ts"
import { opIdFactory } from "../utils/op-id.ts"
import { isWindowsPath, type PathMapper } from "../container/paths.ts"
import { signalProcessGroup } from "../container/process-group.ts"
import { OutputTail, tailView } from "../utils/output-tail.ts"
export { OutputTail, tailView }
import { Provisioner } from "../container/provisioner.ts"
import { resolveTarget } from "../container/session.ts"
import { DockerTransport } from "../container/transport.ts"
import type { WorktreeManager } from "../container/worktrees.ts"

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

export class DockerSubprocessRuntime extends SubprocessRuntime {
  protected declare ctx: SandboxContext

  private readonly nextOpId = opIdFactory("op")

  constructor(
    ctx: SandboxContext,
    private readonly deps: SubprocessDeps,
  ) {
    super(ctx, "subprocess")
  }

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

  async resolveExecutable(name: string, cwd?: string): Promise<string> {
    void cwd
    const target = resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    await this.deps.provisioner.ensure(target)
    const result = await this.deps.transport.execInContainer(
      target,
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
    const op = this.nextOpId()
    const executable = this.mapExecutable(String(spec.argv[0]))

    const stdio = spec.stdio ?? {}
    const wantStdout = stdio.stdout !== "ignore"
    const wantStderr = stdio.stderr !== "ignore"
    const stdoutCap = typeof stdio.stdout === "object" ? stdio.stdout.maxBytes ?? config.maxOutputBytes.get() : config.maxOutputBytes.get()
    const stderrCap = typeof stdio.stderr === "object" ? stdio.stderr.maxBytes ?? config.maxOutputBytes.get() : config.maxOutputBytes.get()
    const graceMs = spec.graceMs ?? config.graceMs.get()

    const stdoutTail = wantStdout ? new OutputTail(stdoutCap) : undefined
    const stderrTail = wantStderr ? new OutputTail(stderrCap) : undefined
    const stdoutStream = stdio.stdout === "pipe" ? new PassThrough() : undefined
    const stderrStream = stdio.stderr === "pipe" ? new PassThrough() : undefined
    const stdin = stdio.stdin === "ignore" ? undefined : new DeferredStdin()

    const envPairs = Object.entries(spec.env ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value as string}`)

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
        if (signal === undefined) {
          await outcome.promise.catch(() => undefined)
          return !escalated
        }
        const settled = await raceAbort(
          outcome.promise.then(() => true, () => true),
          signal,
          () => false,
        )
        return settled && !escalated
      },
    }
  }

}
