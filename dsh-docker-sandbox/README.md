# dsh-docker-sandbox

Run every DeepSeek Harness tool call — shell, file reads and writes, search,
subprocesses, and terminal sessions — inside a **dedicated container per chat**,
on your local Docker engine, instead of on the Windows host.

The container is named after the conversation. The header of each chat shows the
name of the container that chat is running in, so "which box is this command
running in?" has an answer you can read and copy — and it is the same string
`docker ps` shows.

```
chat "session-3"  ──▶  container dsh-sbx-session-3  ──▶  /workspace  ⇄  F:\Projects\...
                        (label dsh.sandbox=1, local Docker engine)
```

## What it replaces

The plugin registers four services, so everything already built on them moves
into the container without further changes:

| Service | Effect |
| --- | --- |
| `ctx.subprocess` | `spawn` / `exec` run inside the container; cancellation signals the container's process group |
| `ctx.shell` | the shell tool runs `/bin/sh -lc` in the container; results carry `cwd`, `container` |
| `ctx.fs` | read, write, stat, list run against the bind-mounted workspace **on the host** — same bytes, no container needed; watching works, so the sidebar tree live-updates |
| `ctx.terminals` | a new `shell` terminal backend backed by the container (registered only when the app exposes `terminals` to the plugin; recent builds isolate it to the terminal group) |
| `ctx.webServer` | `GET /sandbox/api/list`, `GET /sandbox/api/status?session=<id>`, `POST /sandbox/api/merge-request?session=<id>` for the UI |

Because `ctx.fs` is replaced, the sidebar file tree, attachments, and `present`
all see the container's view of the workspace too.

## How it works

- **One container per conversation.** `ensure()` runs
  `docker run -d --name dsh-sbx-<session> --label dsh.sandbox=1 --label
  dsh.session=<id> …` and waits for the engine to report it Running.
  Provisioning is lazy: a chat that never runs a tool never gets a container,
  and a container that was deleted under us (`docker rm`, engine restart) is
  recreated on the next call.
- **The workspace is bind-mounted**, not copied. Docker Desktop shares Windows
  drives into its VM natively, so `F:\Projects\x` is mounted straight from the
  Windows path at `/workspace` — container writes are host writes.
  `mountMode: "drives"` mounts whole drives at `/c`, `/f`, … instead.
- **File operations never touch the container.** The workspace is a bind
  mount, so `ctx.fs` reads and writes the host files directly — same bytes,
  same version tokens, much faster. That also means *opening a chat* (the
  sidebar file tree calls `ctx.fs` to render) never spawns a container.
  Containers spawn only for actual execution: shell commands, subprocesses
  (including the `rg` that `glob` / `grep` spawn), and terminal sessions.
- **The docker CLI is spawned directly** (`docker.exe` on PATH): no WSL hop, no
  kubeconfig, no in-guest shell. Commands are passed as argv, never through a
  shell string; multi-line payloads travel through stdin.
- **One small agent is uploaded once per container** (`agent/run.sh`). A
  `docker exec` round trip costs a noticeable fraction of a second, and
  commands run through a runner that records a pidfile so they can be
  stopped later.
- **Idle and archived containers are collected.** Archiving a chat in the app
  deletes its container: a busy chat fires the app's `workspace/session-stop`
  hook (the same seam the agent and job owners use), and an idle one is caught
  by the GC sweep reading the registry's archive set — so the container is
  gone within one `gcIntervalMs` (default 60 s). Unarchiving re-provisions
  lazily on the next tool call. A container unused for `idleTtlMs` (default
  2 h) is deleted too, along with orphans from earlier runs, matched by the
  `dsh.sandbox=1` label. Neither sweep touches a container with work still
  running in it — a build, an install, or a terminal session held open
  outlives `idleTtlMs` without losing its box — or one whose conversation the
  app still holds open.
- **It fails closed.** If the Docker daemon is unreachable, tool calls fail
  with a named error (`DOCKER_MISSING`, `DOCKER_UNREACHABLE`, `EXEC_TIMEOUT`).
  Nothing falls back to running on the host. With worktree mode on the whole
  turn fails closed: the engine is probed before each step, and an
  unreachable one ends the turn with a "start the Docker engine" error in the
  conversation instead of the chat quietly answering against the host
  checkout.

## Install

Requirements: Docker Desktop (or any reachable Docker Engine) with the `docker`
CLI on PATH.

```sh
# from this directory
npm install && npm run build
```

Then add the plugin to the profile (in-app: the plugin manager, or point the
profile's `package.json` `dsh.profile.bundles` at the package). The patch entry
looks like:

```yaml
plugins:
  - dsh-docker-sandbox
```

The client bundle (`lib/client.js`) is loaded lazily by the app and adds the
container chip to the chat header.

## Enable / disable

Toggling the plugin (plugin manager, or a `- id: docker-sandbox` /
`disabled: true` row in the profile's `cordis.patch.yml`) is safe across
restarts: the `docker-sandbox-host-restore` entry shipped by the bundle patch
notices the sandbox entry is disabled and restores the withdrawn host
providers (`pwsh-sandbox`, `subprocess`, `fs-sandbox`), so the harness falls
back to host execution instead of leaving every tool waiting. It also watches
for a live toggle-off and restores those providers without a restart.

The watchdog additionally carries a compatibility shim for an app bug (as of
0.2.0-rc.2): a live re-composition re-applies `session-controller` before its
previous instance is disposed, and the shipped `registerAgentResolver` guard
turns that race into a fatal error that takes `session/create` down with it.
The shim makes re-registration replace the stale resolver instead of throwing,
so live toggles survive. The shim patches the service prototype process-wide,
so it stays in place for the rest of the app's process even after the sandbox
entry is disabled — harmless (it only relaxes a guard that misfires), and it
disappears on the next app restart. If a toggle ever does leave the app
unhealthy, the documented cure is: close the app, replace the profile's
`cordis.yml` (the loader's tree write-back, not meant to be hand-edited) with
its empty root list (header comment + `[]`), and reopen — the tree recomposes
from `package.json` bundles plus `cordis.patch.yml`.

## Configuration

| Option | Default | Meaning |
| --- | --- | --- |
| `dockerArgv` | `["docker"]` | the docker CLI invocation; set to a full path if PATH does not carry it |
| `image` | `alpine:3.20` | image for each chat container |
| `command` | `["sleep","infinity"]` | keeps the container alive between calls |
| `mountMode` | `workspace` | `workspace` bind-mounts just the chat's workspace; `drives` mounts `C:\` and the workspace drive at `/c`, `/f`, … |
| `containerWorkspace` | `/workspace` | where the workspace appears in the container |
| `workspaceRoot` | process cwd | fallback workspace for calls with no session |
| `allowAgentless` | `false` | route calls that belong to no chat to one shared container |
| `provisionTimeoutMs` | `120000` | budget for the first container of a chat (image pull included) |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | default per-call budget, and the ceiling a caller may raise it to (a longer request is clamped, and the result reports the deadline that applied) |
| `graceMs` | `3000` | SIGTERM → SIGKILL escalation when cancelling |
| `maxOutputBytes` | `64000` | captured output per stream |
| `shellArgv` | `["/bin/sh","-lc"]` | how shell commands are started |
| `bootstrapTools` | `true` | install `ripgrep` into the container on first use |
| `ripgrepSource` | `package` | `package` uses the image's package manager; `url` downloads a static musl build |
| `idleTtlMs` | `7200000` | delete a container after this much idleness |
| `gcIntervalMs` | `60000` | how often to sweep |
| `terminalPty` | `false` | request a TTY for terminal sessions |
| `resourceLimits` | `{ cpu: "", memory: "", memorySwap: "" }` | e.g. `{ cpu: "2", memory: "4g", memorySwap: "4g" }`, passed as `--cpus` / `--memory` / `--memory-swap`; empty leaves that limit unset |
| `gcOnUnload` | `false` | delete every sandbox container when the plugin unloads |
| `worktree` | `false` | give every conversation its own `git worktree` and branch (see below); live toggle |
| `worktreeRoot` | `""` | where worktrees live; empty = a sibling `<repoRoot>.worktrees/` per checkout, a set path is a root with one subdirectory per repo |
| `worktreeBranchPrefix` | `dsh-sbx/` | branch namespace for the per-session worktrees; the rest of the name is the chat's title (see below) |
| `worktreeSync` | `true` | base new worktrees on `origin/<branch>` — `<branch>` being the branch the host checkout has checked out — and keep existing ones merged with it (see below); live toggle |
| `worktreeSyncIntervalMs` | `300000` | the minimum interval between `git fetch origin` per repo — turn-start checks and GC sweeps share one budget |
| `npmCacheHost` | `~/.dsh-docker-sandbox/npm-cache` | host dir shared as the containers' npm cache (mounted at `/root/.npm`); empty disables it |
| `worktreeInstall` | `true` | run `npm ci --prefer-offline` in a worktree session's container when its worktree has a lockfile but no `node_modules`, and again when a main sync changes that lockfile; live toggle |
| `warmInstallTimeoutMs` | `600000` | budget for that background install |
| `gitArgv` | `["git"]` | the host git CLI used for worktree bookkeeping |
| `ghArgv` | `["gh"]` | the GitHub CLI used by the merge-request button |
| `prBrief` | `true` | let one fresh subagent name the branch and write the merge request's bullet points when the button is clicked; live toggle |
| `prBriefTimeoutMs` | `120000` | one deadline for that whole pass — probes, delegation, and answer (minimum 1000). A pass that runs out costs only the naming and the summary |

## Worktree mode and merge requests

By default every chat on the same workspace shares one checkout — two chats
editing one file conflict exactly as they would in two terminals. With
`worktree` enabled (a live toggle in the plugin manager), each conversation
instead works in its own `git worktree`, on its own branch:

```
chat "Fix the login crash"  ──▶  container dsh-sbx-session-3  ──▶  /workspace
                                  ⇅ bind mount
F:\Projects\app.worktrees\fix-the-login-crash-1a2b3c   (branch dsh-sbx/fix-the-login-crash-1a2b3c)
```

- **Per-chat isolation.** The container mounts the worktree, and the host file
  tools read and write it, so chats cannot step on each other. The worktree is
  created lazily on the chat's first tool call (one `git worktree add`), and
  the session → worktree mapping is kept in a `registry.json` under the
  worktrees root, so it survives restarts.
- **Branches are named after the conversation.** The branch (and the worktree
  directory) takes the chat's title — the one the sidebar shows, or the first
  message when the app has not titled the chat yet — slugified and cut to 40
  characters, with a short digest of the session id so two chats titled alike
  never share a branch: `dsh-sbx/fix-the-login-crash-1a2b3c`. A title chosen
  after the first tool call does not rename an existing branch (it may already
  be pushed); with no usable title — no latin characters to spell — the branch
  keeps the session-slug form `dsh-sbx/session-3`.
- **Git works inside the container too.** A linked worktree's `.git` file
  points at `<mainRepo>/.git/worktrees/<name>` — a host path the container
  cannot resolve on its own. So a worktree session's container also mounts the
  main repo's `.git` at its drive form (`/f/Projects/app/.git`) and exports
  `GIT_DIR`/`GIT_WORK_TREE` pinned to the session's worktree, plus the host's
  effective `core.autocrlf`/identity through `GIT_CONFIG_*` (Git for Windows
  keeps those in a system config the container cannot see, and without them
  container git reads a CRLF checkout as phantom-modified). `git status`,
  commits, and the merge button all work in the sandbox, and tools that probe
  git internals map to those mounts instead of hitting the mount boundary.
- **Dependencies install in the container, in the background.** A fresh
  worktree has no `node_modules` (it is gitignored, and `git worktree add`
  checks out tracked files only), and the main checkout's tree is no use to a
  Linux container — it carries Windows binaries (`@rolldown/binding-win32-x64-msvc`
  on the host, `binding-linux-x64-gnu` in the container). So once a worktree
  session's container is up, the plugin runs `npm ci --prefer-offline` in it
  when the worktree has a `package-lock.json` and no `node_modules`
  (`worktreeInstall`, off-the-clock: the chat answers while it runs, and the
  container holds a work lease so the GC cannot reclaim it mid-install). Every
  container shares one host npm cache (`npmCacheHost`, mounted at
  `/root/.npm`), so the install pulls from tarballs already on disk instead of
  re-downloading the graph per session. Only worktree sessions get this:
  installing into a *shared* checkout would replace the host's own
  `node_modules` with Linux binaries.
- **Worktrees follow main.** "Main" here is the branch the host checkout has
  checked out; a new worktree is based on `origin/<that-branch>` — one
  `git fetch origin` per `worktreeSyncIntervalMs` per repo, shared by every
  session; when the fetch cannot run (offline, no remote) the worktree falls
  back to the local `HEAD` and the log says so. Existing sessions are synced at
  the start of each turn and by the GC sweep, whenever the worktree is clean
  and the agent is idle: `origin/<main>` is merged into the session branch, and
  a `package-lock.json` the merge changed re-runs `npm ci --prefer-offline` in
  the container (an install that fails is retried on the next sync). A dirty
  worktree is never touched — the chat is instead told that main moved and its
  work is uncommitted. A merge that conflicts stays mid-merge in the worktree
  and the conversation's own agent is asked, in the chat, to resolve the
  markers and commit; the merge button refuses until that is done.
  `worktreeSync: false` returns to frozen snapshots.
- **Merge request button.** With a worktree, the session header gains a
  *merge request* button beside the container chip. It stages everything in the
  worktree and hands the staged diff to one fresh subagent, which answers in a
  strict shape: a branch name, a request title, and bullet points. The child is
  told to leave the worktree alone, and the button stages once more before it
  commits, so anything written while the pass ran still ships. The button then
  renames the branch to that name, commits with that title as the subject,
  pushes to `origin`, and opens a GitHub pull request through `gh`. So the
  branch a reviewer sees is `dsh-sbx/refuse-turn-when-engine-down-1a2b3c`, not
  `dsh-sbx/session-3`, and the description says what the change does:

  ```
  Work from the sandboxed conversation **Also, when we create a branch** …

  ## Summary

  - The merge button names the branch from the staged diff, so `git branch`
    reads as the change rather than the session id.
  - A branch already on `origin` keeps its name; the tooltip says why.

  ## Commits (1)

      4f2c1d8 dsh-sbx: Refuse the turn when the engine is down

  ## Files changed

      src/container/worktrees.ts | 61 ++++++++++++++++++
  ```

  Bullets are the child's, clipped to eight, and a line that is really a diff
  line (`- -old code`) is dropped rather than rendered. Renaming happens before
  the push, which is what makes it safe: a branch that already reached a remote
  keeps its name and the tooltip says so. `prBriefTimeoutMs` is one deadline for
  the whole pass — the prompt's git probes, the delegation, and the child's
  answer alike — since the button blocks while it runs. Without `gh` installed
  (or logged in) the button stops at the pushed branch and reports the remote's
  compare URL, along with why the request did not open. Set `prBrief: false` to
  skip the naming pass entirely — branches then keep their creation name and the
  description is the two git sections.
- **Review button.** Beside it, a *review* button spawns a fresh subagent
  that reviews the conversation's changes — its own commits plus uncommitted
  and untracked edits, collected as a diff against the branch's fork point.
  The reviewer starts with a clean slate: it carries **no reasoning from the
  main agent**, only the collected diff and the tools it runs itself in the
  sandbox (a subagent's tools see the parent's worktree, so `git diff` and
  file reads show the same work). The child session appears in the app's
  subagent UI; the button reports its id.
- **Non-git and broken setups fall back, visibly.** A workspace that is not a
  git checkout keeps sharing as before (logged once); a failed creation is
  sticky, logged, and shown in the chip tooltip rather than failing every tool
  call.
- **Worktrees outlive their containers on purpose.** Archiving a chat deletes
  its container but never an unmerged or dirty worktree. The GC sweep prunes a
  worktree only when the conversation is archived **and** the tree is clean
  **and** the branch is already merged. Anything else persists until you merge
  it or remove it by hand (`git worktree remove`).
- **Known limitation:** the sidebar file tree still shows the main checkout.
  The app's file API passes the session's original `header.cwd` and carries no
  session identity to `ctx.fs`, so the plugin cannot remap it; the chip
  tooltip and the merge button show the real worktree path and branch.

## Development

```sh
npm run typecheck       # sources, tests, and configs
npm test                # unit tests, no engine needed
npm run test:integration # against the live Docker engine
npm run build           # lib/ (host ESM) + lib/client.js (client bundle)
```

The unit suite covers path mapping (Windows ⇄ container), session → container
naming, the `docker run` argv, and provisioning against a fake engine. The
integration suite (`test/integration/`) provisions a real container and checks
the command runner, cancellation by process group, bind-mount byte sharing
between host and container, and ripgrep availability. It is skipped unless
`DSH_DOCKER=1`, which `npm run test:integration` sets for you.

## Troubleshooting

- **`docker is not available on this machine`** — Docker Desktop is not
  installed or not running. Start it, or point `dockerArgv` at the CLI.
- **`the Docker daemon is not reachable …`** — the engine is starting or
  paused. Wait for Docker Desktop to finish booting; the plugin does not retry
  on the host.
- **`this conversation runs in a Docker sandbox, but the Docker engine is not
  reachable`** (worktree mode) — the turn gate refused to run the chat: with
  the engine off, worktree mode would edit the main checkout while claiming
  the sandbox's isolation, so the message is refused rather than answered.
  Start Docker Desktop and send it again.
- **`the sandbox container "…" could not be created …`** — usually a bad image
  name or a drive Docker Desktop is not sharing. Check the message detail, and
  Settings → Resources → File Sharing for the workspace's drive.
- **`PATH_OUTSIDE_SANDBOX`** — the path is not under the mounted workspace. In
  `workspace` mode only the chat's workspace is reachable; switch to
  `mountMode: "drives"` if you need the whole drive.
- **`NAME_CONFLICT`** — a container this plugin does not own already carries
  the name `dsh-sbx-<session>`. Rename that container, or remove it if it is
  stale; the plugin will not adopt or delete a container it did not create.
- **Merge button pushes the branch but opens no pull request** — the GitHub
  CLI is what opens it. Without `gh` installed (or with it logged out) the
  button commits and pushes, then reports the reason and the remote's compare
  URL in its tooltip, and its dot stays amber rather than green. Install
  GitHub CLI and run `gh auth login`, or point `ghArgv` at it.
- **The branch kept its `dsh-sbx/session-…` name after clicking merge** — the
  naming pass did not run, and the tooltip says which case it was: no subagent
  service (the app has not finished wiring one), no live agent in the session to
  delegate from, the child running out its `prBriefTimeoutMs`, or an answer that
  was not bullet points. Any of those costs only the naming and the bullet
  points; the commit, the push, and the git sections of the description still
  happen. A branch that already reached `origin` also keeps its name — that name
  is public, and renaming it would break whatever refers to it.
- **The merge button says the worktree is mid-merge** — a main sync hit
  conflicts and the conversation has not resolved them yet. The chat was told
  which files conflict; ask it to resolve the markers and commit, then click
  again (or resolve them yourself in the worktree).
- **`PowerShell is not available in this sandbox`** — the app's Pwsh tool hands
  PowerShell text to the shell seam, which here is a Linux container; the guard
  (`pwshGuard`, on by default) answers once with a redirect to the Bash tool
  instead of letting `sh` emit `Get-Location: not found` (exit 127). Set
  `pwshGuard: false` only for images that actually carry `pwsh`.
- **`/bin/sh: 1: Bad substitution`** — Debian images run `dash` as `/bin/sh`,
  which fails on bash syntax. The plugin probes each container once and uses
  `/bin/bash -lc` when bash is present; override with `shellArgv` (e.g.
  `["/bin/bash", "-lc"]`) to force a shell.
- **A container is left behind** — `docker rm -f $(docker ps -aq --filter label=dsh.sandbox=1)`.

## Security notes

- Containers are labelled; the plugin only touches containers carrying
  `dsh.sandbox=1`. Before using an existing container it checks that label,
  and it refuses to start a chat whose derived name is already held by a
  container it does not own (`NAME_CONFLICT`) rather than running this chat's
  commands inside someone else's box.
- Container names carry a short digest of the conversation id whenever the id
  cannot be carried over verbatim (too long to fit, or characters a container
  name cannot carry), so two conversations cannot land on one container.
- The bind mount is the real workspace: a command inside the container can
  modify and delete it. The sandbox contains *host execution*, not your data.
- Every tool call is scoped to the conversation that made it. One chat cannot
  read another chat's container.
- `resourceLimits` maps to Docker's `--cpus` / `--memory` / `--memory-swap` if
  you want bounded containers; setting `memorySwap` equal to `memory` makes the
  RAM cap absolute (over-cap processes are OOM-killed, not paged out).
