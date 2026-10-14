import { DOT, PillLink, useSandboxStatus } from "./pill.tsx"

export interface PullRequestLinkProps {
  sessionId: string
}

const PR_NUMBER = /\/(?:pull|merge_requests)\/(\d+)/

export function PullRequestLink({ sessionId }: PullRequestLinkProps) {
  const { status } = useSandboxStatus(sessionId)
  const prUrl = status?.worktree?.prUrl
  if (prUrl === undefined) return null
  const number = PR_NUMBER.exec(prUrl)?.[1]
  return (
    <PillLink
      href={prUrl}
      label={number === undefined ? "pull request" : `PR #${number}`}
      title={`pull request: ${prUrl}\nclick to open it in a new tab`}
      dotColor={DOT.success}
    />
  )
}
