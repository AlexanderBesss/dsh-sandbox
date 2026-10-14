
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { SandboxConfig } from "../config.ts"

export type SandboxFailureCode =
  | "DOCKER_MISSING"
  | "DOCKER_UNREACHABLE"
  | "EXEC_TIMEOUT"
  | "EXEC_FAILED"
  | "NAME_CONFLICT"

export class SandboxUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: SandboxFailureCode,
    readonly detail?: string,
  ) {
    super(message)
    this.name = "SandboxUnavailableError"
  }
}

export function isMissingContainerError(error: unknown): boolean {
  return error instanceof SandboxUnavailableError
    && /no such (container|object)|does not exist/i.test(error.detail ?? error.message)
}

export function failureDetail(error: unknown): string {
  return error instanceof SandboxUnavailableError ? error.detail ?? error.message : String(error)
}

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

class StreamCapture {
  private readonly chunks: Buffer[] = []
  private captured = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  onData(data: Buffer): void {
    if (this.captured >= this.maxBytes) {
      this.truncated = true
      return
    }
    this.captured += data.length
    this.chunks.push(data)
    if (this.captured > this.maxBytes) this.truncated = true
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function classify(argv: string[], code: number | null, stderr: Buffer): SandboxUnavailableError {
  const text = stderr.toString("utf8").trim()
  if (/cannot connect to the docker daemon|is the docker daemon running|error during connect|docker daemon is not running|connection refused|connection reset|npipe/i.test(text)) {
    return new SandboxUnavailableError(
      `the Docker daemon is not reachable from ${argv.join(" ")}: ${text.split("\n")[0]}`,
      "DOCKER_UNREACHABLE",
      text,
    )
  }
  if (/no such container|no such object|container "[^"]+" does not exist|is not running/i.test(text)) {
    return new SandboxUnavailableError(text.split("\n")[0] ?? "sandbox container is gone", "EXEC_FAILED", text)
  }
  if (/is already in use|conflict\. the container name/i.test(text)) {
    return new SandboxUnavailableError(text.split("\n")[0] ?? "container name conflict", "NAME_CONFLICT", text)
  }
  return new SandboxUnavailableError(
    `${argv.join(" ")} failed with exit code ${code ?? "(killed)"}`,
    "EXEC_FAILED",
    text,
  )
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
