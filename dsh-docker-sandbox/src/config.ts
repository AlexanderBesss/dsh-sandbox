import Schema from "@deepseek-ai/schemastery"

/**
 * Plugin configuration, as declared for the `docker-sandbox` row in the bundle
 * patch. Every field has a default that works against the Docker Desktop
 * engine installed on this machine, so an empty `config:` block is valid.
 *
 * @module dsh-docker-sandbox/config
 */
export const Config = Schema.object({
  /**
   * The docker CLI invocation. It is a native Windows binary (Docker Desktop
   * puts `docker.exe` on PATH), so it is spawned directly; set this to a full
   * path if the CLI is not on the service PATH.
   */
  dockerArgv: Schema.array(Schema.string()).default(["docker"]),

  /**
   * Image for the per-chat sandbox container. Volatile: editing it in the
   * plugin manager applies to the next container the chat provisions.
   */
  image: Schema.string().default("alpine:3.20").volatile(),

  /** Keep-alive entrypoint for the sandbox container. */
  command: Schema.array(Schema.string()).default(["sleep", "infinity"]),

  /**
   * `workspace` mounts only the session workspace at `containerWorkspace`;
   * `drives` mounts every Windows drive root at `/<drive-letter>` (Docker
   * Desktop's drive sharing), which makes path mapping lossless for commands
   * started outside the workspace. An unknown value fails at config load
   * rather than silently falling back.
   */
  mountMode: Schema.union([Schema.const("workspace"), Schema.const("drives")]).default("workspace"),

  /** Container path the session workspace is mounted at in `workspace` mode. */
  containerWorkspace: Schema.string().default("/workspace"),

  /**
   * Fallback workspace for calls with no initiating agent. Per-chat calls use
   * their own session workspace, so this is only a default.
   */
  workspaceRoot: Schema.string().default(process.cwd()),

  /**
   * Route agentless calls (web routes, background jobs with no live agent) to a
   * shared `dsh-sbx-default` container instead of failing. Off by default: a
   * call that cannot name its chat should say so rather than pick a container.
   */
  allowAgentless: Schema.boolean().default(false),

  /** Budget for bringing a sandbox container to Running (image pull included). */
  provisionTimeoutMs: Schema.number().min(1000).default(120000),

  /** Default foreground budget for one shell command. */
  timeoutMs: Schema.number().min(0).default(120000).volatile(),

  /**
   * Upper bound a caller may raise `timeoutMs` to. A request above it is
   * clamped, and the result echoes the deadline that actually applied.
   */
  maxTimeoutMs: Schema.number().min(0).default(600000).volatile(),

  /** Retained output bytes per stream before spill/lossy reporting kicks in. */
  maxOutputBytes: Schema.number().min(0).default(64000).volatile(),

  /** Terminate-escalation grace period (SIGTERM → SIGKILL). */
  graceMs: Schema.number().min(0).default(3000).volatile(),

  /** Shell that runs shell-tool command text inside the container. */
  shellArgv: Schema.array(Schema.string()).default(["/bin/sh", "-lc"]),

  /** Install `rg` into the container so `glob` / `grep` work. */
  bootstrapTools: Schema.boolean().default(true),

  /**
   * How to obtain `rg` inside the container: `package` uses the image's package
   * manager, `url` downloads a static musl build, `none` leaves search disabled.
   * A union, not a free string: a typo fails at config load rather than
   * silently falling back to the package branch.
   */
  ripgrepSource: Schema.union([
    Schema.const("package"),
    Schema.const("url"),
    Schema.const("none"),
  ]).default("package"),

  /** Idle containers past this age are deleted by the GC loop. */
  idleTtlMs: Schema.number().min(0).default(7200000).volatile(),

  /**
   * How often the GC loop runs. Bounded below: a zero or tiny interval turns
   * the sweep into a busy loop of `docker ps` calls.
   */
  gcIntervalMs: Schema.number().min(1000).default(60000),

  /**
   * Allocate a TTY for terminal sessions (`docker exec -t`). Off by default:
   * the marker protocol works without a PTY, and a TTY on a Windows pipe
   * rewrites line endings.
   */
  terminalPty: Schema.boolean().default(false),

  /**
   * Resource limits for the sandbox container, e.g. `{ cpu: "2", memory:
   * "2g" }`. Passed to the Docker engine as `--cpus` / `--memory` /
   * `--memory-swap`; an empty value leaves that limit unset, which is the
   * default for a single-user desktop engine. Setting `memorySwap` equal to
   * `memory` disables swap spillover, making the RAM cap absolute.
   *
   * Every field is volatile: the plugin manager exposes them as an editable
   * form (persisted to the profile patch, applied live), and the provisioner
   * reads the current values each time it creates a container.
   */
  resourceLimits: Schema.object({
    cpu: Schema.string().default("").volatile(),
    memory: Schema.string().default("").volatile(),
    memorySwap: Schema.string().default("").volatile(),
  }).default({ cpu: "", memory: "", memorySwap: "" }),

  /** Delete this plugin's containers when the plugin unloads. */
  gcOnUnload: Schema.boolean().default(false),
})

/** The validated config object `apply()` receives from the `Config` schema. */
export type SandboxConfig = typeof Config extends Schema<any, infer T, any> ? T : never
