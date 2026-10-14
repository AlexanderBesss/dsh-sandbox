import type { SandboxConfig } from "../../config.ts"
import type { BootstrapLogger } from "../bootstrap.ts"
import type { ConflictFacts } from "../conflicts.ts"
import type { CliRunner } from "../git.ts"
import type { PathMapper } from "../paths.ts"
import type { PrBrief } from "../pr-brief.ts"

export interface WorktreeEntry {
  sessionId: string
  mainWorkspace: string
  repoRoot: string
  worktreePath: string
  branch: string
  renamedFrom?: string
  createdAt: number
  hostGitDir: string
  gitConfig: Record<string, string>
  baseRef?: string
  lockHash?: string
  notifiedBehind?: string
  notifiedMerging?: boolean
  prUrl?: string
}

export interface WorktreeInfo {
  path: string
  branch: string
  mainWorkspace: string
  dirty: boolean
  unpushed: boolean
  merging: boolean
  conflicts?: string[]
  behind?: number
  prUrl?: string
}

export interface ConflictBundle {
  entry: WorktreeEntry
  facts: ConflictFacts
}

export type SyncState = "up-to-date" | "merged" | "conflict" | "failed" | "deferred" | "unavailable"

export interface SyncOutcome {
  state: SyncState
  behind?: number
  conflicts?: string[]
}

export interface MergeRequestResult {
  branch: string
  worktreePath: string
  committed: boolean
  pushed: boolean
  remote?: string
  prUrl?: string
  compareUrl?: string
  prError?: string
  renamedFrom?: string
  nameNote?: string
  briefError?: string
}

export interface WorktreeDeps {
  git: CliRunner
  gh?: CliRunner
  config: SandboxConfig
  logger?: BootstrapLogger
  paths: PathMapper
  titleFor?: (sessionId: string) => string | undefined
  brief?: PrBrief
  notify?: (sessionId: string, text: string) => boolean
  onTreeChanged?: (entry: WorktreeEntry) => void
}

