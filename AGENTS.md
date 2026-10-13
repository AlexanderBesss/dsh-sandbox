# Agent instructions

## Versioning: bump the version on every commit

Every commit that changes a package's shipped code must bump that package's
`version` in its `package.json` (pre-1.0 convention):

- **patch** (`x.y.Z`): fixes, small features, internal changes.
- **minor** (`x.Y.0`): a feature worth calling out, or a public-facing change.
- **major** (`X.0.0`): breaking changes.

The app's plugin manager shows the installed version, so the bump is how an
installed copy is told apart from the source tree — an unchanged version means
a stale install is invisible. After bumping, rebuild (`pnpm build`) so the
artifacts and the version ship together.

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
