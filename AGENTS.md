# Agent instructions

## Commits: only when asked

Do not commit unless the user directly asks for it in the current request
("commit this", "ship it", "make a commit", …). A request to fix, implement,
or analyze something is *not* a request to commit: finish the change, leave
the working tree modified, and report what changed — staging and committing
are the user's call.

- Never commit to "clean up" at the end of a task, and never amend or rebase
  on your own initiative.
- When the user does ask, the versioning rule below applies to that commit.

## Versioning: bump the version on every commit

Every commit that changes a package's shipped code must bump that package's
`version` in its `package.json` (pre-1.0 convention):

- **patch** (`x.y.Z`): fixes, small features, internal changes.
- **minor** (`x.Y.0`): a feature worth calling out, or a public-facing change.
- **major** (`X.0.0`): breaking changes.

The app's plugin manager shows the installed version, so the bump is how an
installed copy is told apart from the source tree — an unchanged version means
a stale install is invisible. After bumping, rebuild (`npm run build`) so the
artifacts and the version ship together.

## Comments: only when necessary

Do not add a comment unless it carries something the code itself cannot carry.
A reader who can name the thing from its identifier needs no prose.

- No comment restating the code, narrating the steps, or introducing a block
  ("as you can see", "first we validate…", section banners).
- No comment recording that a change was made, for whom, or when — that is
  what git history is for.
- Do comment the *why* when it is not in the code: an invariant, a constraint
  arriving from outside, a workaround, a hazard, an ordering rule. One or two
  lines, next to the line that needs it.
- Match the file's existing density. Where a file already documents its modules
  and exported functions (this repo's style), keep that documentation and update
  it with the change; do not add narration inside function bodies on top of it.
- When a change makes a comment wrong, fix or delete the comment in the same
  edit.

## TypeScript: no `any`

Do not use `any` in TypeScript source unless it is genuinely impossible or not
worth it to type properly. For most code, name a real type — an interface, a
union, a generic parameter, `unknown` with a narrowing guard, or an inferred
type. `any` silently disables the checks that make refactors safe.

- Prefer `unknown` + narrowing over `any` when the shape is truly dynamic.
- If a value's type is only awkward (verbose cast, missing local interface),
  that is not a reason for `any` — write the type.

### Exceptions

- **Tests:** the rule may be relaxed (e.g. `as never`, loose fakes, partial
  stubs via `as unknown as T`). Still prefer real types where they are simple —
  typed tests catch contract drift in the fixtures themselves.
- **Third-party libraries without type definitions:** `any` is acceptable at
  the interop boundary. Contain it: wrap the untyped import behind one small
  typed adapter (a `.d.ts` shim or a thin wrapper module) so the rest of the
  codebase sees real types.
