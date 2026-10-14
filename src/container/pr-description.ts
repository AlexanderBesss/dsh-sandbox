export const MAX_BODY_CHARS = 20_000

const TITLE_MAX = 100

const LOG_MAX = 4_000

export interface PullRequestFacts {
  branch: string
  worktreePath: string
  mainWorkspace: string
  base?: string
  log: string
  stat: string
  title?: string
  summary?: string[]
  briefTitle?: string
}

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max).trimEnd()}\n… (truncated)`
}

export function prTitleFor(facts: Pick<PullRequestFacts, "title" | "branch" | "briefTitle">): string {
  const proposed = facts.briefTitle?.trim()
  if (proposed !== undefined && proposed !== "") return proposed.slice(0, TITLE_MAX)
  const title = facts.title?.trim()
  if (title !== undefined && title !== "") return title.slice(0, TITLE_MAX)
  const leaf = facts.branch.split("/").pop() ?? facts.branch
  if (/^session[-_]/.test(leaf)) return facts.branch
  const words = leaf
    .replace(/-[0-9a-f]{6,}$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
  if (words === "") return facts.branch
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

export function prBodyFor(facts: PullRequestFacts): string {
  const log = clip(facts.log, LOG_MAX)
  const commits = log === "" ? 0 : log.split("\n").length
  const lines = [
    ...(facts.summary === undefined || facts.summary.length === 0
      ? []
      : ["## Summary", "", ...facts.summary.map((line) => `- ${line}`), ""]),
    `## Commits (${commits})`,
    "",
    "```",
    log === "" ? "(none)" : log,
    "```",
    "",
  ]
  const body = lines.join("\n")
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS).trimEnd()}\n… (truncated)`
}
