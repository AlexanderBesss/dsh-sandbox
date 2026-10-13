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
| `ctx.webServer` | `GET /sandbox/api/list`, `GET /sandbox/api/status?session=<id>` for the UI |

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
  Nothing falls back to running on the host.

## Install

Requirements: Docker Desktop (or any reachable Docker Engine) with the `docker`
CLI on PATH.

```sh
# from this directory
pnpm install && pnpm build
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

## Development

```sh
pnpm typecheck          # sources, tests, and configs
pnpm test               # unit tests, no engine needed
pnpm test:integration   # against the live Docker engine
pnpm build              # lib/ (host ESM) + lib/client.js (client bundle)
```

The unit suite covers path mapping (Windows ⇄ container), session → container
naming, the `docker run` argv, and provisioning against a fake engine. The
integration suite (`test/integration/`) provisions a real container and checks
the command runner, cancellation by process group, bind-mount byte sharing
between host and container, and ripgrep availability. It is skipped unless
`DSH_DOCKER=1`, which `pnpm test:integration` sets for you.

## Troubleshooting

- **`docker is not available on this machine`** — Docker Desktop is not
  installed or not running. Start it, or point `dockerArgv` at the CLI.
- **`the Docker daemon is not reachable …`** — the engine is starting or
  paused. Wait for Docker Desktop to finish booting; the plugin does not retry
  on the host.
- **`the sandbox container "…" could not be created …`** — usually a bad image
  name or a drive Docker Desktop is not sharing. Check the message detail, and
  Settings → Resources → File Sharing for the workspace's drive.
- **`PATH_OUTSIDE_SANDBOX`** — the path is not under the mounted workspace. In
  `workspace` mode only the chat's workspace is reachable; switch to
  `mountMode: "drives"` if you need the whole drive.
- **`NAME_CONFLICT`** — a container this plugin does not own already carries
  the name `dsh-sbx-<session>`. Rename that container, or remove it if it is
  stale; the plugin will not adopt or delete a container it did not create.
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
