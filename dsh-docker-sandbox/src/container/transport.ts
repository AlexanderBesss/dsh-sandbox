/**
 * The one place that talks to Docker.
 *
 * The docker CLI is a native Windows binary (Docker Desktop installs
 * `docker.exe` on PATH), so every call is spawned directly: no WSL hop, no
 * kubeconfig, no in-guest shell. Each argv entry is passed as one argument;
 * multi-line payloads (agent scripts, command text) always travel through
 * stdin — passing them as arguments is where Windows argument quoting
 * corrupts them.
 *
 * Two shapes are needed:
 *
 * - {@link DockerTransport.exec} runs a short command to completion and
 *   returns its buffers — provisioning, shell commands, one-shot filesystem
 *   calls.
 * - {@link DockerTransport.spawn} hands back live streams for the long-lived
 *   in-container channels (the filesystem agent and terminal sessions).
 *
 * Unlike `kubectl exec`, `docker exec` propagates the in-container exit code
 * cleanly and appends no termination note to stderr, so no output scrubbing
 * is needed here.
 *
 * @module dsh-docker-sandbox/container/transport
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import type { SandboxConfig } from "../config.ts"

/** Why a Docker call could not be made. */
export type SandboxFailureCode =
  | "DOCKER_MISSING"
  | "DOCKER_UNREACHABLE"
  | "EXEC_TIMEOUT"
  | "EXEC_FAILED"
  /** The container name this plugin needs is held by a container it does not own. */
  | "NAME_CONFLICT"

/** A Docker call could not be made at all. */
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

/** True when the error says the container is simply not there. */
export function isMissingContainerError(error: unknown): boolean {
  return error instanceof SandboxUnavailableError
    && /no such (container|object)|does not exist/i.test(error.detail ?? error.message)
}

/** The engine-side detail of a failed call, for messages and the UI. */
export function failureDetail(error: unknown): string {
  return error instanceof SandboxUnavailableError ? error.detail ?? error.message : String(error)
}

export interface ExecOptions {
  /** Written to the child's stdin, then closed. */
  stdin?: Buffer | string
  /** Kill the child past this budget. */
  timeoutMs?: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Upper bound on captured bytes per stream; beyond it the tail is dropped. */
  maxCaptureBytes?: number
}

export interface ExecResult {
  /** Process exit code, or `null` when killed. */
  code: number | null
  stdout: Buffer
  stderr: Buffer
  /** True when either stream exceeded `maxCaptureBytes`. */
  truncated: boolean
  /** True when stdout alone exceeded `maxCaptureBytes`. */
  stdoutTruncated: boolean
  /** True when stderr alone exceeded `maxCaptureBytes`. */
  stderrTruncated: boolean
}

/** A live child process with its streams and an exit promise. */
export interface LiveProcess {
  child: ChildProcessWithoutNullStreams
  done: Promise<{ code: number | null; signal: string | null }>
  /** Kill the local `docker` client. */
  kill(signal?: NodeJS.Signals): void
}

/**
 * One stream's bounded capture.
 *
 * Each stream gets its own budget and its own overflow flag: a chatty stdout
 * must not starve stderr, and a single shared flag would report the quiet
 * stream as truncated too.
 */
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
    // A single chunk larger than the budget must still report truncation:
    // the whole chunk is kept (one chunk's overshoot is bounded), but the
    // caller asked for at most `maxBytes` and did not get a complete stream.
    if (this.captured > this.maxBytes) this.truncated = true
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

/** Classify a failed docker invocation into a named failure. */
function classify(argv: string[], code: number | null, stderr: Buffer): SandboxUnavailableError {
  const text = stderr.toString("utf8").trim()
  // Case-insensitive throughout: the CLI capitalizes its messages ("Cannot
  // connect to the Docker daemon", "No such container"), and a case-sensitive
  // match would quietly downgrade them to a generic EXEC_FAILED.
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

  /** Start one docker invocation without collecting its output. */
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
          // Already gone.
        }
      },
    }
  }

  /** Run one docker invocation and collect its output. */
  async exec(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const live = this.spawn(argv)
    const maxCapture = opts.maxCaptureBytes ?? 32 * 1024 * 1024

    const out = new StreamCapture(maxCapture)
    const err = new StreamCapture(maxCapture)
    live.child.stdout.on("data", (data: Buffer) => out.onData(data))
    live.child.stderr.on("data", (data: Buffer) => err.onData(data))
    live.child.stdin.on("error", () => {
      // The child may exit before reading everything it was given.
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

  /** Run one docker call, throwing a classified error on failure. */
  async docker(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.exec(args, opts)
    if (result.code !== 0) throw classify(args, result.code, result.stderr)
    return result
  }

  /** Run one docker call and parse its stdout as JSON. */
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

  /**
   * One `docker exec` into a container, with the command as trailing argv.
   *
   * `docker exec` has no `--` separator (the CLI would try to execute it), so
   * the first container argv entry must not start with `-`; every call site
   * here starts it with `sh`, `/bin/sh`, or `env`.
   */
  execInContainer(
    target: { container: string },
    containerArgv: string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    return this.docker(["exec", "-i", target.container, ...containerArgv], opts)
  }

  /** One live `docker exec` into a container, streams left open. */
  spawnInContainer(
    target: { container: string },
    containerArgv: string[],
    opts: { pty?: boolean } = {},
  ): LiveProcess {
    return this.spawn(["exec", ...(opts.pty ? ["-t"] : []), "-i", target.container, ...containerArgv])
  }
}
