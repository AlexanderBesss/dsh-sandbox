import type { SandboxConfig } from "../config.ts"
import type { LiveAgent, SubagentResult, SubagentService } from "../context.ts"
import type { BootstrapLogger } from "./bootstrap.ts"
import type { CliRunner } from "./git.ts"
import type { PullRequestFacts } from "./pr-description.ts"
import { forkPointFor } from "./review.ts"
import { titleSlugFor } from "./session.ts"

export const BRIEF_DIFF_CHARS = 40_000

export const MAX_BRIEF_BULLETS = 8
export const MAX_BRIEF_BULLET_CHARS = 200

export const MAX_BRANCH_SLUG_CHARS = 40

const SETTLE_GRACE_MS = 15000

export interface PullRequestBrief {
  branchSlug?: string
  title?: string
  bullets: string[]
}

export type BriefOutcome = { brief: PullRequestBrief } | { error: string }

export type PrBrief = (sessionId: string, facts: PullRequestFacts) => Promise<BriefOutcome>

export interface PrBriefDeps {
  subagents: () => SubagentService | undefined
  parentFor: (sessionId: string) => LiveAgent | undefined
  git: CliRunner
  config: SandboxConfig
  logger?: BootstrapLogger
}

async function gitText(git: CliRunner, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  try {
    return (await git.run(args, { cwd, timeoutMs })).stdout.trim()
  } catch {
    return ""
  }
}

export function buildBriefPrompt(facts: PullRequestFacts, diff: string): string {
  const clipped = diff.length > BRIEF_DIFF_CHARS
    ? `${diff.slice(0, BRIEF_DIFF_CHARS).trimEnd()}\n… (truncated — run \`git diff\` for the rest)`
    : diff
  return [
    "You are naming a git branch and writing the summary of the pull request it",
    "becomes. A program parses your answer, so anything outside the format is lost.",
    "",
    "ANSWER IN EXACTLY THIS SHAPE, IN THIS ORDER, NOTHING ELSE:",
    "",
    "BRANCH: <3 to 5 words, kebab-case, ascii letters digits and hyphens only>",
    "TITLE: <one line under 80 characters, what a reviewer would call this change>",
    "- <bullet>",
    "- <bullet>",
    "… 3 to 6 bullets in total",
    "",
    `Branch \`${facts.branch}\` currently carries the work of one sandboxed conversation,`,
    `forked from ${facts.base === undefined ? "the main checkout's HEAD" : `commit \`${facts.base}\``}.`,
    "Nobody wrote its name or its description.",
    "",
    "COMMITS ON THE BRANCH (git log --oneline):",
    facts.log === "" ? "(none)" : facts.log,
    "",
    "FILES CHANGED (git diff --stat):",
    facts.stat === "" ? "(none)" : facts.stat,
    "",
    `DIFF (every staged change against the fork point, first ${BRIEF_DIFF_CHARS} characters):`,
    clipped === "" ? "(empty — nothing is staged)" : clipped,
    "",
    "You have tools in this container: `git diff`, `git log`, `git show`, `rg`, and file",
    "reads under /workspace all work. Use them for anything the diff above does not",
    "settle — a caller you are unsure about, a test you want to confirm — before you answer.",
    "Everything the conversation changed is already staged, so the diff above is the whole",
    "change; new files are in it.",
    "",
    "Do not modify anything — this is naming and summary only. The worktree is committed",
    "and pushed as soon as you answer, and an edit you make would be left out of it.",
    "",
    "BRANCH:",
    "- Names the change, not the conversation: `refuse-turn-when-engine-down`, not",
    "  `session-3`, `update-files`, or `fix-stuff`.",
    "- Lowercase words separated by single hyphens, no slashes, no issue numbers, no dates.",
    "TITLE:",
    "- Plain language, one sentence fragment, no trailing period, no ticket prefix.",
    "- Says what the change does; it is the line at the top of the pull-request list.",
    "BULLETS:",
    "- Each states WHAT changed and why it matters to a reviewer. \"Refuse the turn when",
    "  the Docker engine is down, so a worktree session cannot edit the host checkout\"",
    "  beats \"updated engine-gate.ts\".",
    "- Name the behavior, not the file. Name a file only when the file is the change (a",
    "  new module, a deleted script, a lockfile).",
    "- Cover every independent change in the diff. Never merge two unrelated changes into",
    "  one bullet, and never state the same change twice.",
    "- Say what the change does NOT cover when a reviewer would otherwise assume it does:",
    "  no tests, no migration, no docs, a known gap.",
    "- Write nothing you cannot point at in the diff. No speculation about intent, no",
    "  \"should\", no recommendations, no risk warnings, no praise.",
    "- No headings, no numbering, no closing paragraph, no emoji, no code blocks, no",
    "  file:line references, no quoting diff lines. Under 200 characters each.",
  ].join("\n")
}

function clipBullet(text: string): string {
  if (text.length <= MAX_BRIEF_BULLET_CHARS) return text
  const cut = text.slice(0, MAX_BRIEF_BULLET_CHARS)
  const space = cut.lastIndexOf(" ")
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function isDiffEcho(body: string): boolean {
  return /^[-+]/.test(body) || /^(@@|diff --git|index [0-9a-f]{6,})/.test(body)
}

export function parseBrief(text: string): PullRequestBrief | undefined {
  const lines = text.replace(/^[ \t]*```[^\n]*$/gm, "").split(/\r?\n/)
  let branchSlug: string | undefined
  let title: string | undefined
  const bullets: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    const branch = /^BRANCH:\s*(.+)$/i.exec(line)
    if (branch !== null && branchSlug === undefined) {
      const slug = titleSlugFor(branch[1] ?? "").slice(0, MAX_BRANCH_SLUG_CHARS).replace(/-+$/g, "")
      if (slug !== "") branchSlug = slug
      continue
    }
    const titled = /^TITLE:\s*(.+)$/i.exec(line)
    if (titled !== null && title === undefined) {
      const candidate = (titled[1] ?? "").replace(/[.]+$/, "").trim()
      if (candidate !== "") title = candidate.slice(0, 100)
      continue
    }
    const bullet = /^[-*•][ \t]+(.*)$/.exec(line)
    if (bullet !== null) {
      const body = (bullet[1] ?? "").trim()
      if (body !== "" && !isDiffEcho(body)) {
        bullets.push(clipBullet(body))
        if (bullets.length >= MAX_BRIEF_BULLETS) break
      }
    }
  }
  if (bullets.length === 0) return undefined
  return {
    bullets,
    ...(branchSlug === undefined ? {} : { branchSlug }),
    ...(title === undefined ? {} : { title }),
  }
}

function stopReasonText(reason: string): string {
  switch (reason) {
    case "aborted": return "was stopped before it finished"
    case "max-tokens": return "ran out of room before it finished"
    case "refusal": return "declined the task"
    case "error": return "failed before it finished"
    default: return `ended (${reason}) without an answer`
  }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createPrBrief(deps: PrBriefDeps): PrBrief {
  const fallback = "the branch keeps its current name and the description lists its commits only"
  return async (sessionId, facts) => {
    const subagents = deps.subagents()
    if (subagents === undefined) return { error: `the subagent service is not available, so ${fallback}` }
    const provider = subagents.list()[0]
    if (provider === undefined) return { error: `no subagent provider is registered, so ${fallback}` }
    const parent = deps.parentFor(sessionId)
    if (parent === undefined) return { error: `this session has no live agent to delegate to, so ${fallback}` }

    const budgetMs = deps.config.prBriefTimeoutMs
    const deadline = Date.now() + budgetMs
    const left = () => Math.max(deadline - Date.now(), 1)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budgetMs)
    try {
      const base = facts.base ?? await forkPointFor(deps.git, facts, left())
      const diff = await gitText(
        deps.git,
        base === undefined ? ["diff", "HEAD"] : ["diff", base],
        facts.worktreePath,
        left(),
      )
      const prompt = buildBriefPrompt({ ...facts, ...(base === undefined ? {} : { base }) }, diff)

      const started = subagents.start(provider, {
        prompt: [{ type: "text", text: prompt }],
        parent,
        signal: controller.signal,
        label: "pull request brief",
      })
      const run = await within(started, left())
      if (run === undefined) {
        void started.then((late) => { void late.dispose?.() }, () => undefined)
        return { error: `the naming subagent could not be started within ${budgetMs} ms, so ${fallback}` }
      }
      let result: SubagentResult | undefined
      try {
        result = await within(run.result, left() + Math.min(SETTLE_GRACE_MS, budgetMs))
      } catch {
        result = undefined
      }
      try {
        await run.dispose?.()
      } catch {
      }
      if (result === undefined) {
        return { error: `the naming subagent did not answer within ${budgetMs} ms, so ${fallback}` }
      }
      if (result.stopReason !== "completed") {
        return { error: `the naming subagent ${stopReasonText(result.stopReason)}, so ${fallback}` }
      }
      const parts: string[] = []
      for (const block of result.output) {
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text)
      }
      const brief = parseBrief(parts.join("\n"))
      if (brief === undefined) {
        return { error: `the naming subagent answered in a shape that could not be read, so ${fallback}` }
      }
      deps.logger?.info?.(
        `dsh-docker-sandbox: pull request brief for session ${sessionId}: `
        + `branch ${brief.branchSlug ?? "(kept)"}, ${brief.bullets.length} bullet(s)`,
      )
      return { brief }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { error: `the naming subagent could not start: ${detail}, so ${fallback}` }
    } finally {
      clearTimeout(timer)
    }
  }
}
