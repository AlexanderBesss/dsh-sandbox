import { spawn, spawnSync } from "node:child_process"

export type CliFailureCode = "GIT_MISSING" | "GIT_FAILED" | "GH_MISSING" | "GH_FAILED"

export class CliCommandError extends Error {
  constructor(
    message: string,
    readonly code: CliFailureCode,
    readonly detail?: string,
  ) {
    super(message)
    this.name = "CliCommandError"
  }
}

export interface CliResult {
  stdout: string
  stderr: string
  code: number
}

export interface CliOptions {
  cwd?: string
  timeoutMs?: number
  input?: string
}

export interface CliRunner {
  runSync(args: string[], opts?: CliOptions): CliResult
  run(args: string[], opts?: CliOptions): Promise<CliResult>
}

const MAX_CAPTURE = 1024 * 1024

function codesFor(label: "git" | "gh"): { missing: CliFailureCode; failed: CliFailureCode } {
  return label === "git"
    ? { missing: "GIT_MISSING", failed: "GIT_FAILED" }
    : { missing: "GH_MISSING", failed: "GH_FAILED" }
}

export function createCliRunner(baseArgv: string[], label: "git" | "gh"): CliRunner {
  const argv0 = baseArgv.length > 0 ? baseArgv[0]! : label
  const rest = baseArgv.length > 1 ? baseArgv.slice(1) : []
  const codes = codesFor(label)

  const failure = (args: string[], code: number | null, stderr: string): CliCommandError => {
    const text = stderr.trim()
    return new CliCommandError(
      `${label} ${args.join(" ")} failed with exit code ${code ?? "(killed)"}`,
      codes.failed,
      text,
    )
  }
  const fail = (args: string[], code: number | null, stderr: string): never => {
    throw failure(args, code, stderr)
  }

  return {
    runSync(args, opts = {}) {
      const result = spawnSync(argv0, [...rest, ...args], {
        cwd: opts.cwd,
        input: opts.input,
        timeout: opts.timeoutMs,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: MAX_CAPTURE,
      })
      if (result.error !== undefined) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new CliCommandError(
            `${label} is not available on this machine (set ${label}Argv to its full path)`,
            codes.missing,
          )
        }
        throw new CliCommandError(`${label} failed to start: ${result.error.message}`, codes.failed)
      }
      if (result.status !== 0) fail(args, result.status, result.stderr ?? "")
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 }
    },

    run(args, opts = {}) {
      return new Promise<CliResult>((resolve, reject) => {
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(argv0, [...rest, ...args], { cwd: opts.cwd, windowsHide: true })
        } catch (error) {
          reject(new CliCommandError(`cannot start ${label}: ${(error as Error).message}`, codes.missing))
          return
        }
        let stdout = ""
        let stderr = ""
        child.stdout?.on("data", (data: Buffer) => {
          if (stdout.length < MAX_CAPTURE) stdout += data.toString("utf8")
        })
        child.stderr?.on("data", (data: Buffer) => {
          if (stderr.length < MAX_CAPTURE) stderr += data.toString("utf8")
        })
        child.stdin?.on("error", () => {
        })
        if (opts.input !== undefined) child.stdin?.end(opts.input)
        else child.stdin?.end()

        const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), opts.timeoutMs)
        child.once("error", (error) => {
          if (timer !== undefined) clearTimeout(timer)
          reject(
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? new CliCommandError(
                  `${label} is not available on this machine (set ${label}Argv to its full path)`,
                  codes.missing,
                )
              : new CliCommandError(`${label} failed: ${(error as Error).message}`, codes.failed),
          )
        })
        child.once("close", (code) => {
          if (timer !== undefined) clearTimeout(timer)
          if (code !== 0) reject(failure(args, code, stderr))
          else resolve({ stdout, stderr, code: 0 })
        })
      })
    },
  }
}
