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
| `apiToken` | `""` | bearer secret `/sandbox/api` requires; empty leaves the harness browser session as the only gate |

`apiToken` is volatile, so a reload applies it without a restart.

## API access

`/sandbox/api` is the plugin's only HTTP route, and it changes state: merge request, review, resolve conflicts, cancel a subagent. It rides the harness web server, which binds loopback only (`--host 0.0.0.0` is refused) — but a sandbox container reaches host loopback through `host.docker.internal`, so the route is authenticated, not merely origin-checked. With no token the route admits exactly what the harness admits on its own `/api`: the request must pass the harness Host/Origin fence and carry the signed browser-session cookie. The web GUI and the desktop app carry it automatically (the desktop bridge forwards the cookie while stripping `Origin`); curl, scripts, and container code have no cookie and get 401. Set `apiToken` to let scripted callers in: they must send `authorization: Bearer <token>`, and a valid token skips the browser session. The built-in UI never sends the token, so leave it empty unless you script the API.

## Worktree mode

`worktree: true` gives each chat its own worktree and branch (`dsh-sbx/<chat-title>-<digest>`), based on `origin/<main>` and kept merged with it. A dirty worktree is never touched; a conflicted merge waits for the chat or the *resolve conflicts* button. The header gains *merge request* (commit, push, PR through `gh`), *review*, and *resolve conflicts* buttons; unmerged or dirty worktrees are never pruned.

### Host git

Worktree mode runs `git` on the host against a repository the container can write to, so the container's `.git` is untrusted config. Every plugin-driven call carries `-c` overrides and env that outrank config files: hooks (`core.hooksPath` points at an empty directory), `core.fsmonitor`, `core.pager`, editors, `core.askPass` with `GIT_ASKPASS`/`SSH_ASKPASS`, `core.sshCommand=ssh`, `ext::` transport (`protocol.ext.allow=never`, `GIT_ALLOW_PROTOCOL=https:ssh:file`) and terminal prompts. Repo-level `credential.helper` is cleared, then the operator's own `system`/`global` helpers are re-appended; `gh` gets the same overrides through `GIT_CONFIG_*`, since it rejects `-c`.

Two things have no fixed key name to pin, so they abort the call (`GIT_FAILED`) instead: a `filter.*.clean|smudge|process|required` or `alias.*` whose value starts with `!`, and `[include].path`/`[include].if` in local or worktree config. Costs to expect: your own repository hooks do not run for plugin-driven git, and `git://` or `http://` remotes are refused. A filter named by an attribute and defined in your global or system config still runs — the refusal covers only what the container can write.

## Development

`npm run typecheck && npm test` (no engine needed), `npm run test:integration` (live engine), `npm run build`.

## Troubleshooting

- **Docker missing / daemon unreachable** — start Docker Desktop, or set `dockerArgv`.
- **`PATH_OUTSIDE_SANDBOX`** — outside the mount; use `mountMode: "drives"`.
- **`NAME_CONFLICT`** — a `dsh-sbx-<session>` container we did not create; remove it.
- **Merge pushes but opens no PR** — `gh` missing or logged out (`gh auth login`).
- **Leftover containers** — `docker rm -f $(docker ps -aq --filter label=dsh.sandbox=1)`

Only containers labelled `dsh.sandbox=1` are touched. The bind mount is the real workspace — the sandbox contains *host execution*, not your data.
