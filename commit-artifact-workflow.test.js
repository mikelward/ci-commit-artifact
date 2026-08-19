// Tests for .github/workflows/commit-artifact.yml, asserting real structure
// via yaml-lite.js rather than regex/string-matching over the serialized
// text. An earlier draft of this file used regexes (matching npm-update's
// convention) and produced a genuinely broken test — an unbounded lazy
// match (`(?:.*\n)*?`) that could span past the input it was checking and
// match a later, unrelated one — which is exactly the false-pass failure
// mode this repo's own AGENTS.md warns about. yaml-lite.js exists so this
// suite can ask real questions of real structure instead.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const os = require("node:os");
const { parseWorkflowYaml } = require("./yaml-lite.js");

const WORKFLOW_PATH = path.join(
  __dirname,
  ".github/workflows/commit-artifact.yml",
);
const workflowText = fs.readFileSync(WORKFLOW_PATH, "utf8");
const doc = parseWorkflowYaml(workflowText);
const steps = doc.jobs.commit.steps;

function step(name) {
  const s = steps.find((s) => s.name === name);
  assert.ok(s, `step "${name}" not found`);
  return s;
}

test("is callable only via workflow_call, not directly triggerable", () => {
  assert.deepEqual(Object.keys(doc.on), ["workflow_call"]);
});

test("has no workflow-level permissions block wider than the single job's own", () => {
  // This workflow has exactly one job, so its own `permissions:` (asserted
  // below) is the only place permissions should be declared — a
  // workflow-level block here would either be redundant or, worse, silently
  // widen what the job gets beyond its own declared needs.
  assert.equal(doc.permissions, undefined);
  assert.ok(doc.jobs.commit.permissions, "the commit job should declare its own permissions");
});

test("declares every required input, and every optional one with a default", () => {
  const inputs = doc.on.workflow_call.inputs;
  const required = [
    "artifact-name",
    "dest-path",
    "commit-message",
    "branch-ref",
    "expected-head-sha",
  ];
  for (const name of required) {
    assert.ok(inputs[name], `missing input: ${name}`);
    assert.equal(inputs[name].required, true, `${name} should be required`);
  }
  const optional = ["pr-number", "dispatch-workflow", "comment-marker", "artifact-noun"];
  for (const name of optional) {
    assert.ok(inputs[name], `missing input: ${name}`);
    assert.equal(inputs[name].required, false, `${name} should be optional`);
    assert.notEqual(inputs[name].default, undefined, `${name} should declare a default`);
  }
});

test("branch-ref documents the same-repo-only constraint", () => {
  // This workflow always checks out and pushes to the CALLER's own
  // repository (github.repository) — a fork PR's branch either doesn't
  // exist there (checkout fails loudly) or, worse, could silently resolve
  // a same-named branch in the base repo. Callers need to gate on
  // head.repo.full_name themselves; the input description is where that
  // constraint has to live since there's no runtime signal here to check it.
  const description = doc.on.workflow_call.inputs["branch-ref"].description;
  assert.match(description, /head\.repo\.full_name/);
});

test("exposes committed and commit-sha as job outputs, wired to the job's own step outputs", () => {
  const outputs = doc.on.workflow_call.outputs;
  assert.match(outputs.committed.value, /\$\{\{ jobs\.commit\.outputs\.committed \}\}/);
  assert.match(outputs["commit-sha"].value, /\$\{\{ jobs\.commit\.outputs\.commit_sha \}\}/);
  assert.match(doc.jobs.commit.outputs.committed, /steps\.commit\.outputs\.committed/);
  assert.match(doc.jobs.commit.outputs.commit_sha, /steps\.commit\.outputs\.commit_sha/);
});

test("the committed output falls back to 'false' when the commit step never ran", () => {
  // steps.commit.outputs.committed is unset (empty string), not the string
  // 'false', whenever the commit step is skipped (a moved branch, or a
  // failed/missing download) — the documented output contract promises
  // 'false' there, which only the || fallback delivers.
  assert.match(doc.jobs.commit.outputs.committed, /steps\.commit\.outputs\.committed \|\| 'false'/);
});

test("fails fast, before checkout, when comment-marker or dispatch-workflow is set without pr-number", () => {
  // The freshness-comment step's own if: already no-ops silently when
  // pr-number is '', and the dispatch step would pass an empty -f pr= —
  // this validation exists so a caller who set either without pr-number
  // gets a clear, loud reason instead of a silently-missing comment or a
  // dispatch call carrying no PR.
  const checkoutIdx = steps.findIndex((s) => s.uses && s.uses.startsWith("actions/checkout"));
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  assert.ok(validateIdx > -1, "no validation step found");
  assert.ok(validateIdx < checkoutIdx, "validation must run before checkout, not after");
  const validate = steps[validateIdx];
  // The step's own if: only decides whether it runs at ALL (skip the check
  // entirely for a caller that sets none of the three inputs) — the actual
  // missing-pr-number logic now lives in the run: block, alongside the
  // format check below, so both conditions get their own named error.
  assert.match(
    validate.if,
    /inputs\.pr-number != '' \|\| inputs\.comment-marker != '' \|\| inputs\.dispatch-workflow != ''/,
  );
  assert.match(
    validate.run,
    /\[ -z "\$PR_NUMBER" \] && \{ \[ -n "\$COMMENT_MARKER" \] \|\| \[ -n "\$DISPATCH_WORKFLOW" \]; \}/,
  );
  assert.match(validate.run, /exit 1/);
});

test("fails fast on a pr-number that isn't a positive integer", () => {
  // Number('abc') is NaN; every downstream use of PR_NUMBER (the freshness
  // comment's github.rest.pulls.get, the dispatch step's -f pr=) fails or
  // misbehaves far from here, and the freshness comment's own API errors
  // are caught into a silent skip by design (continue-on-error, for genuine
  // API hiccups) — which would otherwise hide a caller typo behind the same
  // "no comment posted" symptom as a transient failure.
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  const validate = steps[validateIdx];
  assert.match(
    validate.run,
    /\[ -n "\$PR_NUMBER" \] && ! \[\[ "\$PR_NUMBER" =~ \^\[1-9\]\[0-9\]\*\$ \]\]/,
  );
  // Never spliced directly — same reasoning as every other PR-influenced
  // input in this file.
  assert.equal(validate.env.PR_NUMBER, "${{ inputs.pr-number }}");
});

test("refuses to rm -rf a dest-path that isn't a safe relative path inside the checkout", () => {
  // dest-path is owner-configured, not PR-controlled, but a typo (an
  // absolute path, '.', or a '..' escape) would otherwise delete far more
  // than the intended generated-output directory — up to the checkout's own
  // .git. This is the step that actually runs the rm -rf, so the guard has
  // to live in its script, not just somewhere earlier in the job.
  const clearStep = step("Empty the destination before extracting the artifact");
  assert.match(clearStep.run, /realpath -m/, "should canonicalize dest-path before trusting it");
  assert.match(clearStep.run, /GITHUB_WORKSPACE/, "should check the resolved path against the checkout root");
  assert.match(clearStep.run, /\.git/, "should refuse a dest-path resolving inside .git");
  assert.match(clearStep.run, /rm -rf -- "\$DEST_PATH"/);
});

test("the destination is emptied before the artifact is downloaded into it", () => {
  // download-artifact extracts into dest-path, it doesn't replace it — a
  // file the new render dropped would otherwise survive untouched and
  // git add -A would see it as unchanged, silently keeping a deletion out
  // of the commit.
  const clearIdx = steps.findIndex((s) => s.name === "Empty the destination before extracting the artifact");
  const downloadIdx = steps.findIndex((s) => s.name === "Download the artifact");
  assert.ok(clearIdx > -1, "no destination-clearing step found");
  assert.ok(clearIdx < downloadIdx, "the destination must be cleared BEFORE the download, not after");
  const clear = steps[clearIdx];
  assert.match(clear.if, /steps\.guard\.outputs\.skip != 'true'/);
  assert.match(clear.run, /rm -rf -- "\$DEST_PATH"/);
  assert.equal(clear.env["DEST_PATH"], "${{ inputs.dest-path }}");
});

test("checkout drops persist-credentials, since nothing in this job needs a stored token", () => {
  const checkout = steps.find((s) => s.uses && s.uses.startsWith("actions/checkout"));
  assert.ok(checkout, "no actions/checkout step found");
  assert.equal(checkout.with["persist-credentials"], false);
});

test("the branch-moved guard gates both the download and the commit step", () => {
  assert.match(step("Download the artifact").if, /steps\.guard\.outputs\.skip != 'true'/);
  assert.match(step("Commit and push").if, /steps\.guard\.outputs\.skip != 'true'/);
});

test("the commit step only runs after a successful download", () => {
  assert.match(step("Commit and push").if, /steps\.download\.outcome == 'success'/);
});

test("a missing or failed artifact download fails the job LOUDLY, not silently", () => {
  // Reversed from an earlier draft, on a real Codex finding: silently
  // skipping here (continue-on-error) could drop a genuine deletion —
  // dest-path was already emptied by the previous step, so a swallowed
  // download failure would mean the deletion is real but never gets
  // committed, with nothing on the PR to say so. actions/upload-artifact
  // can't represent a legitimately empty render as a real artifact at all,
  // so "missing" and "genuinely empty" are indistinguishable from here — the
  // safe response to that ambiguity is a loud failure, not a guess.
  assert.notEqual(step("Download the artifact")["continue-on-error"], true);
});

const DANGEROUS_INPUTS = [
  "inputs.branch-ref",
  "inputs.dest-path",
  "inputs.commit-message",
  "inputs.expected-head-sha",
  "inputs.dispatch-workflow",
  "inputs.pr-number",
  "inputs.artifact-name",
];

test("PR-influenced inputs are never spliced directly into a run: block — every one goes through env:", () => {
  // branch-ref is the sharpest case: it's the literal branch name a
  // same-repo collaborator chose, and git's check-ref-format allows shell
  // metacharacters (', $, ;, |, &, backticks) in one. Splicing any of these
  // directly into a run: script is the same shape of bug regardless of
  // which input it is.
  for (const s of steps) {
    if (typeof s.run !== "string") continue;
    for (const expr of DANGEROUS_INPUTS) {
      assert.ok(
        !s.run.includes(`\${{ ${expr} }}`),
        `step "${s.name}" splices \${{ ${expr} }} directly into its run: block — route it through env: instead`,
      );
    }
  }
});

test("every dangerous input actually reaches the steps that need it, via env:", () => {
  // The previous test would also pass if an input just went unused
  // entirely — confirm each one is genuinely wired up via some step's env:
  // block, so that test can't pass by accident.
  for (const expr of DANGEROUS_INPUTS) {
    const wired = steps.some(
      (s) => s.env && Object.values(s.env).some((v) => v === `\${{ ${expr} }}`),
    );
    assert.ok(wired, `\${{ ${expr} }} is never assigned to an env var on any step`);
  }
});

test("the github-script body never splices a ${{ inputs.* }} or ${{ steps.* }} expression directly", () => {
  const scriptStep = steps.find((s) => s.uses && s.uses.startsWith("actions/github-script"));
  assert.ok(scriptStep, "no actions/github-script step found");
  assert.doesNotMatch(
    scriptStep.with.script,
    /\$\{\{\s*(inputs|steps)\./,
    "the script body splices a ${{ }} expression directly — that both breaks as JS syntax (the runner substitutes before the script runs) and is a template-injection shape; route the value through env: and read it via process.env instead",
  );
});

test("the artifact is force-added, so a caller's .gitignore can't silently drop new content", () => {
  // dest-path was rm -rf'd and freshly re-extracted from the artifact just
  // above this step, so everything under it right now IS the artifact's own
  // content. A plain `git add -A` silently skips a new file that matches a
  // caller's .gitignore (verified: an untracked, gitignored file under
  // dest-path is left out of the index entirely by `git add -A` alone) —
  // the commit would then succeed while quietly omitting real content, with
  // nothing anywhere reporting it. -f overrides that.
  assert.match(step("Commit and push").run, /git add -f -A -- "\$DEST_PATH"/);
});

test("the git push authenticates via an explicit token URL, not the origin remote name", () => {
  const commit = step("Commit and push").run;
  assert.match(commit, /git push --force-with-lease=[^ ]+ "https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com/);
  assert.doesNotMatch(commit, /git push origin/);
});

test("the push is a lease pinned to the exact SHA the guard step verified, not a plain fast-forward", () => {
  // A plain (non-force) push succeeds on ANY fast-forward, including one
  // from a branch that was deleted-and-recreated or force-reset backward
  // between the guard running and this step reaching the push — the new
  // commit's parent is still an ancestor either way, so a plain push would
  // silently resurrect or undo whatever the intervening change was doing.
  const commitStep = step("Commit and push");
  assert.match(commitStep.env["EXPECTED_HEAD_SHA"], /inputs\.expected-head-sha/);
  assert.match(commitStep.run, /--force-with-lease="\$BRANCH_REF:\$EXPECTED_HEAD_SHA"/);
});

test("CI is dispatched only after a real commit, and only when the caller asked for it", () => {
  assert.match(
    step("Dispatch CI on the new commit").if,
    /steps\.commit\.outputs\.committed == 'true' && inputs\.dispatch-workflow != ''/,
  );
});

test("the freshness comment never runs without both a marker and a PR number", () => {
  assert.match(
    step("Comment freshness on the PR").if,
    /inputs\.comment-marker != '' && inputs\.pr-number != ''/,
  );
});

// Anchored on the actual status-line assignment, not the bare substring
// "up-to-date" — that phrase also appears inside nearby comments explaining
// *why* the checks above it exist, and indexOf() would find those instead.
// An earlier draft of these two tests used the bare substring and passed
// for the wrong reason (the comment occurrence happened to still sit after
// the check being tested) until a later addition moved the ordering enough
// to expose it — caught by rerunning the suite, not by inspection.
const UP_TO_DATE_STATUS_LINE = "status = `✅ ";

test("a failed or missing download reports distinctly, never as up-to-date", () => {
  const script = step("Comment freshness on the PR").with.script;
  const downloadCheckIdx = script.indexOf("DOWNLOAD_OUTCOME !== 'success'");
  const upToDateIdx = script.indexOf(UP_TO_DATE_STATUS_LINE);
  assert.ok(downloadCheckIdx > -1, "no DOWNLOAD_OUTCOME check found in the freshness script");
  assert.ok(upToDateIdx > -1, "no up-to-date status line found in the freshness script");
  assert.ok(
    downloadCheckIdx < upToDateIdx,
    "the download-outcome check must come before the up-to-date branch in the if/else chain, or a failed download would misreport as up-to-date",
  );
});

test("a failed commit step reports distinctly, never as up-to-date", () => {
  // The commit step only runs when download succeeded (its own if:
  // requires it), so by the time DOWNLOAD_OUTCOME has been checked and
  // passed, a non-success steps.commit.outcome can only mean the commit
  // step ran and failed — a rejected push from a race, say — not "nothing
  // to commit". COMMITTED is unset in both cases, so without this check a
  // real failure would silently misreport as the clean case.
  const script = step("Comment freshness on the PR").with.script;
  const downloadCheckIdx = script.indexOf("DOWNLOAD_OUTCOME !== 'success'");
  const commitCheckIdx = script.indexOf("COMMIT_OUTCOME !== 'success'");
  const upToDateIdx = script.indexOf(UP_TO_DATE_STATUS_LINE);
  assert.ok(downloadCheckIdx > -1 && commitCheckIdx > -1 && upToDateIdx > -1);
  assert.ok(
    downloadCheckIdx < commitCheckIdx && commitCheckIdx < upToDateIdx,
    "order must be: DOWNLOAD_OUTCOME, then COMMIT_OUTCOME, then the up-to-date branch",
  );
});

test("the SKIPPED (branch-moved) case is checked before DOWNLOAD_OUTCOME in the freshness script", () => {
  // download.outcome reads 'skipped' (not 'success') when the guard itself
  // skipped the download step — so SKIPPED must be checked first, or a
  // moved branch would misreport as "could not verify" instead of "branch
  // advanced mid-run".
  const script = step("Comment freshness on the PR").with.script;
  const skippedIdx = script.indexOf("SKIPPED === 'true'");
  const downloadCheckIdx = script.indexOf("DOWNLOAD_OUTCOME !== 'success'");
  assert.ok(skippedIdx > -1 && downloadCheckIdx > -1);
  assert.ok(skippedIdx < downloadCheckIdx);
});

test("the freshness comment re-checks the PR's live head before writing a DOWNLOAD/COMMIT/COMMITTED status, and skips on a mismatch", () => {
  // Overlapping runs are expected (cancel-in-progress is asynchronous), so
  // an older run can reach this step after a newer run already posted an
  // accurate status for the DOWNLOAD/COMMIT/COMMITTED branches (the ones
  // guard confirmed ran against the still-current expected-head-sha).
  // Without re-confirming the PR's head is still what this run's own
  // HEAD_SHA is about, whichever run's write happens to land LAST wins —
  // even a stale "download failed"/"commit failed"/"up-to-date" overwriting
  // a fresh, accurate comment, with no further push coming to correct it.
  const script = step("Comment freshness on the PR").with.script;
  const paginateIdx = script.indexOf("github.paginate(github.rest.issues.listComments");
  const pullsGetIdx = script.indexOf("github.rest.pulls.get(");
  const mismatchIdx = script.indexOf("pr.data.head.sha !== process.env.HEAD_SHA");
  const updateIdx = script.indexOf("github.rest.issues.updateComment(");
  const createIdx = script.indexOf("github.rest.issues.createComment(");
  assert.ok(paginateIdx > -1, "no comment-listing call found in the freshness script");
  assert.ok(pullsGetIdx > -1, "no live-head re-fetch found in the freshness script");
  assert.ok(mismatchIdx > -1, "no HEAD_SHA mismatch check found in the freshness script");
  assert.ok(updateIdx > -1 && createIdx > -1);
  assert.ok(
    pullsGetIdx < mismatchIdx && mismatchIdx < updateIdx && mismatchIdx < createIdx,
    "the live-head check must run, and be evaluated, before either comment-write call — or a stale run could still overwrite a fresher one",
  );
  // The GitHub REST API has no conditional-write primitive for issue
  // comments, so the closest approximation to atomicity with the write is
  // running the re-check AFTER the (potentially multi-request, paginated)
  // comment-listing call rather than before it — that's the dominant
  // contributor to the async gap between "confirmed current" and "actually
  // wrote". Checking first and listing second would leave the whole
  // listComments await unguarded.
  assert.ok(
    paginateIdx < pullsGetIdx,
    "the comment-listing call must happen BEFORE the live-head re-check, not after — checking first only to await listComments afterward leaves that whole window unguarded",
  );
  // Never spliced directly into the run: block — same injection concern as
  // every other PR-influenced value in this file (see the sibling test
  // above), so this must reach the script only via `process.env`.
  assert.match(script, /await github\.rest\.pulls\.get\(\{ \.\.\.context\.repo, pull_number: prNumber \}\)/);
});

// Extracts the literal text of one branch of the if/else chain, by its own
// opening condition through to the line that opens the NEXT branch (or
// closes the chain). Fragile only to a rewrite of these exact condition
// strings, which every other test in this file already depends on too.
function freshnessBranch(script, openMarker, closeMarker) {
  const start = script.indexOf(openMarker);
  assert.ok(start > -1, `branch opener not found: ${openMarker}`);
  const end = script.indexOf(closeMarker, start);
  assert.ok(end > -1, `branch closer not found: ${closeMarker}`);
  return script.slice(start, end);
}

test("a checkout/guard/clear failure reports WITHOUT the live-head re-check gating it", () => {
  // guard may not have even run when checkout itself fails, so HEAD_SHA can
  // be empty here — a live-head comparison gating this branch would make it
  // unreachable (an empty HEAD_SHA never equals a real PR head sha), and an
  // early failure like this is worth surfacing regardless of what any other
  // overlapping run goes on to report. Regression coverage for the earlier
  // version of this fix, which put the live-head check ahead of every
  // status branch including this one.
  const script = step("Comment freshness on the PR").with.script;
  const branch = freshnessBranch(
    script,
    "process.env.CHECKOUT_OUTCOME !== 'success'",
    "process.env.SKIPPED === 'true'",
  );
  assert.ok(branch.includes("An earlier step failed"), "early-failure status text not found in its own branch");
  assert.ok(!branch.includes("pulls.get"), "the early-failure branch must not depend on the live-head re-check");
  // Not just "not textually inside this branch" — the live-head check must
  // not sit ahead of the WHOLE if/else chain either, gating this branch's
  // reachability at runtime without appearing inside its own text. The
  // CHECKOUT_OUTCOME check is this script's first real statement (after the
  // marker/noun/headSha/prNumber declarations); the live-head re-check
  // fetch is not.
  const checkoutCheckIdx = script.indexOf("process.env.CHECKOUT_OUTCOME !== 'success'");
  const pullsGetIdx = script.indexOf("github.rest.pulls.get(");
  assert.ok(checkoutCheckIdx > -1 && pullsGetIdx > -1);
  assert.ok(
    checkoutCheckIdx < pullsGetIdx,
    "the CHECKOUT_OUTCOME check must run before the live-head re-check, not be gated behind it",
  );
});

test("a SKIPPED (branch-moved) run posts nothing at all, rather than risking a stale overwrite", () => {
  // A skipped run's HEAD_SHA falls back to guard's own actual_head_sha —
  // the head it OBSERVED, not a head this run produced or confirmed as
  // current. A legitimate "up-to-date" run for that SAME head reports the
  // identical HEAD_SHA once nothing has changed since, so a live-head
  // comparison can't tell a skipped run's stale deferral apart from a
  // genuine, current report for the same head: both compare equal to the
  // live head whenever nothing has moved. The only fix that actually closes
  // that ambiguity is not posting anything for a skipped run at all — the
  // run that pushed the newer head is responsible for reporting on it.
  const script = step("Comment freshness on the PR").with.script;
  const branch = freshnessBranch(script, "process.env.SKIPPED === 'true'", "} else {");
  assert.match(branch, /\breturn;/, "the SKIPPED branch must return without posting a comment");
  assert.ok(!branch.includes("pulls.get"), "the SKIPPED branch must not perform (or depend on) the live-head re-check");
  assert.ok(!branch.includes("status ="), "the SKIPPED branch must not build a status message to post");
});

test("checkout/guard/clear failing before the download step is checked reports distinctly, first in the chain", () => {
  // checkout, guard, and clear all run unconditionally (or run whenever
  // guard itself succeeded) ahead of the download step — a non-success
  // outcome from any of them means the job failed before download ever got
  // a chance to run, which must not fall through to "artifact wasn't
  // available" (blames the wrong step) or "branch advanced" (guard itself
  // may not have even produced a skip output).
  const checkoutStep = step("Check out the branch");
  assert.equal(checkoutStep.id, "checkout", "checkout step needs an id so its outcome is readable");
  const clearStep = step("Empty the destination before extracting the artifact");
  assert.equal(clearStep.id, "clear", "clear step needs an id so its outcome is readable");
  const script = step("Comment freshness on the PR").with.script;
  const earlyFailureIdx = script.indexOf("CHECKOUT_OUTCOME !== 'success'");
  const skippedIdx = script.indexOf("SKIPPED === 'true'");
  const downloadCheckIdx = script.indexOf("DOWNLOAD_OUTCOME !== 'success'");
  assert.ok(earlyFailureIdx > -1, "no CHECKOUT_OUTCOME check found in the freshness script");
  assert.ok(
    earlyFailureIdx < skippedIdx && skippedIdx < downloadCheckIdx,
    "order must be: earlier-step-failure check, then SKIPPED, then DOWNLOAD_OUTCOME",
  );
  assert.match(script, /GUARD_OUTCOME !== 'success'/);
  // clear is gated on guard's own skip output, so 'skipped' is its normal
  // outcome in the legitimate branch-moved case — only an actual 'failure'
  // there should count as an earlier-step failure, not '!== success' (which
  // would also fire on the ordinary skip and misreport it).
  assert.match(script, /CLEAR_OUTCOME === 'failure'/);
});

test("every run: block in the workflow is syntactically valid bash", () => {
  let checked = 0;
  for (const s of steps) {
    if (typeof s.run !== "string") continue;
    checked++;
    const tmp = path.join(os.tmpdir(), `commit-artifact-step-${checked}.sh`);
    fs.writeFileSync(tmp, s.run);
    execFileSync("bash", ["-n", tmp]);
    fs.unlinkSync(tmp);
  }
  assert.ok(checked > 0, "no run: steps found — test isn't exercising anything");
});

test("the github-script body is syntactically valid JavaScript", () => {
  const scriptStep = steps.find((s) => s.uses && s.uses.startsWith("actions/github-script"));
  assert.ok(scriptStep);
  // Wrapped in an async IIFE, matching how github-script actually invokes
  // it (it awaits the script body, so top-level await is valid there).
  new Function(
    "github",
    "context",
    "core",
    `return (async () => {\n${scriptStep.with.script}\n})();`,
  );
});
