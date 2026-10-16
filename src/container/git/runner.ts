import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

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

interface HardenedInvocation {
  args: string[]
  env: NodeJS.ProcessEnv
}

let emptyHooks: string | undefined

// An empty hooksPath disables the repository's own hooks for plugin-driven git
// operations; the container still runs its hooks inside the container.
function emptyHooksDir(): string {
  if (emptyHooks === undefined) {
    emptyHooks = join(tmpdir(), "dsh-docker-sandbox-empty-hooks")
    mkdirSync(emptyHooks, { recursive: true })
  }
  return emptyHooks
}

// The container holds a read-write bind mount of the host repository's .git, so a
// model-authored hook or config key would otherwise run as the operator the next time
// the plugin drives git on the host; command-line -c outranks every config file.
function gitHardening(credentialHelpers: () => string[]): HardenedInvocation {
  const overrides: [string, string][] = [
    ["core.hooksPath", emptyHooksDir()],
    ["core.fsmonitor", "false"],
    ["core.pager", "cat"],
    ["sequence.editor", "true"],
    ["core.editor", "true"],
    ["protocol.ext.allow", "never"],
    ["core.sshCommand", "ssh"], // pinned, not cleared: the operator's global value still applies
    ["core.askPass", ""],
    ["credential.helper", ""],
  ]
  const args = overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`])
  // after the clearing entry above, which resets the whole helper list
  for (const helper of credentialHelpers()) args.push("-c", `credential.helper=${helper}`)
  return {
    args,
    // GIT_ALLOW_PROTOCOL only takes effect from the environment: it outranks
    // protocol.* in every config file, so a repo cannot widen it back open.
    env: {
      ...process.env,
      GIT_ALLOW_PROTOCOL: "https:ssh:file",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_MERGE_AUTOEDIT: "no",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
    },
  }
}

const HELPER_PROBE_MS = 5000

let operatorHelpers: string[] | undefined

// Unhardened on purpose: it has to see the repo-level helpers in order to drop them.
function probeCredentialHelpers(argv0: string, rest: string[]): string {
  const result = spawnSync(argv0, [...rest, "config", "--show-scope", "--get-all", "credential.helper"], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
    timeout: HELPER_PROBE_MS,
    maxBuffer: MAX_CAPTURE,
  })
  return result.error === undefined && result.status === 0 ? result.stdout ?? "" : ""
}

// Clearing credential.helper also drops the operator's own helpers, so the system and
// global ones are re-appended behind the clear; local and worktree values stay blocked.
function operatorCredentialHelpers(probe: () => string): string[] {
  if (operatorHelpers === undefined) {
    const kept: string[] = []
    for (const line of probe().split(/\r?\n/)) {
      const value = /^(?:system|global|user)\t(.*)$/.exec(line)?.[1]
      if (value !== undefined && value !== "") kept.push(value)
    }
    operatorHelpers = kept
  }
  return operatorHelpers
}

// gh rejects -c, so its internal git calls are steered through env config,
// which outranks config files the same way the command line does.
function ghHardening(): HardenedInvocation {
  const config: [string, string][] = [
    ["core.hooksPath", emptyHooksDir()],
    ["core.fsmonitor", "false"],
    ["protocol.ext.allow", "never"],
    ["core.pager", "cat"],
  ]
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_ALLOW_PROTOCOL: "https:ssh:file" }
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  env.GIT_CONFIG_COUNT = String(config.length)
  return { args: [], env }
}

const GUARDED_COMMANDS = new Set(["add", "checkout", "commit", "fetch", "merge", "push", "status", "worktree"])

interface ConfigEntry {
  key: string
  value: string
}

function configValue(raw: string): string {
  let out = ""
  let quote: string | undefined
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!
    if (char === "\\") {
      const escaped = raw[++index]
      out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped ?? ""
      continue
    }
    if (quote === undefined && (char === ";" || char === "#")) break
    if (char === '"' || char === "'") {
      if (quote === undefined) quote = char
      else if (quote === char) quote = undefined
      continue
    }
    out += char
  }
  return out.trim()
}

function parseGitConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  let section = ""
  let subsection = ""
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue
    if (line.startsWith("[")) {
      const header = /^\[\s*([^\s"\]]+)(?:\s+"([^"]*)")?\s*\]/.exec(line)
      section = header?.[1]?.toLowerCase() ?? ""
      subsection = header?.[2]?.toLowerCase() ?? ""
      continue
    }
    const split = line.indexOf("=")
    const name = (split === -1 ? line : line.slice(0, split)).trim().toLowerCase()
    if (section === "" || name === "") continue
    entries.push({
      key: subsection === "" ? `${section}.${name}` : `${section}.${subsection}.${name}`,
      value: split === -1 ? "" : configValue(line.slice(split + 1)),
    })
  }
  return entries
}

function namedAttributeFilters(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(/\bfilter=(?:"([^"]+)"|(\S+))/g)) names.add(match[1] ?? match[2] ?? "")
  }
  return names
}

// The container can rewrite <gitDir>/config and <gitDir>/info/attributes. Fixed-name keys are
// pinned by the -c prefix; these three survive because -c cannot outrank them — filter and alias
// names are attacker-chosen, and an included file is never read. A !-valued filter runs on the
// host during add, merge and checkout, so it aborts the call instead; git-lfs does not use !.
function tamperReason(entries: ConfigEntry[], filters: Set<string>): string | undefined {
  for (const { key, value } of entries) {
    if (/^filter\.[^.]+\.(clean|smudge|process|required)$/.test(key) && value.startsWith("!")) {
      const name = key.slice("filter.".length, key.lastIndexOf("."))
      return filters.has(name)
        ? `${key} is a shell command and info/attributes names filter "${name}"`
        : `${key} is a shell command`
    }
    if (key.startsWith("alias.") && value.startsWith("!")) return `${key} is a shell command`
    if (key === "include.path" || key === "include.if") return `${key} pulls in another config file`
  }
  return undefined
}

function gitDirOf(cwd: string): string | undefined {
  const dotGit = join(cwd, ".git")
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]
    return link === undefined ? undefined : resolve(cwd, link.trim())
  } catch {
    return undefined
  }
}

const tamperCache = new Map<string, { stamp: string; reason: string | undefined }>()

function repoTamperReason(cwd: string): string | undefined {
  const gitDir = gitDirOf(cwd)
  if (gitDir === undefined) return undefined
  const dirs = [gitDir]
  try {
    dirs.push(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()))
  } catch {
    // a plain repository has no commondir file
  }
  const files = dirs.flatMap((dir) => [join(dir, "config"), join(dir, "config.worktree"), join(dir, "info", "attributes")])
  let stamp = gitDir
  for (const file of files) {
    try {
      const stat = statSync(file)
      stamp += `|${file}=${stat.mtimeMs}:${stat.size}`
    } catch {
      stamp += `|${file}=absent`
    }
  }
  const cached = tamperCache.get(cwd)
  if (cached !== undefined && cached.stamp === stamp) return cached.reason
  const entries: ConfigEntry[] = []
  const filters = new Set<string>()
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    if (file.endsWith("attributes")) for (const name of namedAttributeFilters(text)) filters.add(name)
    else entries.push(...parseGitConfig(text))
  }
  const reason = tamperReason(entries, filters)
  tamperCache.set(cwd, { stamp, reason })
  return reason
}

export function createCliRunner(baseArgv: string[], label: "git" | "gh"): CliRunner {
  const [argv0 = label, ...rest] = baseArgv
  const codes = CODES[label]
  const credentialHelpers = (): string[] => operatorCredentialHelpers(() => probeCredentialHelpers(argv0, rest))
  const hardening = label === "git" ? () => gitHardening(credentialHelpers) : ghHardening

  // A tampered config is refused rather than run: the pinned -c overrides stop
  // the known keys, but a filter has no pin, so worktree-touching commands check
  // the files the container can write before git sees them.
  const refusal = (args: string[], cwd: string | undefined): CliCommandError | undefined => {
    if (label !== "git" || !GUARDED_COMMANDS.has(args[0] ?? "")) return undefined
    const reason = repoTamperReason(cwd ?? process.cwd())
    return reason === undefined ? undefined : new CliCommandError(`git ${args[0]} refused: ${reason}`, codes.failed)
  }

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
      const blocked = refusal(args, opts.cwd)
      if (blocked !== undefined) throw blocked
      const hardened = hardening()
      const result = spawnSync(argv0, [...rest, ...hardened.args, ...args], {
        cwd: opts.cwd,
        env: hardened.env,
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
      const blocked = refusal(args, opts.cwd)
      if (blocked !== undefined) return Promise.reject(blocked)
      return new Promise<CliResult>((resolve, reject) => {
        const hardened = hardening()
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(argv0, [...rest, ...hardened.args, ...args], {
            cwd: opts.cwd,
            env: hardened.env,
            windowsHide: true,
          })
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
