# Agent instructions

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
