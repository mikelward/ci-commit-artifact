# TODO

Deferred work, recorded here so it isn't lost.

## Pilot in clothescast — done

This workflow exists to fix a real, live problem in `mikelward/clothescast`
CI (a `GIT_TEMPLATE_DIR` + `post-checkout` hook injection channel, found
after several rounds of patching individual git-config/env vectors one at a
time). `clothescast`'s `ci.yml` now calls `commit-artifact.yml` for its
Roborazzi-snapshot commit-back step, in plain `pull_request` mode (it never
exercises the `push-token`/`pull_request_target` path).

## Wire typelauncher onto this workflow

`typelauncher` piloted the `pull_request_target` + `push-token` path, but
kept its own inline commit/push mechanism rather than calling this workflow
directly, because that inline version had graceful handling for the PR
branch vanishing mid-run (merged/closed while the job was still going) and
this workflow didn't. That gap is now closed — the "Commit and push" step
falls back to the same `ls-remote --exit-code` probe typelauncher's inline
version used, distinguishing a vanished branch or a lost race (warn, skip)
from a real push failure (error). Swapping typelauncher's `sync-screenshots`
job to call this workflow with `secrets: push-token: ${{
secrets.CI_COMMIT_ARTIFACT_TOKEN }}` instead of its own inline steps is the
remaining work.

## Port yaml-lite.js to sibling repos — done, extracted to its own repo

`yaml-lite.js` is now maintained in `mikelward/yaml-lite`, the canonical
source — vendored back into this repo and into `mikelward/npm-update`. Fix a
bug there first, then re-sync both vendored copies (see this repo's own
`AGENTS.md`). `gedmap`/`readmo`/`newshacker`/`homepage` were considered too,
but they already carry a real dependency graph (`package.json`), so `js-yaml`
(a real, spec-compliant library) is the better fit there rather than
vendoring this hand-rolled subset parser — see `mikelward/yaml-lite`'s
README for the reasoning.

Python-based repos (`web`) are a separate case: PyYAML is a genuine
zero-cost option there since Python is already the production runtime, not
a second runtime taken on for test convenience the way it would be here.

## Executable bits are silently dropped across the artifact handoff

Codex review (2026-08-20, on `.github/workflows/commit-artifact.yml:366`):
`actions/upload-artifact`/`download-artifact` normalizes every file to mode
0644, so an executable file in the rendered output loses its executable bit
by the time `download-artifact` extracts it here — a 100755→100644 change
that `git add` then stages silently, and a newly-generated executable can
never be committed as executable at all. Real finding, not yet fixed: fixing
it properly changes the artifact contract (either the caller uploads a tar
archive instead of raw files, restoring modes on extraction here instead of
relying on `download-artifact`'s raw multi-file handling, or a permissions
manifest alongside the artifact that this workflow chmods from after
extraction) — a design decision for every consumer of this reusable
workflow, not a same-PR mechanical fix. Needs a decision on which shape
(archive vs. manifest) before landing, and whether it's worth the added
complexity given how rare committed executables actually are in this
workflow's real usage today.

## The vanished-branch handling has a floor it can't probe past on its own

Codex review (2026-08-20, PR #2, on `.github/workflows/commit-artifact.yml`,
after the checkout-guard fix landed): branch-ref can also vanish in the
window *before* the validate step's own probe ever runs — the render job
that triggers this one can run for a long time first, so this isn't narrow
either. When that happens, the probe itself correctly (and honestly) finds
nothing and records `branch_existed_at_start=false`; checkout then fails,
and checkout-guard reports "did not exist at the start of this run either"
— the same wording, and the same hard failure, the tag-collision
misconfiguration deliberately gets. There is no way to tell the two apart
from *inside* this job: both look identical to a probe run after the fact,
and re-probing even earlier only pushes the same race further back, never
closing it (this PR's own history is two rounds of exactly that pattern
already). Real finding, not yet fixed, and not fixable this way at all —
closing it needs the calling workflow to hand down authoritative evidence
that branch-ref really was a branch at *trigger* time, which this job has
no way to independently reconstruct after the fact.

The two inputs closest to that evidence today don't get there.
`expected-head-sha` is validated as a real SHA on every call, but a caller
can supply it correctly while `branch-ref` itself is simply wrong (a typo,
or hardcoded to the wrong ref) — exactly the tag-collision shape the
refs/heads/ qualification exists to catch — so "expected-head-sha is valid"
alone can't be trusted as proof branch-ref was ever a real branch, or the
fix would silently swallow that misconfiguration instead of surfacing it.
`pr-number` is closer (a real PR implies a real head branch) but is only
required when `comment-marker` or `dispatch-workflow` is set, not on every
call, so it can't be relied on either without widening that requirement.
Closing this needs a deliberate decision on the workflow's own public
contract — most likely a new input the caller sets from its own trigger
context (e.g. `github.event.pull_request != null`) — which is a versioned
API change for every consumer of this reusable workflow, not a same-PR
mechanical fix, and needs a decision on whether the added complexity is
worth it given how narrow the remaining window actually is in practice (a
render job would need to run for the ENTIRE time between the PR event and
this job's own first step, with the merge/close landing in exactly that
gap) against how much of that same window the checkout-guard fix already
closed.

## Remaining forbidden plain-scalar starters in yaml-lite.js

`parseScalar` now rejects a plain scalar that opens with `&`/`*` (anchors/
aliases), `!` (tags), `@`/`` ` ``/`%` (reserved indicators), a genuinely
unterminated quote, and an unquoted `: ` or trailing `:`. YAML's own
reserved-indicator list is longer than the three characters covered so far
— a leading `]`, `,`, `}`, and the whitespace-sensitive `-`/`?` (only
reserved when followed by a space or end-of-line, same shape of rule as the
`:` check) are still silently accepted as plain-scalar text. Deferred rather
than folded into the PR that landed the `@`/`` ` ``/`%` check: this repo's
own workflow and README round-trip tests (the actual thing this parser
exists to protect) don't exercise any of these shapes, and each one so far
has needed its own real-YAML verification round rather than a batch
guess — see the git history of `yaml-lite.js` for the pattern. Land the
rest together in one pass, verified against `yaml.safe_load` for each
character, next time this file is touched for an unrelated reason.

Same deferral, same reasoning: `splitFlowSequence` also doesn't reject a
`[` or `{` appearing partway through an already-started plain element
(`runs-on: [foo[bar]]` parses as `["foo[bar]"]` instead of being rejected —
verified against `yaml.safe_load`, which raises a ParserError). Land this
alongside the reserved-starter sweep above; it's the same class of gap
(over-permissive on genuinely invalid content nobody's real workflow
files contain), not a new investigation.
