/**
 * The text a merge request carries.
 *
 * The merge button pushes a branch nobody chose by hand, so the request has to
 * explain itself: what the conversation was about (its title), what the branch
 * actually contains (its commits and its diffstat against the fork point), and
 * where it came from. Everything here is built from git output the plugin has
 * already collected, so the description matches what was pushed rather than a
 * template that says "session work".
 *
 * @module dsh-docker-sandbox/container/pr-description
 */

/** Cap on the generated body; GitHub rejects a body over 64 KiB. */
export const MAX_BODY_CHARS = 20_000

/** Longest title worth sending as a pull-request subject. */
const TITLE_MAX = 100

/** Budgets for the git output embedded in the body. */
const LOG_MAX = 4_000
const STAT_MAX = 6_000

/** The git facts the pull-request text is built from. */
export interface PullRequestFacts {
  /** Conversation the branch belongs to. */
  sessionId: string
  /** The branch that was pushed. */
  branch: string
  /** Host path of the worktree the branch was pushed from. */
  worktreePath: string
  /** Host path of the checkout that worktree was carved from. */
  mainWorkspace: string
  /** Sandbox container the conversation worked in. */
  container: string
  /** Short sha of the fork point, when the branch's base is known. */
  base?: string
  /** `git log --oneline` of the branch's own commits ("" when none). */
  log: string
  /** `git diff --stat` against the fork point ("" when nothing changed). */
  stat: string
  /** True when the button produced the commit itself. */
  committed: boolean
  /** The conversation's title, when the app has one. */
  title?: string
  /**
   * The AI summary of the branch, one bullet per entry, written by the naming
   * subagent. Absent when it was off, unavailable, or refused — which is why the
   * commits and diffstat below are never replaced.
   */
  summary?: string[]
  /**
   * The one-line name the naming subagent proposed. It outranks the chat title,
   * which may be a first message rather than a description of the change.
   */
  briefTitle?: string
}

/** Cut git output to a budget, saying so when it was cut. */
function clip(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  return `${trimmed.slice(0, max).trimEnd()}\n… (truncated)`
}

/**
 * The pull-request title, in order of who knows best: the line the naming pass
 * wrote for this change, then the conversation's own title, then the branch read
 * back as a phrase (`fix-the-login-crash-4a7c1f` becomes "Fix the login crash").
 * A bare session id is the last resort, not the first.
 *
 * @param facts - the facts behind the request (only the names are read).
 * @returns one line of text.
 */
export function prTitleFor(facts: Pick<PullRequestFacts, "title" | "branch" | "briefTitle">): string {
  const proposed = facts.briefTitle?.trim()
  if (proposed !== undefined && proposed !== "") return proposed.slice(0, TITLE_MAX)
  const title = facts.title?.trim()
  if (title !== undefined && title !== "") return title.slice(0, TITLE_MAX)
  const leaf = facts.branch.split("/").pop() ?? facts.branch
  // A branch named after the session id has nothing readable to humanize; the
  // branch itself is the honest title, and the body carries the description.
  if (/^session[-_]/.test(leaf)) return facts.branch
  const words = leaf
    // Drop the uniqueness digest so the phrase ends on a word, not hex.
    .replace(/-[0-9a-f]{6,}$/, "")
    .replace(/[-_]+/g, " ")
    .trim()
  if (words === "") return facts.branch
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/**
 * The pull-request body: what the conversation was, what it changed, and how
 * the request came to exist.
 *
 * @param facts - the collected git facts.
 * @returns markdown within {@link MAX_BODY_CHARS}.
 */
export function prBodyFor(facts: PullRequestFacts): string {
  const log = clip(facts.log, LOG_MAX)
  const stat = clip(facts.stat, STAT_MAX)
  const commits = log === "" ? 0 : log.split("\n").length
  const lines = [
    facts.title === undefined
      ? `Work from the sandboxed conversation \`${facts.sessionId}\`.`
      : `Work from the sandboxed conversation **${facts.title.trim()}** (\`${facts.sessionId}\`).`,
    "",
    `The conversation worked in its own git worktree (\`${facts.worktreePath}\`) on branch \`${facts.branch}\`,`,
    `carved from ${facts.base === undefined ? "the main checkout's `HEAD`" : `commit \`${facts.base}\``}.`,
    "",
    ...(facts.summary === undefined || facts.summary.length === 0
      ? []
      : ["## Summary", "", ...facts.summary.map((line) => `- ${line}`), ""]),
    `## Commits (${commits})`,
    "",
    "```",
    log === "" ? "(none)" : log,
    "```",
    "",
    "## Files changed",
    "",
    "```",
    stat === "" ? "(no tracked changes)" : stat,
    "```",
    "",
  ]
  if (facts.committed) {
    lines.push("The merge button committed the worktree's remaining changes before pushing.", "")
  }
  lines.push(`Opened by the \`dsh-docker-sandbox\` plugin from container \`${facts.container}\`.`)
  const body = lines.join("\n")
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS).trimEnd()}\n… (truncated)`
}
