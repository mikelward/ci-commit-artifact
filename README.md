# ci-commit-artifact

A reusable GitHub Actions workflow that commits a build artifact — produced
by an earlier, untrusted job — back to a pull request's branch, from a clean
job where none of that PR's own code has ever executed.

## The problem this solves

A CI job that renders something from PR-controlled code (a test suite, a
screenshot/snapshot regen, a codegen step) and then commits the result back
to the PR branch, all in the *same* job, hands that commit's git operations
to an environment the PR's own code just ran in. That is a real privilege
escalation surface: a lifecycle script, a test, or any other PR-controlled
code that ran earlier in the job can plant a hook, rewrite git config, point
`GIT_TEMPLATE_DIR` at a hostile template, or otherwise get code execution
with whatever token the push step holds — often `contents: write`.

Patching each of those individually (null out config files, unset
`GIT_CONFIG_*` env vars, wrap `core.hooksPath`) chases an open-ended list:
every fix closes one mechanism and the next one found is a different
mechanism. The actual fix is structural — do the git work in a job that
never ran any of that code in the first place, and hand it only the
*rendered output* (a workflow artifact — inert data, not an execution
environment) rather than the working tree the untrusted job already touched.

## What it does

Call it as a job in your own workflow, right after the job that renders
the artifact:

```yaml
jobs:
  render:
    runs-on: ubuntu-latest
    steps:
      # ... runs PR-controlled code, renders app/snapshots/, then:
      - uses: actions/upload-artifact@v7
        with:
          name: my-artifact
          path: app/snapshots/

  commit:
    needs: render
    # head.repo.full_name == repository is required, not optional: this
    # workflow always checks out and pushes to the CALLER's own repository
    # (github.repository), authenticated with the caller's own GITHUB_TOKEN.
    # A fork PR's branch doesn't exist there at all — checkout would simply
    # fail — UNLESS the base repo happens to have a same-named branch, in
    # which case it would silently check out and commit to the wrong branch
    # instead. Same-repo PRs only.
    if: >-
      needs.render.result == 'success' && github.event_name == 'pull_request'
      && github.event.pull_request.head.repo.full_name == github.repository
    permissions:
      contents: write
      actions: write
    uses: mikelward/ci-commit-artifact/.github/workflows/commit-artifact.yml@main
    with:
      artifact-name: my-artifact
      dest-path: app/snapshots
      commit-message: "ci: regenerate snapshots"
      branch-ref: ${{ github.event.pull_request.head.ref }}
      expected-head-sha: ${{ github.event.pull_request.head.sha }}
      pr-number: ${{ github.event.pull_request.number }}
      dispatch-workflow: ci.yml
```

The `commit` job's own steps never execute anything from the pull request —
no build tool, no test runner, no dependency install — so an ordinary
checkout, commit, and push there is trustworthy by construction.

## `pull_request_target` callers: pass `push-token`

A GITHUB_TOKEN-authored push starts no workflow run on its own, so the
example above relies on `dispatch-workflow` to retrigger CI. That is only
safe for a caller triggered by plain `pull_request` — `pull_request_target`
always reads the workflow *definition* from the repository's default
branch regardless of which ref actually runs, so dispatching onto the PR's
own branch there would instead execute that branch's own, potentially
PR-controlled, copy of the workflow file.

This workflow reads which event triggered the calling workflow itself
(`github.event_name`, shared with the caller for the whole run) rather than
taking a caller's word for it, so there's nothing to declare either way — a
`pull_request_target` caller just passes a `push-token` secret, a
fine-grained PAT (Contents: read and write, scoped to that repository
only). An authenticated push looks like an ordinary push and retriggers the
caller's own trigger directly, no dispatch involved (and
`dispatch-workflow`, if still set, is silently skipped rather than firing a
redundant second run). The name doesn't matter to this workflow —
`secrets.push-token` is just an input — but consumers across this fleet
name the repository secret `CI_COMMIT_ARTIFACT_TOKEN`, so the same PAT can
back any future caller that needs this same commit-back mechanism for a
different kind of artifact:

```yaml
    uses: mikelward/ci-commit-artifact/.github/workflows/commit-artifact.yml@main
    with:
      # ... same as above
    secrets:
      push-token: ${{ secrets.CI_COMMIT_ARTIFACT_TOKEN }}
```

## Keep the token in an environment: pass `secrets: inherit`

A repository-level `CI_COMMIT_ARTIFACT_TOKEN` reaches every job of every
workflow in the consumer that inherits it -- including the untrusted
update jobs of the weekly dependency batches (mikelward/npm-update,
gradle-update, rust-update), which run whatever they resolved and take
`secrets: inherit` from their callers. The `commit` job here runs nothing
from the pull request, so it is the right scope for the PAT and nothing
else is: keep the token as `CI_COMMIT_ARTIFACT_TOKEN` in an environment
named `ci-commit-artifact` (the `environment` input's default; the job
declares it, and reads the environment secret ahead of `push-token`), and
pass `secrets: inherit` instead of naming the secret -- an environment
secret reaches a called workflow no other way:

```yaml
    uses: mikelward/ci-commit-artifact/.github/workflows/commit-artifact.yml@main
    with:
      # ... same as above
    secrets: inherit
```

`repo setup --credential CI_COMMIT_ARTIFACT_TOKEN=PATH OWNER/REPO` in
mikelward/repo makes the move -- sets the environment secret, then deletes
the repository-level copy -- and refuses while a caller still names the
secret, since the copy is what that caller passes. The environment needs
no protection rules; a required reviewer there would hold every
screenshot commit for approval.

See `.github/workflows/commit-artifact.yml` for the full input/output
reference, and `AGENTS.md` for the reasoning behind each guard.
