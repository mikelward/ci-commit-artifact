# TODO

Deferred work, recorded here so it isn't lost.

## Pilot in clothescast

This workflow exists to fix a real, live problem in `mikelward/clothescast`
CI (a `GIT_TEMPLATE_DIR` + `post-checkout` hook injection channel, found
after several rounds of patching individual git-config/env vectors one at a
time). Rewiring clothescast to call `commit-artifact.yml` instead — moving
its own Roborazzi-snapshot upload/commit steps to use this workflow — is the
actual point and hasn't been done yet.

## Port yaml-lite.js to sibling repos

`npm-update/npm-update-workflow.test.js` and `gedmap/.github/workflows/npm-update.test.js`
test their own reusable-workflow YAML the same way this repo's tests used to
— regex/string-matching over the serialized text — and that approach
produced a real, broken test here (an unbounded lazy match that could span
past the input it was checking). Both are pure-JS repos, same shape as this
one, so `yaml-lite.js` (or a copy of it, ported by hand — there's no shared
package registry across this fleet, same reason `vitest-shim.mjs` is
duplicated rather than imported) is the natural fix once this repo has
proven it in real use for a while. Not urgent; their existing tests aren't
known to be wrong today, just fragile in the same way this one was.

Python-based repos (`web`) are a separate case: PyYAML is a genuine
zero-cost option there since Python is already the production runtime, not
a second runtime taken on for test convenience the way it would be here.
