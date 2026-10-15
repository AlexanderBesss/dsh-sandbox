import { titleSlugFor } from "../session.ts"

export const MAX_BRIEF_BULLETS = 8
export const MAX_BRIEF_BULLET_CHARS = 200

export const MAX_BRANCH_SLUG_CHARS = 40

export interface PullRequestBrief {
  branchSlug?: string
  title?: string
  bullets: string[]
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
