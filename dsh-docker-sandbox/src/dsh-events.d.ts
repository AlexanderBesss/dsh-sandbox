/**
 * Augmentation of the real cordis module with the DSH host events this plugin
 * listens to. Unlike `seams.d.ts` (which stands in for untyped app packages),
 * this file is a module augmentation of the installed, typed `@deepseek-ai/cordis`.
 *
 * Shapes mirror call sites verified in the installed bundle (0.2.0-rc.2):
 * `dsh-workspace` dispatches the parallel hook, and `dsh-agent` / `dsh-jobs` /
 * `dsh-subagent` / `dsh-schedule` register the same handler this plugin uses.
 *
 * @module dsh-docker-sandbox/dsh-events
 */

declare module "@deepseek-ai/cordis" {
  interface Events {
    /**
     * Parallel hook: the workspace registry is stopping an archived
     * conversation's work (`archiveSession` with `stopActivity`). Owners of
     * session work — agents, jobs, subagents, schedules, and this plugin's
     * container — stop when it fires.
     * @mode parallel
     */
    "workspace/session-stop"(payload: { sessionId: string }): void
  }
}

export {}
