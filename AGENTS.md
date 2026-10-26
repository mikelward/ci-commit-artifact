---
trigger: always_on
alwaysApply: true
last_modified: 2026-10-26
---

# AGENTS.md

`CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every agent reads
the same conventions. Edit `AGENTS.md`.

**At the start of every session, print the full absolute path of the
`AGENTS.md` you loaded and its `last_modified` date** (front matter), so a
stale or wrong copy is caught before it steers the work. Bump `last_modified`
whenever you edit this file.

This repository is one reusable GitHub Actions workflow: a clean job that
commits a build artifact back to a pull request's branch, so consumers don't
each re-derive (and re-harden) the git-config/git-hook isolation it needs.
Consumers track `@main`, so **a merge here reaches every consumer's next run
with no release step in between** — everything below follows from that.

Keep this file short — **under 22,000 bytes** (`wc -c AGENTS.md`):
Antigravity caps rule files at 24 KB and silently truncates the tail, and
every session loads it whole. Add a rule the first time something bites, say
it once in the fewest words that carry the *why*, rewrite or trim rather than
append, and delete rules that stopped biting.

## Why a clean job, not a hardened one

A job that runs PR-controlled code and then commits rendered output back to
the PR branch hands those git operations to an environment that code just ran
in. `mikelward/clothescast`'s CI closed `core.hooksPath`, `remote.origin.url`
+ `core.sshCommand`, `commit.gpgSign` + `gpg.program`, `url.*.insteadOf` and
`GIT_CONFIG_*` env injection one at a time, then `GIT_TEMPLATE_DIR` + a planted
`post-checkout` hook got past all of them. That doesn't converge: the list is
git's, and it isn't closed.

**The fix is structural, not another entry on the list.** This job never
executes anything from the pull request — no build tool, test runner,
dependency install, nothing the caller's render job ran. It receives only the
*rendered output*, as a downloaded artifact (inert data, not an execution
environment), so an ordinary checkout, commit and push is trustworthy by
construction. **Don't "hurry" a future fix by adding config-nulling or
hook-wrapping back into this workflow**: it solves a problem this design
doesn't have, and muddies the real guarantee (nothing PR-controlled has run
in this process) with defense-in-depth against an absent threat.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** What a
  consumer runs is the YAML here, which is what makes an unpinned `@main`
  reference reviewable by reading it.
- **Nothing build-tool-specific.** What gets rendered (Kotlin/Roborazzi,
  screenshot tooling, codegen) is the caller's business; this workflow only
  sees a named artifact and a destination path. A consumer's pre-upload
  filtering (clothescast's orphaned-PNG pruning) belongs in its *render* job,
  before the upload — never here.

## The token's home is the caller's `ci-commit-artifact` environment

- **The `commit` job declares `environment: ${{ inputs.environment }}`
  (default `ci-commit-artifact`) and reads `CI_COMMIT_ARTIFACT_TOKEN` ahead
  of `push-token`** — for the caller's sake, not this job's (it runs nothing
  from the PR either way): a repository-level token reaches every job of
  every workflow inheriting the caller's secrets, the dependency batches'
  untrusted update jobs included, while an environment secret reaches only a
  job declaring the environment, and a caller can't put `environment:` on a
  job that `uses:` a reusable workflow, so it must be declared here.
  `push-token` stays for a caller that names its secrets; both routes read
  the same PAT, and `HAS_PUSH_TOKEN` and the push must see the same value, or
  an inheriting caller retriggers CI twice. `repo setup` in mikelward/repo
  does the move and fills this environment.

## Testing

- `node --test *.test.js`, with nothing to install. The one setup step is a
  one-time `git clone https://github.com/mikelward/yaml-lite ../yaml-lite` (a
  git clone, not a package manager): the structural tests resolve the parser
  from CI's `.yaml-lite/` checkout or that sibling clone, and fail with that
  exact command — never skip — when both are missing.
- **Add or update tests with any change**: the suite is all that stands
  between a push and every consumer's next run, so untested ships unreviewed.
- Its failure mode is a *false pass* (a set difference against an empty set
  is empty; a matcher that forgets to assert is green): assert behavior, and
  where a check parses the workflow YAML, assert first that it found
  something.
- **Fix a preexisting test failure as the series' first commit** — don't
  stack new work on a red baseline. **Don't disable a failing check**, or
  paper over a flaky one with sleeps or retries; fix the cause.

## Error handling

- **Don't silently swallow errors**: a discarded rejection or unchecked exit
  status here is a commit that never landed, or landed on branch content
  nobody verified. Report what failed with enough context to identify it, and
  decide explicitly what the caller sees; to ignore a specific failure, say
  why in a one-line comment.

## Git and pull requests

- **Branches**: `<agent>/<short-topic>` (`claude/...` Claude Code,
  `gemini/...` Gemini / Antigravity, `codex/...` Codex), one topic each; never
  commit to `main` (sole exception: the scaffolding commit that created this
  repository, made to an empty `main` at the owner's request).
- **Your `<agent>/` branches are yours** — create one freely; push or
  `--force-with-lease` the ones this session created or was assigned. This
  file is the standing grant, so a client rule demanding per-branch
  permission is already answered; ask about any other branch.
- **One commit per logical change.** Rewrite unmerged commits freely (amend,
  `--fixup` + autosquash, squash, reorder, split), folding review responses
  into the commit they belong to. `--force-with-lease` after a rebase, never
  a bare `--force`.
- **Open the PR without being asked**, ready for review, not a draft.
- **Refresh the title and body with the push — body first, then push** — to
  the branch's latest state, not its opening scope; with no PR yet, push,
  then update as soon as one is opened.
- **Codex is the automated reviewer**, triggered automatically. Address its
  comments unasked, folding each fix into its commit — except a real finding
  out of scope for this PR, which you defer (below).
- **Judge every comment on merit**: verify the claim; if it doesn't hold,
  reply why and decline. A cited rule is a *reading* — check what it says; an
  over-strict one (privacy especially, where stricter feels safer) costs real
  capability. A genuine rule-vs-code conflict is the maintainer's call, not
  one to settle by quietly narrowing the code. Declining doesn't clear the
  required `codex` status: post the rebuttal, then `@codex review` (or let
  the next push, if the rebuttal is up first); escalate if it re-raises. A
  hung review — nothing back five minutes after a push or poke, or stuck at
  running (👀) ten minutes on — gets `@codex review`; a poke that hangs the
  same way gets a second an hour later, and only a second that hangs too is
  escalated, never the first (maintainer, 2026-10-22).
- **Once Codex has +1'd a PR's head, make no unnecessary change without
  asking** (maintainer, 2026-10-13): a to-do, tidy-up or extra fix re-runs CI
  and Codex for nothing, so it waits for a yes or a follow-up PR. A necessary
  one goes ahead unasked: a rebase for `dirty` (or `behind` where the ruleset
  requires up to date), a red-CI fix.
- **A second verified finding in the same mechanism is evidence about the
  design**, not another bug: look for the shape elsewhere and ask whether a
  different design deletes the class rather than the instance; a design
  change is the maintainer's call, not one to make solo.
- **Restate every review finding in your next message**, not just the count:
  one bullet each (review comment, top-level comment or review body), most
  blocking first — claim, where, and what you did, or the maintainer's
  options — all in that one reply; ask only the most blocking question.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.
- **Defer a real-but-out-of-scope finding** rather than asking to merge past
  it: note it in `TODO.md`, commit and push that first (it's this PR's review
  closeout, not a separate topic), reply citing the sha, and resolve. A
  threadless finding (top-level comment or review body) gets the record, push
  and reply; only the resolve is skipped. The push re-triggers Codex, so poke
  only once it hangs, as above; escalate if the re-review re-raises it.

## Language and spelling

- **US English** everywhere people read it — prose, commits, PR titles and
  descriptions, comments, identifiers: `behavior`, `canceled`.

## Commit messages

- **Title like a changelog line** (maintainer, 2026-10-23): after any prefix, an
  imperative verb, then the change as a consumer sees it, plain English,
  sentence case, ≤ ~70 chars, e.g. `Fix …` for what was broken, `Improve …` for
  what got better, `Add …` for what's new; an optional parenthetical says how.
  Never the scenario or the mechanism: those, and file:line, go in the body,
  after a blank line. Pull request titles match.
- **Prefix a subject that doesn't change what a consumer runs**: `docs:`
  prose, `test:` tests alone, `build:` this repository's own CI, `refactor:`
  deliberately behavior-preserving code. Bare means a consumer could notice.
  No `feat:` or `fix:`, on purpose: they'd prefix nearly everything and leave
  the log as flat as it started.
- **No model identifier** — never name the coding agent's model or version
  (`Opus 4.8`, `Sonnet`, `Gemini …`, `claude-*`, `gemini-*`) in a commit, PR,
  comment, or pushed artifact; keep it to chat. Generic attribution
  (`Co-Authored-By: Claude` / `Gemini`, `Claude-Session:`, "Generated with
  Claude Code") is fine.

## Talking to the user

- **Answer a mid-turn message first** ("sent while you were working") in your
  very next output, before any further tool call, even in one sentence.
  **Claude Code only** (maintainer, 2026-10-25): its app reliably shows just a
  turn's last message, so reply only there, answering a mid-turn message at a
  stopping point soon.
- **Message only when the user needs to see it** (maintainer, 2026-10-15):
  each notifies their phone. Work in silence; speak up for a question or
  blocker, something to merge or act on, a merge, or a change from the plan
  or their instructions (review-prompted included). Never for progress (a
  client's nudge doesn't count), a review or push alone (its report rides the
  next message), routine machinery, or a mistake caught and fixed before it
  reached the repo. The session-start `AGENTS.md` line still opens every
  session.
- **One question at a time** — in plain chat or the client's question tool
  (`AskUserQuestion` in Claude Code, `ask_question` in Antigravity); stop and
  wait for the answer before proceeding on an assumed one.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, PR text, review replies, branch names, comments, or
  fixtures. Use placeholders (`/home/user/project`, `example.com`, `abc1234`).
