import { join } from "node:path"
import { homedir } from "node:os"
import Schema from "@deepseek-ai/schemastery"

export const Config = Schema.object({
  dockerArgv: Schema.array(Schema.string()).default(["docker"]),

  image: Schema.string().default("node:24").volatile(),

  command: Schema.array(Schema.string()).default(["sleep", "infinity"]),

  mountMode: Schema.union([Schema.const("workspace"), Schema.const("drives")]).default("workspace"),

  containerWorkspace: Schema.string().default("/workspace"),

  workspaceRoot: Schema.string().default(process.cwd()),

  allowAgentless: Schema.boolean().default(false),

  provisionTimeoutMs: Schema.number().min(1000).default(120000),

  timeoutMs: Schema.number().min(0).default(120000).volatile(),

  maxTimeoutMs: Schema.number().min(0).default(600000).volatile(),

  maxOutputBytes: Schema.number().min(0).default(64000).volatile(),

  graceMs: Schema.number().min(0).default(3000).volatile(),

  shellArgv: Schema.array(Schema.string()).default(["/bin/sh", "-lc"]),
  pwshGuard: Schema.boolean().default(true).description(
    "reject PowerShell commands (the Pwsh tool's cmdlets cannot run in a Linux container) with a redirect to the Bash tool, instead of letting the container's shell answer 127",
  ),

  bootstrapTools: Schema.boolean().default(true),

  ripgrepSource: Schema.union([
    Schema.const("package"),
    Schema.const("url"),
    Schema.const("none"),
  ]).default("package"),

  bootstrapPlaywright: Schema.boolean().default(true).description(
    "install the Playwright CLI and browsers into the container on first use; skipped when the image already carries them or has no npm",
  ),

  playwrightBrowsers: Schema.array(
    Schema.union([Schema.const("chromium"), Schema.const("firefox"), Schema.const("webkit")]),
  ).default(["chromium"]),

  playwrightVersion: Schema.string().default("1.64.1").description(
    "npm version pinned for the bootstrap install, so containers provisioned months apart match; empty installs the latest",
  ),

  playwrightInstallTimeoutMs: Schema.number().min(1000).default(600000),

  idleTtlMs: Schema.number().min(0).default(7200000).volatile(),

  gcIntervalMs: Schema.number().min(1000).default(60000),

  terminalPty: Schema.boolean().default(false),

  resourceLimits: Schema.object({
    cpu: Schema.string().default("").volatile(),
    memory: Schema.string().default("").volatile(),
    memorySwap: Schema.string().default("").volatile(),
  }).default({ cpu: "", memory: "", memorySwap: "" }),

  gcOnUnload: Schema.boolean().default(false),

  worktree: Schema.boolean().default(false).volatile(),

  worktreeRoot: Schema.string().default("").volatile(),

  worktreeBranchPrefix: Schema.string().default("dsh-sbx/"),

  worktreeSync: Schema.boolean().default(true).volatile(),

  worktreeSyncIntervalMs: Schema.number().min(1000).default(300000),

  npmCacheHost: Schema.string().default(join(homedir(), ".dsh-docker-sandbox", "npm-cache")),

  worktreeInstall: Schema.boolean().default(true).volatile(),

  warmInstallTimeoutMs: Schema.number().min(1000).default(600000),

  prBrief: Schema.boolean().default(true).volatile(),

  prBriefTimeoutMs: Schema.number().min(1000).default(120000),

  gitArgv: Schema.array(Schema.string()).default(["git"]),

  ghArgv: Schema.array(Schema.string()).default(["gh"]),
})

export type SandboxConfig = typeof Config extends Schema<any, infer T, any> ? T : never
