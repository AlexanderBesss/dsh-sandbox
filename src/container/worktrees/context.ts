import type { OriginTracker } from "./origin.ts"
import type { WorktreeRegistry } from "./registry.ts"
import type { WorktreeDeps } from "./types.ts"

export interface ManagerContext {
  deps: WorktreeDeps
  registry: WorktreeRegistry
  origin: OriginTracker
}
