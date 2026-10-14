import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { SandboxConfig } from "../config.ts"
import { StreamCapture } from "./transport/capture.ts"
import { classify, SandboxUnavailableError } from "./transport/errors.ts"

export type { SandboxFailureCode } from "./transport/errors.ts"
export { failureDetail, isMissingContainerError, SandboxUnavailableError } from "./transport/errors.ts"

export interface ExecOptions {
  stdin?: Buffer | string
  timeoutMs?: number
  signal?: AbortSignal
  maxCaptureBytes?: number
}

export interface ExecResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
  truncated: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface LiveProcess {
  child: ChildProcessWithoutNullStreams
  done: Promise<{ code: number | null; signal: string | null }>
  kill(signal?: NodeJS.Signals): void
}

export class DockerTransport {
  constructor(private readonly config: Pick<SandboxConfig, "dockerArgv">) {}

  spawn(argv: string[], opts: { pty?: boolean } = {}): LiveProcess {
    void opts
    const base = this.config.dockerArgv.length > 0 ? this.config.dockerArgv : ["docker"]
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(base[0]!, [...base.slice(1), ...argv], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      throw new SandboxUnavailableError(
        `cannot start docker: ${(error as Error).message}`,
        "DOCKER_MISSING",
      )
    }
    const done = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", (error) => {
        reject(
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? new SandboxUnavailableError(
                "docker is not available on this machine (is Docker Desktop installed and running?)",
                "DOCKER_MISSING",
              )
            : new SandboxUnavailableError(`docker failed: ${error.message}`, "EXEC_FAILED"),
        )
      })
      child.once("close", (code, signal) => resolve({ code, signal }))
    })
    return {
      child,
      done,
      kill: (signal = "SIGKILL") => {
        try {
          child.kill(signal)
        } catch {
        }
      },
    }
  }

  async exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const live = this.spawn(argv)
    const maxCapture = opts.maxCaptureBytes ?? 32 * 1024 * 1024

    const out = new StreamCapture(maxCapture)
    const err = new StreamCapture(maxCapture)
    live.child.stdout.on("data", (data: Buffer) => out.onData(data))
    live.child.stderr.on("data", (data: Buffer) => err.onData(data))
    live.child.stdin.on("error", () => {
    })

    if (opts.stdin !== undefined) live.child.stdin.end(opts.stdin)
    else live.child.stdin.end()

    const timer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => live.kill(), opts.timeoutMs)
    const abort = () => live.kill()
    if (opts.signal) {
      if (opts.signal.aborted) live.kill()
      else opts.signal.addEventListener("abort", abort, { once: true })
    }

    let outcome: { code: number | null; signal: string | null }
    try {
      outcome = await live.done
    } finally {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener("abort", abort)
    }

    const stdout = out.buffer()
    const stderr = err.buffer()
    if (outcome.code !== 0 && opts.signal?.aborted) {
      throw new SandboxUnavailableError(`"${argv.join(" ")}" was cancelled`, "EXEC_FAILED")
    }
    if (outcome.code === null) {
      throw new SandboxUnavailableError(
        `"${argv.join(" ")}" was killed (${outcome.signal ?? "no signal"})`,
        opts.timeoutMs !== undefined ? "EXEC_TIMEOUT" : "EXEC_FAILED",
      )
    }
    return {
      code: outcome.code,
      stdout,
      stderr,
      truncated: out.truncated || err.truncated,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
    }
  }

  async docker(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.exec(args, opts)
    if (result.code !== 0) throw classify(args, result.code, result.stderr)
    return result
  }

  async dockerJson<T>(args: string[], opts: ExecOptions = {}): Promise<T> {
    const result = await this.docker(args, opts)
    const text = result.stdout.toString("utf8").trim()
    if (text === "") throw new SandboxUnavailableError(`docker returned no JSON for: ${args.join(" ")}`, "EXEC_FAILED")
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new SandboxUnavailableError(
        `docker returned non-JSON output for: ${args.join(" ")}: ${text.slice(0, 200)}`,
        "EXEC_FAILED",
        (error as Error).message,
      )
    }
  }

  execInContainer(
    target: { container: string },
    containerArgv: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    return this.docker(["exec", "-i", target.container, ...containerArgv], opts)
  }

  spawnInContainer(
    target: { container: string },
    containerArgv: string[],
    opts: { pty?: boolean } = {},
  ): LiveProcess {
    return this.spawn(["exec", ...(opts.pty ? ["-t"] : []), "-i", target.container, ...containerArgv])
  }
}
