import { join } from "node:path"
import { homedir } from "node:os"
import Schema from "@deepseek-ai/schemastery"

export const Config = Schema.object({
  // docker.exe is a native Windows binary spawned directly; set a full path if it is not on the service PATH
  dockerArgv: Schema.array(Schema.string()).default(["docker"]),

  // volatile: applies to the next container the chat provisions
  image: Schema.string().default("alpine:3.20").volatile(),

  // keep-alive entrypoint: the container lives as long as this process runs
  command: Schema.array(Schema.string()).default(["sleep", "infinity"]),

  // `drives` mounts every Windows drive root at /<drive-letter>, keeping path mapping lossless outside the workspace
  mountMode: Schema.union([Schema.const("workspace"), Schema.const("drives")]).default("workspace"),

  containerWorkspace: Schema.string().default("/workspace"),

  workspaceRoot: Schema.string().default(process.cwd()),

  // off by default: a call that cannot name its chat should say so rather than pick a container
  allowAgentless: Schema.boolean().default(false),

  // covers the image pull too
  provisionTimeoutMs: Schema.number().min(1000).default(120000),

  timeoutMs: Schema.number().min(0).default(120000).volatile(),

  maxTimeoutMs: Schema.number().min(0).default(600000).volatile(),

  maxOutputBytes: Schema.number().min(0).default(64000).volatile(),

  // SIGTERM → SIGKILL escalation grace
  graceMs: Schema.number().min(0).default(3000).volatile(),

  shellArgv: Schema.array(Schema.string()).default(["/bin/sh", "-lc"]),
  pwshGuard: Schema.boolean().default(true).description(
    "reject PowerShell commands (the Pwsh tool's cmdlets cannot run in a Linux container) with a redirect to the Bash tool, instead of letting the container's shell answer 127",
  ),

  // installs `rg` so `glob` / `grep` work
  bootstrapTools: Schema.boolean().default(true),

  // `package` uses the image's package manager, `url` downloads a static musl build, `none` leaves search disabled
  ripgrepSource: Schema.union([
    Schema.const("package"),
    Schema.const("url"),
    Schema.const("none"),
  ]).default("package"),

  idleTtlMs: Schema.number().min(0).default(7200000).volatile(),

  // min(1000): a zero or tiny interval turns the sweep into a busy loop of `docker ps` calls
  gcIntervalMs: Schema.number().min(1000).default(60000),

  // off by default: the marker protocol works without a PTY, and a TTY on a Windows pipe rewrites line endings
  terminalPty: Schema.boolean().default(false),

  // engine --cpus/--memory/--memory-swap; empty leaves the limit unset; memorySwap == memory makes the RAM cap absolute
  resourceLimits: Schema.object({
    cpu: Schema.string().default("").volatile(),
    memory: Schema.string().default("").volatile(),
    memorySwap: Schema.string().default("").volatile(),
  }).default({ cpu: "", memory: "", memorySwap: "" }),

  gcOnUnload: Schema.boolean().default(false),

  // volatile: a running container keeps its mount until recreated, so the shell lags until archive or idle TTL
  worktree: Schema.boolean().default(false).volatile(),

  // empty: a sibling `<repoRoot>.worktrees/` next to each checkout; set: a root, one subdirectory per repository
  worktreeRoot: Schema.string().default("").volatile(),

  // needs a valid git branch namespace: no spaces, `..`, `~`, `^`, `:`, `?`, `*`, `[`, no trailing `/` or `.`
  worktreeBranchPrefix: Schema.string().default("dsh-sbx/"),

  // bind-mounted at /root/.npm in every container; assumes the image runs npm as root (the node images do)
  npmCacheHost: Schema.string().default(join(homedir(), ".dsh-docker-sandbox", "npm-cache")),

  // gated to worktree sessions: a shared checkout would get Linux binaries in place of the host's node_modules
  worktreeInstall: Schema.boolean().default(true).volatile(),

  warmInstallTimeoutMs: Schema.number().min(1000).default(600000),

  prBrief: Schema.boolean().default(true).volatile(),

  // one deadline for the whole naming pass (git probes, delegation, child answer); the merge request blocks
  prBriefTimeoutMs: Schema.number().min(1000).default(120000),

  // host git for worktree bookkeeping: the workspace is host files, so this never goes through a container
  gitArgv: Schema.array(Schema.string()).default(["git"]),

  ghArgv: Schema.array(Schema.string()).default(["gh"]),
})

export type SandboxConfig = typeof Config extends Schema<any, infer T, any> ? T : never
