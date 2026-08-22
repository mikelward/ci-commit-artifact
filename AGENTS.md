# AGENTS.md

Conventions for AI agents working in this repository.

`CLAUDE.md` is a symlink to this file, so every agent reads the same
conventions. Edit `AGENTS.md`.

This repository is one reusable GitHub Actions workflow: a clean job that
commits a build artifact back to a pull request's branch, so consumers don't
each have to re-derive (and re-harden) the git-config/git-hook isolation this
needs. Consumers track `@main`, so **a merge here reaches every consumer's
next run of the workflow that calls it, with no release step in between.**
Everything below follows from that.

Keep this file as short as it can be and still work. Every session loads it
whole, so each rule costs context on every turn: add one the first time
something bites, say it once in the fewest words that carry the *why*, rewrite
or trim an existing rule rather than appending beside it, and delete one that
has stopped biting.

## Why a clean job, not a hardened one

The problem this repository exists to solve was found the hard way, in
`mikelward/clothescast`'s CI: a job that runs PR-controlled code (a test
suite, in that case) and then commits rendered output back to the PR branch,
all in one job, hands the commit's git operations to an environment that
code just ran in. Successive fixes closed `core.hooksPath`, `remote.origin.url`
+ `core.sshCommand`, `commit.gpgSign` + `gpg.program`, `url.*.insteadOf`, and
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env injection — each
a genuinely different mechanism, and then `GIT_TEMPLATE_DIR` + a planted
`post-checkout` hook turned up as a further one, not covered by any of the
above. That pattern — patch one git-reads-this-env-var mechanism, another
surfaces — does not converge, because the list of such mechanisms is git's,
not ours, and it is not closed.

**The fix is structural, not another entry on the list.** This workflow's job
never executes anything from the pull request — no build tool, no test
runner, no dependency install, nothing the calling workflow's own render job
ran. It receives only the *rendered output*, as a downloaded artifact — inert
data, not an execution environment — so an ordinary checkout, commit, and
push here is trustworthy by construction. Do not "hurry" a future fix by
adding config-nulling or hook-wrapping back into this workflow: that is
solving a problem this workflow's whole design already doesn't have, and it
muddies the actual guarantee (nothing PR-controlled has run in this process)
with defense-in-depth for a threat that isn't present here.

## What this repository must not grow

- **No dependencies. No `package.json`, no lockfile, no build step.** What a
  consumer's workflow runs is the YAML in this repository, which is what
  makes an unpinned `@main` reference reviewable by reading it.
- **Nothing build-tool-specific.** What gets rendered (Kotlin/Roborazzi,
  screenshot tooling, codegen, whatever) is the calling workflow's business;
  this workflow only ever sees a named artifact and a destination path.
  A consumer's own pre-upload filtering (clothescast's orphaned-PNG pruning,
  for one) belongs in the *render* job, before the artifact is uploaded —
  never here.

## Testing

- `node --test *.test.js`. No install step — there is nothing to install.
  The one setup step is a one-time
  `git clone https://github.com/mikelward/yaml-lite ../yaml-lite` (a git
  clone, not a package manager): the structural tests resolve the parser
  from CI's `.yaml-lite/` checkout or that sibling clone, and fail with
  that exact command — never skip — when both are missing.
- **Add or update tests with any change.** This suite is the only thing
  between a push and every consumer's next run, so a change that ships
  untested ships unreviewed.
- The suite's failure mode is a *false pass* — a set difference against an
  empty set is empty, a matcher that forgets to assert is green — so assert
  behavior, and where a check is derived from parsing the workflow YAML,
  assert first that the parse found something.
- **Fix any preexisting test failure as the first commit of the series.**
  Don't stack new work on a red baseline.
- **Don't disable a failing check** to make it pass, and don't paper over a
  flaky one with sleeps or retries — fix the underlying issue.

## Error handling

- **Don't silently swallow errors.** A discarded rejection or an unchecked
  exit status here means a commit that silently never landed, or landed onto
  branch content nobody verified. Report what failed with enough context to
  identify it, and decide explicitly what the caller sees. To ignore a
  specific failure, say why in a one-line comment.

## Git and pull requests

- **Branch naming.** `<agent>/<short-topic>` — `claude/...` for Claude Code,
  `codex/...` for Codex. One topic per branch; never commit to `main` (the
  one exception is the initial scaffolding commit that created this
  repository, made directly to an empty `main` at the repo owner's request).
- **One commit per logical change.** Rewrite unmerged commits freely — amend,
  `--fixup` + autosquash, squash, reorder, split — so each commit that lands is
  coherent, with review responses folded into the commit they belong to.
  `--force-with-lease` after a rebase, never a bare `--force`.
- **Open the pull request without being asked**, ready for review, not a draft.
- **Refresh the title and body on every push** so they describe the branch's
  latest state, not the scope it had when opened.
- **Codex is the automated reviewer**, and its reviews are triggered
  automatically. Address its comments without being asked, folding each fix
  into the commit it belongs to. Judge every comment on merit: verify the claim
  before acting, and if it doesn't hold up, reply saying why and decline.
- **Never leave a review thread silently dismissed** — every thread ends in a
  reply or a resolve.

## Language and spelling

- Use **US English** everywhere people read English: prose, commit subjects and
  bodies, pull request titles and descriptions, comments, and identifiers —
  `behavior` not `behaviour`, `canceled` not `cancelled`.

## Commit messages

- A clear, plain-English subject in sentence case, short (≤ ~70 chars) and free
  of internal jargon. Mechanism and file:line detail go in the body, after a
  blank line.
- **Prefix a subject that does not change what a consumer runs**: `docs:` for
  prose, `test:` for tests alone, `build:` for this repository's own CI, and
  `refactor:` for deliberately behavior-preserving code. A bare subject means a
  consumer could notice the difference. There is no `feat:` or `fix:`, on
  purpose — they would prefix nearly everything and leave the log as flat as it
  started.

## Talking to the user

- **Respond to a mid-turn message immediately.** When the user sends a message
  while you're still working — surfaced as a "sent while you were working"
  interjection — address it in your very next output, before starting or
  continuing any further tool call, even if it's only one sentence. Don't let
  it queue up behind an in-flight chain of tool calls.
- **One question at a time**, asked in plain chat rather than a structured
  picker, and wait for the answer before proceeding on an assumed one.

## Privacy

- **Never put user data in any artifact that leaves this machine** — commit
  subjects and bodies, pull request text, review replies, branch names,
  comments, or fixtures. Use generic placeholders (`/home/user/project`,
  `example.com`, `abc1234`) in examples and fixtures.
