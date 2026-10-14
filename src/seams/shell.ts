import type { SandboxContext } from "../context.ts"
import { ShellExecutor, type ShellExecSpec, type ShellProcess } from "@deepseek-ai/dsh-shell"
import type { SandboxConfig } from "../config.ts"
import type { PathMapper } from "../container/paths.ts"
import type { Provisioner } from "../container/provisioner.ts"
import { resolveTarget, SandboxSessionError, type SandboxTarget } from "../container/session.ts"
import type { DockerTransport } from "../container/transport.ts"
import type { DockerSubprocessRuntime } from "./subprocess.ts"
import type { WorktreeManager } from "../container/worktrees.ts"
import { ContainerShellProcess, POWERSHELL_REJECTION, rejectedProcess } from "./shell/process.ts"

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

export class DockerShellExecutor extends ShellExecutor {
  protected declare ctx: SandboxContext

  constructor(
    ctx: SandboxContext,
    private readonly deps: ShellDeps,
  ) {
    super(ctx, "shell")
  }

  private readonly shellArgvCache = new Map<string, string[]>()

  private clampTimeout(timeoutMs: number | undefined): number {
    const config = this.deps.config
    return Math.max(0, Math.min(timeoutMs ?? config.timeoutMs.get(), config.maxTimeoutMs.get()))
  }

  resolve(spec: ShellExecSpec): ShellExecSpec {
    const config = this.deps.config
    const timeoutMs = this.clampTimeout(spec.timeoutMs)
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
    const timeoutMs = this.clampTimeout(resolved.timeoutMs)
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
