// every command runs in the initiating chat's own container: one chat's cd/commit/install cannot touch another chat's files

import type { SandboxContext } from "../context.ts"
import { ShellExecutor, type ShellExecSpec, type ShellProcess } from "@deepseek-ai/dsh-shell"
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

// the app's Pwsh tool feeds PowerShell text straight to this seam; the markers match only PowerShell syntax, never POSIX
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

// shaped exactly like the real handle so the tool layer renders it as a completed 127 run
function rejectedProcess(message: string, timeoutMs: number, details: Record<string, unknown>): unknown {
  const reader = (text: string) => ({
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
  })
  const stderr = reader(message)
  const stdout = reader("")
  return {
    status: "completed",
    exitCode: 127,
    signal: null,
    observed: { stdout, stderr },
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

export class DockerShellExecutor extends ShellExecutor {
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: ShellDeps,
  ) {
    super(ctx, "shell")
  }

  private readonly shellArgvCache = new Map<string, string[]>()

  // the target is stamped here: execute can run after the initiating agent's async chain has moved on
  // the filled spec must be complete: shipped tools read timeoutMs back and the jobs registry rejects an undefined deadline
  resolve(spec: ShellExecSpec): ShellExecSpec {
    const config = this.deps.config
    // the clamped deadline is what the result echoes back, so a capped budget is visible rather than silent
    const timeoutMs = Math.max(0, Math.min(spec.timeoutMs ?? config.timeoutMs.get(), config.maxTimeoutMs.get()))
    const filled = {
      ...spec,
      timeoutMs,
      onExpiry: spec.onExpiry ?? "kill",
      maxOutputBytes: spec.maxOutputBytes ?? config.maxOutputBytes.get(),
    }
    // a stamped spec carries its own target; re-resolving would re-route it to the shared container or fail it agentlessly
    if (typeof spec.sandboxSession === "string" && spec.sandboxSession !== ""
      && typeof spec.container === "string" && spec.container !== "") {
      const workspace = typeof spec.sandboxWorkspace === "string" && spec.sandboxWorkspace !== ""
        ? spec.sandboxWorkspace
        : this.deps.config.workspaceRoot
      const requested = typeof spec.workdir === "string" && spec.workdir !== "" ? spec.workdir : spec.cwd
      return { ...filled, cwd: requested ?? this.deps.paths.containerRoot(workspace) }
    }
    const session = resolveTarget(this.ctx, this.deps.config, this.deps.worktrees)
    // shipped shell tools name the directory workdir; cwd is kept for direct callers
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
    // guard before provisioning: a PowerShell command could never run in this container
    if (config.pwshGuard && looksLikePowerShell(String(resolved.command ?? ""))) {
      return rejectedProcess(POWERSHELL_REJECTION, timeoutMs, {
        container: target.container,
        image: config.image.get(),
        workspace: target.workspace,
        rejected: "powershell",
      }) as unknown as ShellProcess
    }

    await this.deps.provisioner.ensure(target, { signal: resolved.signal })

    const maxOutputBytes = resolved.maxOutputBytes ?? config.maxOutputBytes.get()
    const onExpiry = resolved.onExpiry ?? "kill"

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

    let timedOut = false
    let aborted = false
    let providerFailure: { error: unknown; note: string } | undefined
    // one cursor per stream: stdout and stderr are independent byte streams, so a shared cursor re-emits the other's output
    let stdoutOffset = 0
    let stderrOffset = 0

    const timer = timeoutMs > 0 && onExpiry === "kill"
      ? setTimeout(() => {
        timedOut = true
        handle.terminate()
      }, timeoutMs)
      : undefined
    if (timer) timer.unref?.()

    // the shipped job-output pump reads observed.stderr: a provider failure rides that stream, like the local executor
    const observedStderr = {
      readFrom: (fromByte: number) => {
        if (providerFailure !== undefined) {
          const note = Buffer.from(providerFailure.note, "utf8")
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

    const proc = {
      status: "running" as "running" | "completed" | "killed",
      exitCode: null as number | null,
      signal: null as string | null,
      observed: {
        stdout: handle.collected.stdout ?? { readFrom: (fromByte: number) => ({ text: "", nextOffset: fromByte, lossy: false }) },
        stderr: observedStderr,
      },
      // never rejects: a launch failure becomes a killed status with the note on observed.stderr, re-thrown by result()
      done: Promise.resolve().then(() => handle.done).then(
        (outcome) => {
          if (timer) clearTimeout(timer)
          if (proc.status === "running") {
            proc.status = aborted || outcome.killed === true || outcome.signal !== null ? "killed" : "completed"
          }
          proc.exitCode = outcome.exitCode
          proc.signal = outcome.signal
        },
        (error: unknown) => {
          if (timer) clearTimeout(timer)
          proc.status = "killed"
          providerFailure = { error, note: `subprocess failed before reporting an outcome: ${String(error)}` }
        },
      ),
      readOutput: () => {
        const out = handle.collected.stdout?.readFrom(stdoutOffset)
        const err = handle.collected.stderr?.readFrom(stderrOffset)
        if (out !== undefined) stdoutOffset = out.nextOffset
        if (err !== undefined) stderrOffset = err.nextOffset
        const outText = out?.text ?? ""
        const errText = err?.text ?? ""
        const separator = outText.length > 0 && !outText.endsWith("\n") ? "\n" : ""
        return {
          delta: outText + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ""),
          lossy: out?.lossy === true || err?.lossy === true,
        }
      },
      kill: () => {
        if (proc.status !== "running") return false
        proc.status = "killed"
        handle.terminate()
        return true
      },
      result: () => proc.done.then(() => {
        if (providerFailure !== undefined) throw providerFailure.error
        const stdout = handle.collected.stdout?.readFrom(0)
        const stderr = handle.collected.stderr?.readFrom(0)
        return {
          exitCode: proc.exitCode,
          signal: proc.signal,
          // always booleans: the shell tools copy these onto the tool result, and a nested undefined fails its lossless-JSON check
          timedOut,
          aborted,
          timeoutMs,
          stdout: { text: stdout?.text ?? "", truncated: stdout?.lossy === true },
          stderr: { text: stderr?.text ?? "", truncated: stderr?.lossy === true },
        }
      }),
      get closed() {
        return proc.status !== "running"
      },
      details: {
        container: target.container,
        image: config.image.get(),
        workspace: target.workspace,
      },
    }

    // A background handle nobody awaits must not become an unhandled rejection.
    proc.done.catch(() => undefined)

    if (resolved.signal) {
      resolved.signal.addEventListener("abort", () => {
        aborted = true
        handle.terminate()
      }, { once: true })
    }

    return proc as unknown as ShellProcess
  }

  // Debian images ship dash as /bin/sh, which fails ordinary bash syntax; probe for bash once per container and cache
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
      // a failed probe keeps the configured argv; the command itself reports any real problem
    }
    this.shellArgvCache.set(target.container, argv)
    return argv
  }

  override get sandboxMode(): string | undefined {
    return "docker-container"
  }
}

export type { ShellExecutor }
