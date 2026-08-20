# TODO

Deferred work, recorded here so it isn't lost.

## Pilot in clothescast

This workflow exists to fix a real, live problem in `mikelward/clothescast`
CI (a `GIT_TEMPLATE_DIR` + `post-checkout` hook injection channel, found
after several rounds of patching individual git-config/env vectors one at a
time). Rewiring clothescast to call `commit-artifact.yml` instead — moving
its own Roborazzi-snapshot upload/commit steps to use this workflow — is the
actual point and hasn't been done yet.

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
