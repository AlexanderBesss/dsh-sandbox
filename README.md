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

## Worktree mode

`worktree: true` gives each chat its own worktree and branch (`dsh-sbx/<chat-title>-<digest>`), based on `origin/<main>` and kept merged with it. A dirty worktree is never touched; a conflicted merge waits for the chat or the *resolve conflicts* button. The header gains *merge request* (commit, push, PR through `gh`), *review*, and *resolve conflicts* buttons; unmerged or dirty worktrees are never pruned.

## Development

`npm run typecheck && npm test` (no engine needed), `npm run test:integration` (live engine), `npm run build`.

## Troubleshooting

- **Docker missing / daemon unreachable** — start Docker Desktop, or set `dockerArgv`.
- **`PATH_OUTSIDE_SANDBOX`** — outside the mount; use `mountMode: "drives"`.
- **`NAME_CONFLICT`** — a `dsh-sbx-<session>` container we did not create; remove it.
- **Merge pushes but opens no PR** — `gh` missing or logged out (`gh auth login`).
- **Leftover containers** — `docker rm -f $(docker ps -aq --filter label=dsh.sandbox=1)`

Only containers labelled `dsh.sandbox=1` are touched. The bind mount is the real workspace — the sandbox contains *host execution*, not your data.
