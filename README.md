# dsh-docker-sandbox

Runs every DeepSeek Harness tool call — shell, files, search, subprocesses, terminals — in a **dedicated Docker container per chat** (`dsh-sbx-<session>`, shown in the chat header). The workspace is bind-mounted at `/workspace`, so file tools read and write host files directly and containers are spawned only to execute. If Docker is unreachable, calls fail (`DOCKER_UNREACHABLE`) instead of falling back to the host.

## Install

Requires Docker with the `docker` CLI on PATH. `npm install && npm run build`, then:

```yaml
plugins:
  - dsh-docker-sandbox
```

Toggling it off restores host execution; the Pwsh tool stays disabled, so the model uses Bash.

## Configuration

Full list with defaults: [src/config.ts](src/config.ts).

| Option | Default | Meaning |
| --- | --- | --- |
| `image` | `node:24` | image per chat container |
| `mountMode` | `workspace` | `drives` mounts whole drives at `/c`, `/f`, … |
| `timeoutMs` / `maxTimeoutMs` | `120000` / `600000` | per-call budget and its ceiling |
| `idleTtlMs` / `gcIntervalMs` | `7200000` / `60000` | idleness TTL and sweep interval; archiving a chat also deletes its container |
| `shellArgv` | `["/bin/sh","-lc"]` | how shell commands start; use bash if the image's `sh` is dash |
| `bootstrapTools` / `bootstrapPlaywright` | `true` | ripgrep / Playwright install on first use |
| `worktree` + `worktree*` | `false` | per-chat `git worktree` and branch (see below) |
| `resourceLimits` | empty | `--cpus` / `--memory` / `--memory-swap` |
| `networkMode` | empty | `docker --network`; `none` removes container egress entirely, `host` shares the host network and voids `allowHostLoopback` |
| `allowHostLoopback` | `false` | `false` pins `host.docker.internal` to the container's own loopback |
| `worktreeInstallScripts` | `false` | `false` passes `--ignore-scripts` to the automatic `npm ci` |
| `apiToken` | `""` | bearer secret `/sandbox/api` requires; empty leaves the harness browser session as the only gate |

`apiToken` is volatile, so a reload applies it without a restart. `networkMode`, `allowHostLoopback` and the read-only `.git` overlays are volatile too, but they bind when the *next* container is created — a container that is already running keeps the settings it was created with until the idle TTL or an archive deletes it.

## API access

`/sandbox/api` is the plugin's only HTTP route, and it changes state: merge request, review, resolve conflicts, cancel a subagent. It rides the harness web server, which binds loopback only (`--host 0.0.0.0` is refused) — but a sandbox container can reach host loopback through `host.docker.internal`, so the route is authenticated, not merely origin-checked. By default that name is pinned to the container's own loopback (`allowHostLoopback: false`), which stops code that simply uses the hostname — and stops a container that legitimately calls a dev server on the host, so open it if you need that. It is a name-level control, not a boundary: the container runs as root, so it can read DNS, rewrite `/etc/hosts`, or dial the gateway IP directly, and `networkMode: "host"` voids the pin outright. The boundary is the authentication. With no token the route admits exactly what the harness admits on its own `/api`: the request must pass the harness Host/Origin fence and carry the signed browser-session cookie. The web GUI and the desktop app carry it automatically (the desktop bridge forwards the cookie while stripping `Origin`); curl, scripts, and container code have no cookie and get 401. Set `apiToken` to let scripted callers in: they must send `authorization: Bearer <token>`, and a valid token skips the browser session. The built-in UI never sends the token, so leave it empty unless you script the API. A `session` parameter naming neither a live chat, an archived chat, nor a registered worktree gets 404, and *merge request* never creates a worktree for an id that has none.

## Worktree mode

`worktree: true` gives each chat its own worktree and branch (`dsh-sbx/<chat-title>-<digest>`), based on `origin/<main>` and kept merged with it. A dirty worktree is never touched; a conflicted merge waits for the chat or the *resolve conflicts* button. The header gains *merge request* (commit, push, PR through `gh`), *review*, and *resolve conflicts* buttons; unmerged or dirty worktrees are never pruned.

### Host git

Worktree mode runs `git` on the host against a repository the container can write to, so the container's `.git` is untrusted config. Every plugin-driven call carries `-c` overrides and env that outrank config files: hooks (`core.hooksPath` points at an empty directory), `core.fsmonitor`, `core.pager`, editors, `core.askPass` with `GIT_ASKPASS`/`SSH_ASKPASS`, `core.sshCommand=ssh`, `ext::` transport (`protocol.ext.allow=never`, `GIT_ALLOW_PROTOCOL=https:ssh:file`) and terminal prompts. Repo-level `credential.helper` is cleared, then the operator's own `system`/`global` helpers are re-appended; `gh` gets the same overrides through `GIT_CONFIG_*`, since it rejects `-c`.

Two things have no fixed key name to pin, so they abort the call (`GIT_FAILED`) instead: a `filter.*.clean|smudge|process|required` or `alias.*` whose value starts with `!`, and `[include].path`/`[include].if` or any `includeif.*.path`/`includeif.*.if` in local or worktree config. Costs to expect: your own repository hooks do not run for plugin-driven git, and `git://` or `http://` remotes are refused. A filter named by an attribute and defined in your global or system config still runs — the refusal covers only what the container can reach, and a non-`!` filter (git-lfs) stays allowed because no config file the container can write is read.

The `.git` bind mount itself stays read-write, because the container's own git needs it. What a container could use to steer the *host's* git is overlaid read-only on top of it: `config`, `config.worktree`, `hooks/`, `info/`, and the pointers that decide which gitdir a worktree actually reads — `commondir`, `gitdir`, and the worktree's own `.git` file. Locking the config files without the pointers would be worthless: a rewritten `commondir` relocates the entire config surface into a repository the container wrote, and a `filter.*` defined there runs on the host during `git add`. Costs to expect inside the container: `git config --local`, `git submodule update --init`, `git lfs install` and edits to `.git/info/exclude` fail; commit, branch, stash and rebase do not, because identity and line-ending settings arrive through `GIT_CONFIG_*`. The overlays bind when the container is created, so a surface that first appears mid-life stays writable until the container is recreated. What remains writable by design: refs, index, objects and logs.

## Development

`npm run typecheck && npm test` (no engine needed), `npm run test:integration` (live engine), `npm run build`.

## Troubleshooting

- **Docker missing / daemon unreachable** — start Docker Desktop, or set `dockerArgv`.
- **`PATH_OUTSIDE_SANDBOX`** — outside the mount; use `mountMode: "drives"`.
- **`NAME_CONFLICT`** — a `dsh-sbx-<session>` container we did not create; remove it.
- **Merge pushes but opens no PR** — `gh` missing or logged out (`gh auth login`).
- **`ECONNREFUSED` to `host.docker.internal`** — `allowHostLoopback` is off, which pins that name to the container's own loopback; turn it on if the agent needs a service on the host, then let the chat provision a new container.
- **`Read-only file system` writing `.git/config`, `hooks/` or `.git`** — expected: those are overlaid read-only so container code cannot steer the host's git. Container-side `git config --local`, `git submodule update --init` and `git lfs install` have no home; set identity with `GIT_CONFIG_*` (the plugin mirrors `user.name`/`user.email` in automatically).
- **A native module is missing or a patch did not apply** — the automatic install runs `npm ci --ignore-scripts`; run `npm rebuild` in the container, or set `worktreeInstallScripts: true`.
- **Leftover containers** — `docker rm -f $(docker ps -aq --filter label=dsh.sandbox=1)`

Only containers labelled `dsh.sandbox=1` are touched. The bind mount is the real workspace — the sandbox contains *host execution*, not your data.
