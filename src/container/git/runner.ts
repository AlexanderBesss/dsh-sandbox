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

const CODES: Record<"git" | "gh", { missing: CliFailureCode; failed: CliFailureCode }> = {
  git: { missing: "GIT_MISSING", failed: "GIT_FAILED" },
  gh: { missing: "GH_MISSING", failed: "GH_FAILED" },
}

function isMissingBinary(error: Error): boolean {
  return "code" in error && error.code === "ENOENT"
}

export function createCliRunner(baseArgv: string[], label: "git" | "gh"): CliRunner {
  const [argv0 = label, ...rest] = baseArgv
  const codes = CODES[label]

  const missing = (): CliCommandError => new CliCommandError(
    `${label} is not available on this machine (set ${label}Argv to its full path)`,
    codes.missing,
  )
  const failure = (args: string[], code: number | null, stderr: string): CliCommandError => new CliCommandError(
    `${label} ${args.join(" ")} failed with exit code ${code ?? "(killed)"}`,
    codes.failed,
    stderr.trim(),
  )

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
        if (isMissingBinary(result.error)) throw missing()
        throw new CliCommandError(`${label} failed to start: ${result.error.message}`, codes.failed)
      }
      if (result.status !== 0) throw failure(args, result.status, result.stderr ?? "")
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: 0 }
    },

    run(args, opts = {}) {
      return new Promise<CliResult>((resolve, reject) => {
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(argv0, [...rest, ...args], { cwd: opts.cwd, windowsHide: true })
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          reject(new CliCommandError(`cannot start ${label}: ${detail}`, codes.missing))
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
            isMissingBinary(error)
              ? missing()
              : new CliCommandError(`${label} failed: ${error.message}`, codes.failed),
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
