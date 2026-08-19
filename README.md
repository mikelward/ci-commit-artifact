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

See `.github/workflows/commit-artifact.yml` for the full input/output
reference, and `AGENTS.md` for the reasoning behind each guard.
