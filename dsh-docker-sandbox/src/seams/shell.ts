import type { SandboxContext } from "../context.ts"
import { ShellExecutor, type ShellExecSpec, type ShellProcess, type ShellRunResult } from "@deepseek-ai/dsh-shell"
import type { SubprocessHandle } from "@deepseek-ai/dsh-subprocess"
import type { SandboxConfig } from "../config.ts"
import { PathMapper } from "../container/paths.ts"
import { Provisioner } from "../container/provisioner.ts"
import { resolveTarget, SandboxSessionError, type SandboxTarget } from "../container/session.ts"
import type { DockerTransport } from "../container/transport.ts"
import type { DockerSubprocessRuntime } from "./subprocess.ts"
import type { WorktreeManager } from "../container/worktrees.ts"

export interface ShellDeps {
  subprocess: DockerSubprocessRuntime
  provisioner: Provisioner
  transport: DockerTransport
  paths: PathMapper
  config: SandboxConfig
  worktrees?: WorktreeManager
}

export function looksLikePowerShell(command: string): boolean {
  return (
    /\b(?:Get|Set|New|Test|Select|Remove|Add|Copy|Move|Invoke|Import|Export|Write|Read|Clear|ForEach|Where|Sort|Measure|Group|Format|Out|Push|Pop|ConvertFrom|ConvertTo|Compare|Tee)-[A-Z][A-Za-z]+/.test(command) ||
    /\$env:/.test(command) ||
    /\bAdd-Type\b/.test(command) ||
    /\[(?:System|Microsoft)\.[A-Za-z]/.test(command)
  )
}

const POWERSHELL_REJECTION =
  "dsh-docker-sandbox: PowerShell is not available in this sandbox. The session runs in a Linux " +
  "container whose shell is sh/bash, so PowerShell cmdlets (Get-Location, Test-Path, Select-String, " +
  "$env:NAME, ...) do not exist here. Use the Bash tool with POSIX commands instead: the workspace " +
  "is /workspace, and host drives appear as /c/..., /f/..., ... (exit 127 is synthesized by the " +
  "sandbox, not by a command)."

interface OutputStream {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
  readonly text: string
  readonly lossy: boolean
  readonly bytes: number
}

function textStream(text: string): OutputStream {
  return {
    readFrom: (fromByte: number) => ({ text: text.slice(fromByte), nextOffset: text.length, lossy: false }),
    get text() {
      return text
    },
    get lossy() {
      return false
    },
    get bytes() {
      return text.length
    },
  }
}

const EMPTY_STREAM: OutputStream = {
  readFrom: (fromByte: number) => ({ text: "", nextOffset: fromByte, lossy: false }),
  text: "",
  lossy: false,
  bytes: 0,
}

function rejectedProcess(message: string, timeoutMs: number, details: Record<string, unknown>): ShellProcess {
  return {
    status: "completed",
    exitCode: 127,
    signal: null,
    observed: { stdout: textStream(""), stderr: textStream(message) },
    done: Promise.resolve(),
    readOutput: () => ({ delta: `[stderr]\n${message}`, lossy: false }),
    kill: () => false,
    result: () =>
      Promise.resolve({
        exitCode: 127,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs,
        stdout: { text: "", truncated: false },
        stderr: { text: message, truncated: false },
      }),
    get closed() {
      return true
    },
    details,
  }
}

class ContainerShellProcess implements ShellProcess {
  status: "running" | "completed" | "killed" = "running"
  exitCode: number | null = null
  signal: string | null = null
  readonly observed: { stdout: OutputStream; stderr: OutputStream }
  readonly done: Promise<void>
  readonly details: Record<string, unknown>

  private readonly handle: SubprocessHandle
  private readonly timeoutMs: number
  private timer: NodeJS.Timeout | undefined
  private timedOut = false
  private aborted = false
  private providerFailure: { error: unknown; note: string } | undefined
  private stdoutOffset = 0
  private stderrOffset = 0

  constructor(
    handle: SubprocessHandle,
    target: SandboxTarget,
    image: string,
    opts: { timeoutMs: number; armTimeout: boolean; signal?: AbortSignal },
  ) {
    this.handle = handle
    this.timeoutMs = opts.timeoutMs
    this.details = {
      container: target.container,
      image,
      workspace: target.workspace,
    }
    this.observed = {
      stdout: handle.collected.stdout ?? EMPTY_STREAM,
      stderr: this.stderrView(handle),
    }
    this.done = Promise.resolve().then(() => handle.done).then(
      (outcome) => {
        if (this.timer !== undefined) clearTimeout(this.timer)
        if (this.status === "running") {
          this.status = this.aborted || outcome.killed === true || outcome.signal !== null ? "killed" : "completed"
        }
        this.exitCode = outcome.exitCode
        this.signal = outcome.signal
      },
      (error: unknown) => {
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.status = "killed"
        this.providerFailure = { error, note: `subprocess failed before reporting an outcome: ${String(error)}` }
      },
    )
    this.done.catch(() => undefined)

    this.timer = opts.timeoutMs > 0 && opts.armTimeout
      ? setTimeout(() => {
        this.timedOut = true
        handle.terminate()
      }, opts.timeoutMs)
      : undefined
    this.timer?.unref?.()

    if (opts.signal) {
      opts.signal.addEventListener("abort", () => {
        this.aborted = true
        handle.terminate()
      }, { once: true })
    }
  }

  private stderrView(handle: SubprocessHandle): OutputStream {
    return {
      readFrom: (fromByte: number) => {
        if (this.providerFailure !== undefined) {
          const note = Buffer.from(this.providerFailure.note, "utf8")
          return {
            text: note.subarray(Math.min(fromByte, note.length)).toString("utf8"),
            nextOffset: note.length,
            lossy: false,
          }
        }
        return handle.collected.stderr?.readFrom(fromByte) ?? { text: "", nextOffset: fromByte, lossy: false }
      },
      get text() {
        return handle.collected.stderr?.text ?? ""
      },
      get lossy() {
        return handle.collected.stderr?.lossy === true
      },
      get bytes() {
        return handle.collected.stderr?.bytes ?? 0
      },
    }
  }

  readOutput(): { delta: string; lossy: boolean } {
    const out = this.handle.collected.stdout?.readFrom(this.stdoutOffset)
    const err = this.handle.collected.stderr?.readFrom(this.stderrOffset)
    if (out !== undefined) this.stdoutOffset = out.nextOffset
    if (err !== undefined) this.stderrOffset = err.nextOffset
    const outText = out?.text ?? ""
    const errText = err?.text ?? ""
    const separator = outText.length > 0 && !outText.endsWith("\n") ? "\n" : ""
    return {
      delta: outText + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
      lossy: out?.lossy === true || err?.lossy === true,
    }
  }

  kill(): boolean {
    if (this.status !== "running") return false
    this.status = "killed"
    this.handle.terminate()
    return true
  }

  result(): Promise<ShellRunResult> {
    return this.done.then(() => {
      if (this.providerFailure !== undefined) throw this.providerFailure.error
      const stdout = this.handle.collected.stdout?.readFrom(0)
      const stderr = this.handle.collected.stderr?.readFrom(0)
      return {
        exitCode: this.exitCode,
        signal: this.signal,
        timedOut: this.timedOut,
        aborted: this.aborted,
        timeoutMs: this.timeoutMs,
        stdout: { text: stdout?.text ?? "", truncated: stdout?.lossy === true },
        stderr: { text: stderr?.text ?? "", truncated: stderr?.lossy === true },
      }
    })
  }

  get closed(): boolean {
    return this.status !== "running"
  }
}

export class DockerShellExecutor extends ShellExecutor {
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: ShellDeps,
  ) {
    super(ctx, "shell")
  }

  private readonly shellArgvCache = new Map<string, string[]>()

  resolve(spec: ShellExecSpec): ShellExecSpec {
    const config = this.deps.config
    const timeoutMs = Math.max(0, Math.min(spec.timeoutMs ?? config.timeoutMs.get(), config.maxTimeoutMs.get()))
    const filled = {
      ...spec,
      timeoutMs,
      onExpiry: spec.onExpiry ?? "kill",
      maxOutputBytes: spec.maxOutputBytes ?? config.maxOutputBytes.get(),
    }
    if (typeof spec.sandboxSession === "string" && spec.sandboxSession !== ""
      && typeof spec.container === "string" && spec.container !== "") {
      const workspace = typeof spec.sandboxWorkspace === "string" && spec.sandboxWorkspace !== ""
        ? spec.sandboxWorkspace
        : this.deps.config.workspaceRoot
      const requested = typeof spec.workdir === "string" && spec.workdir !== "" ? spec.workdir : spec.cwd
      return { ...filled, cwd: requested ?? this.deps.paths.containerRoot(workspace) }
    }
    const session = resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    const requested = spec.workdir ?? spec.cwd
    const cwd = requested === undefined
      ? this.deps.paths.containerRoot(session.workspace)
      : this.deps.paths.toContainer(requested, session.workspace)
    return {
      ...filled,
      cwd,
      container: session.container,
      sandboxSession: session.sessionId,
      sandboxWorkspace: session.workspace,
      sandboxShared: session.shared,
    }
  }

  async execute(spec: ShellExecSpec): Promise<ShellProcess> {
    const config = this.deps.config
    const resolved = this.resolve(spec)
    const sessionId = String(resolved.sandboxSession ?? "")
    const container = String(resolved.container ?? "")
    if (sessionId === "" || container === "") {
      throw new SandboxSessionError(
        "this shell request names no sandbox conversation; resolve it through this executor before executing it",
        "NO_SESSION",
      )
    }
    const target: SandboxTarget = {
      sessionId,
      container,
      workspace: String(resolved.sandboxWorkspace ?? config.workspaceRoot),
      shared: resolved.sandboxShared === true,
    }
    const timeoutMs = Math.max(0, Math.min(resolved.timeoutMs ?? config.timeoutMs.get(), config.maxTimeoutMs.get()))
    if (config.pwshGuard && looksLikePowerShell(String(resolved.command ?? ""))) {
      return rejectedProcess(POWERSHELL_REJECTION, timeoutMs, {
        container: target.container,
        image: config.image.get(),
        workspace: target.workspace,
        rejected: "powershell",
      })
    }

    await this.deps.provisioner.ensure(target, { signal: resolved.signal })

    const maxOutputBytes = resolved.maxOutputBytes ?? config.maxOutputBytes.get()
    const handle = this.deps.subprocess.spawn({
      argv: [...(await this.shellArgvFor(target)), String(resolved.command)],
      cwd: resolved.cwd,
      env: resolved.env,
      graceMs: resolved.graceMs ?? config.graceMs.get(),
      signal: resolved.signal,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: maxOutputBytes },
        stderr: { maxBytes: maxOutputBytes },
      },
    })

    return new ContainerShellProcess(handle, target, config.image.get(), {
      timeoutMs,
      armTimeout: (resolved.onExpiry ?? "kill") === "kill",
      signal: resolved.signal,
    })
  }

  private async shellArgvFor(target: SandboxTarget): Promise<string[]> {
    const cached = this.shellArgvCache.get(target.container)
    if (cached !== undefined) return cached
    let argv = this.deps.config.shellArgv
    try {
      const probe = await this.deps.transport.exec([
        "exec",
        target.container,
        "sh",
        "-c",
        "command -v bash >/dev/null 2>&1 && echo yes || echo no",
      ])
      if (probe.stdout.toString().trim() === "yes") argv = ["/bin/bash", "-lc"]
    } catch {
    }
    this.shellArgvCache.set(target.container, argv)
    return argv
  }

  override get sandboxMode(): string | undefined {
    return "docker-container"
  }
}

export type { ShellExecutor }
