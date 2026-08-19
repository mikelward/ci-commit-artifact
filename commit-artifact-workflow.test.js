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
  // Exact values, not just truthiness — a truthiness-only check stays green
  // even if a scope silently widens (or narrows to the point of breaking
  // the job) to something other than what's actually needed: contents:write
  // to push the commit, pull-requests:write for the freshness comment,
  // actions:write for the download-artifact read + workflow dispatch.
  assert.deepEqual(doc.jobs.commit.permissions, {
    contents: "write",
    "pull-requests": "write",
    actions: "write",
  });
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
  // The step itself runs UNCONDITIONALLY now (no if: at all) — it also
  // validates expected-head-sha's format, which is always required and
  // always worth checking, so it can no longer skip itself the way it did
  // when it only had the three optional inputs to check. The actual
  // missing-pr-number logic lives in the run: block, alongside the format
  // check below, so both conditions get their own named error.
  assert.equal(validate.if, undefined, "the validation step should run unconditionally");
  assert.match(
    validate.run,
    /\[ -z "\$PR_NUMBER" \] && \{ \[ -n "\$COMMENT_MARKER" \] \|\| \[ -n "\$DISPATCH_WORKFLOW" \]; \}/,
  );
  assert.match(validate.run, /exit 1/);
});

test("fails fast on an empty branch-ref, before checkout can silently fall back", () => {
  // Real Codex finding: actions/checkout treats an empty `ref:` as unset
  // and silently falls back to the triggering event's own ref (typically
  // the synthetic merge commit on a pull_request run) instead of failing.
  // The checkout would then succeed against the WRONG commit, and the
  // guard step's mismatch against expected-head-sha would read as the same
  // ordinary "branch-ref advanced" race this workflow already handles —
  // leaving the run green with committed: false instead of surfacing the
  // caller's empty context expression. Same underlying shape as the
  // expected-head-sha check below: required: true only checks the caller
  // supplied the KEY, not that its value is non-empty.
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  const validate = steps[validateIdx];
  assert.equal(validate.env.BRANCH_REF, "${{ inputs.branch-ref }}");
  assert.match(validate.run, /\[ -z "\$BRANCH_REF" \]/);

  // Real execution, not just a structural regex: an empty BRANCH_REF must
  // exit nonzero, and a real one must not trip this check.
  const runCase = (branchRef) => {
    try {
      execFileSync("bash", ["-c", validate.run], {
        env: {
          ...process.env,
          ARTIFACT_NAME: "ui-snapshots",
          BRANCH_REF: branchRef,
          EXPECTED_HEAD_SHA: "a".repeat(40),
          PR_NUMBER: "",
          COMMENT_MARKER: "",
          DISPATCH_WORKFLOW: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0 };
    } catch (e) {
      return { code: e.status, output: String(e.stdout) + String(e.stderr) };
    }
  };
  const empty = runCase("");
  assert.equal(empty.code, 1, "an empty branch-ref must be rejected");
  assert.match(empty.output, /branch-ref is ''/);
  assert.equal(runCase("feature/some-branch").code, 0, "a real branch-ref must not be rejected");
});

test("fails fast on an empty artifact-name, before download-artifact can silently download everything", () => {
  // Real Codex finding, verified against actions/download-artifact's own
  // source before fixing: `const isSingleArtifactDownload = !!inputs.name`
  // treats an empty string exactly like an omitted input, so it falls into
  // the "download every artifact in the run" path instead of failing on a
  // name that doesn't exist. Same underlying shape as branch-ref and
  // expected-head-sha: required: true only checks the caller supplied the
  // KEY, not that its value is non-empty.
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  const validate = steps[validateIdx];
  assert.equal(validate.env.ARTIFACT_NAME, "${{ inputs.artifact-name }}");
  assert.match(validate.run, /\[ -z "\$ARTIFACT_NAME" \]/);

  const runCase = (artifactName) => {
    try {
      execFileSync("bash", ["-c", validate.run], {
        env: {
          ...process.env,
          ARTIFACT_NAME: artifactName,
          BRANCH_REF: "feature/some-branch",
          EXPECTED_HEAD_SHA: "a".repeat(40),
          PR_NUMBER: "",
          COMMENT_MARKER: "",
          DISPATCH_WORKFLOW: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0 };
    } catch (e) {
      return { code: e.status, output: String(e.stdout) + String(e.stderr) };
    }
  };
  const empty = runCase("");
  assert.equal(empty.code, 1, "an empty artifact-name must be rejected");
  assert.match(empty.output, /artifact-name is ''/);
  assert.equal(runCase("ui-snapshots").code, 0, "a real artifact-name must not be rejected");
});

test("fails fast on an expected-head-sha that isn't a real full commit SHA", () => {
  // A caller typically supplies github.event.pull_request.head.sha, which
  // is EMPTY on any event without a pull_request context (workflow_dispatch,
  // say) — and workflow_call's required: true only checks the caller
  // supplied the input KEY, not that its value is non-empty. Without this
  // check, an empty EXPECTED_HEAD_SHA would compare unequal to guard's real
  // actual_head_sha unconditionally, and the mismatch is read as "branch-ref
  // advanced, skip" (a ::warning::, non-fatal) — a caller misconfiguration
  // silently absorbed as the ordinary race this workflow already handles.
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  const validate = steps[validateIdx];
  assert.equal(validate.env.EXPECTED_HEAD_SHA, "${{ inputs.expected-head-sha }}");
  assert.match(validate.run, /! \[\[ "\$EXPECTED_HEAD_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
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
  // $resolved, not the raw $DEST_PATH: rm resolves a path by actually
  // traversing each component, so a dest-path like "missing/../snapshots"
  // (where "missing" doesn't exist) validates fine — realpath -m collapses
  // '..' lexically without touching the filesystem — but then silently
  // deletes NOTHING when passed to rm literally, since -f suppresses the
  // "no such file or directory" from the failed traversal into "missing".
  // Verified with a real filesystem before fixing.
  assert.match(clearStep.run, /rm -rf -- "\$resolved"/);
  assert.doesNotMatch(clearStep.run, /rm -rf -- "\$DEST_PATH"/);
});

test("rejects any dest-path starting with a tilde before it ever reaches download-artifact", () => {
  // Real Codex finding, verified against actions/download-artifact's own
  // source before fixing: this step's `realpath -m` never expands a
  // leading '~' (it's a plain canonicalizer, not a shell), so "~/foo"
  // validates HERE as the literal, harmless subdirectory
  // $GITHUB_WORKSPACE/~/foo — but the download step hands the RAW,
  // unvalidated dest-path string to actions/download-artifact's `path:`
  // input, whose own code (`if (inputs.path.startsWith('~')) inputs.path =
  // inputs.path.replace('~', os.homedir())`) expands it to the runner's
  // real home directory. What gets validated and what actually receives
  // the artifact would silently be two different paths.
  //
  // A first version of this fix only rejected an exact "~" or "~/..." --
  // a second real finding on that revision: startsWith('~') is true for
  // ANY leading tilde, slash or not, and `.replace('~', X)` is a plain
  // substring swap with no separator inserted, so "~snapshots" becomes
  // homedir+"snapshots" concatenated directly (verified with the actual
  // JS replace before widening the shell pattern) -- a value the
  // narrower "~"|"~"/* pattern let straight through.
  const clearStep = step("Empty the destination before extracting the artifact");
  assert.match(clearStep.run, /"~"\*/, "should reject any leading tilde, not just a bare or slash-prefixed one");

  const runClear = (destPath) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tilde-reject-"));
    try {
      const result = { code: 0, output: "" };
      try {
        result.output = execFileSync("bash", ["-c", clearStep.run], {
          cwd: workspace,
          env: { ...process.env, GITHUB_WORKSPACE: workspace, DEST_PATH: destPath },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
      } catch (e) {
        result.code = typeof e.status === "number" ? e.status : 1;
        result.output = String(e.stdout || "") + String(e.stderr || "");
      }
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };
  const bare = runClear("~");
  assert.equal(bare.code, 1, "a bare '~' must be rejected");
  assert.match(bare.output, /dest-path must be a non-empty path/);
  const prefixed = runClear("~/evil");
  assert.equal(prefixed.code, 1, "a '~/...' dest-path must be rejected");
  assert.match(prefixed.output, /dest-path must be a non-empty path/);
  const noSlash = runClear("~snapshots");
  assert.equal(noSlash.code, 1, "a '~name' dest-path with no slash must be rejected too");
  assert.match(noSlash.output, /dest-path must be a non-empty path/);
  // Regression: a tilde NOT at the very start is not expanded by
  // download-artifact's own check (a plain `startsWith('~')`), so it must
  // not be rejected here either.
  const midString = runClear("safe/~evil");
  assert.equal(midString.code, 0, "a tilde that isn't the first character must not be rejected");
});

test("rejects a dest-path with a .git component at any depth, not just at the checkout root", () => {
  // Real Codex finding, verified directly before fixing: git refuses to
  // track anything under a directory literally named .git anywhere in the
  // path -- `git add -f -A -- fixtures/repo/.git` exits 0 and stages
  // NOTHING, even with -f. The old check only rejected .git AT the
  // checkout root, so "fixtures/repo/.git" would pass validation, get
  // emptied and re-downloaded into just fine, and then the "Commit and
  // push" step's `git add -f -A` would silently stage none of it -- the
  // run would report committed=false as if there was nothing to commit,
  // when really the artifact landed on disk and never made it into git.
  const clearStep = step("Empty the destination before extracting the artifact");
  assert.match(
    clearStep.run,
    /"\$GITHUB_WORKSPACE"\/\*\/\.git\|"\$GITHUB_WORKSPACE"\/\*\/\.git\/\*/,
    "should reject a .git component at any depth, not just the root",
  );

  const runClear = (destPath) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nested-git-reject-"));
    try {
      const result = { code: 0, output: "" };
      try {
        result.output = execFileSync("bash", ["-c", clearStep.run], {
          cwd: workspace,
          env: { ...process.env, GITHUB_WORKSPACE: workspace, DEST_PATH: destPath },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
      } catch (e) {
        result.code = typeof e.status === "number" ? e.status : 1;
        result.output = String(e.stdout || "") + String(e.stderr || "");
      }
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };
  const oneLevel = runClear("fixtures/repo/.git");
  assert.equal(oneLevel.code, 1, "a .git one level down must be rejected");
  assert.match(oneLevel.output, /resolves through a \.git directory/);
  const deeper = runClear("a/b/c/.git/hooks");
  assert.equal(deeper.code, 1, "a .git several levels down must be rejected");
  // Regressions: a name that merely LOOKS like .git must still be allowed.
  assert.equal(runClear("foo.gitignore").code, 0, "a .gitignore-like name must not be rejected");
  assert.equal(runClear("build.git-output").code, 0, "a name containing .git- must not be rejected");
});

test("refuses to rm -rf a dest-path that resolves through a symlink, direct or intermediate", () => {
  // Real gap, found by Codex review and verified against a real filesystem
  // before this test was written: realpath -m follows symlinks in every
  // existing leading path component. The checkout at branch-ref is a PR's
  // own branch content, so a PR that replaces the intended destination (or
  // any directory above it) with a symlink to some OTHER real directory in
  // the checkout makes $resolved point there instead — the containment
  // checks (inside GITHUB_WORKSPACE, not .git) pass regardless, since the
  // symlink's target is still somewhere in the checkout, and this step then
  // deletes that other directory's contents while the symlink itself
  // survives, dangling. Executes the actual step script against a real
  // filesystem rather than asserting structure, since the earlier
  // git-pathspec and __proto__ fixes in this PR were both caught the same
  // way — the failure mode here is exactly "the regex looks right but the
  // shell does something else."
  const clearStep = step("Empty the destination before extracting the artifact");
  const script = clearStep.run;

  function runClear(destPath, setupFn) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "clear-step-"));
    try {
      setupFn(workspace);
      const result = { code: 0, output: "" };
      try {
        result.output = execFileSync("bash", ["-c", script], {
          cwd: workspace,
          env: { ...process.env, GITHUB_WORKSPACE: workspace, DEST_PATH: destPath },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
      } catch (e) {
        result.code = typeof e.status === "number" ? e.status : 1;
        result.output = String(e.stdout || "") + String(e.stderr || "");
      }
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }

  // Direct symlink at dest-path, pointing at a real sibling directory.
  const direct = runClear("snapshots", (ws) => {
    fs.mkdirSync(path.join(ws, "important"));
    fs.writeFileSync(path.join(ws, "important", "secret.txt"), "sensitive");
    fs.symlinkSync("important", path.join(ws, "snapshots"));
  });
  assert.equal(direct.code, 1, "a direct symlink at dest-path must be refused");
  assert.match(direct.output, /symlink/);

  // Symlink in an intermediate path component, not the final one.
  const intermediate = runClear("nested/link/deeper", (ws) => {
    fs.mkdirSync(path.join(ws, "important"), { recursive: true });
    fs.mkdirSync(path.join(ws, "nested"), { recursive: true });
    fs.symlinkSync("../important", path.join(ws, "nested", "link"));
  });
  assert.equal(intermediate.code, 1, "a symlink in an intermediate component must be refused too");
  assert.match(intermediate.output, /symlink/);

  // Regression: an ordinary nonexistent path (the ordinary first-run case,
  // where dest-path has never existed before) must still be accepted.
  const nonexistent = runClear("brandnew/sub", () => {});
  assert.equal(nonexistent.code, 0, "a plain nonexistent dest-path must not be rejected as a symlink");

  // Regression: an ordinary already-existing real directory must still be
  // accepted (this is the common re-run case).
  const realDir = runClear("existing", (ws) => {
    fs.mkdirSync(path.join(ws, "existing"));
  });
  assert.equal(realDir.code, 0, "a plain real directory must not be rejected as a symlink");
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
  assert.match(clear.run, /rm -rf -- "\$resolved"/);
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

test("dest-path is treated as a literal git pathspec, not scanned for pathspec magic", () => {
  // `--` before a pathspec only tells git "no more options follow" — it
  // does NOT make the pathspec's own text literal. Verified with a real
  // repo: a directory literally named ":(exclude)**" as dest-path makes
  // `git add -f -A -- "$DEST_PATH"` exit 0 while staging NOTHING (the
  // magic pathspec excludes everything, with nothing else to exclude
  // from), and the step's own "no changes" quiet-diff check then reports
  // the artifact as never having changed — silently losing it with no
  // error anywhere. GIT_LITERAL_PATHSPECS=1 is git's documented escape
  // hatch; the same repro with it set stages the file correctly.
  assert.equal(step("Commit and push").env["GIT_LITERAL_PATHSPECS"], "1");
});

test("refuses to commit an artifact that itself contains a .git entry", () => {
  // Real Codex finding: the dest-path validation earlier rejects a .git
  // path COMPONENT in dest-path itself, but has no way to see what's
  // inside the artifact the download step just extracted. `git add -f`
  // doesn't error on a .git entry, it silently SKIPS it while still
  // staging everything else -- verified directly with a real repo: with
  // out/example/.git/config and out/example/real.txt both present,
  // `git add -f -A -- out/example` stages only real.txt, exits 0, and
  // says nothing about the dropped one. That's a successful-looking
  // commit silently missing part of the artifact -- worse than the
  // "nothing staged" case dest-path's own .git check guards, since
  // there's no empty-diff signal here to catch it.
  const commitStep = step("Commit and push");
  assert.match(commitStep.run, /find "\$GITHUB_WORKSPACE\/\$DEST_PATH" -name \.git/);
  const gitAddIdx = commitStep.run.indexOf('git add -f -A -- "$DEST_PATH"');
  const checkIdx = commitStep.run.indexOf('find "$GITHUB_WORKSPACE/$DEST_PATH" -name .git');
  assert.ok(gitAddIdx > -1, "the actual git add -f -A invocation should exist");
  assert.ok(checkIdx > -1 && checkIdx < gitAddIdx, "the .git-entry check must run before git add");

  const runCommit = (destPath, setupFn) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "commit-git-entry-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: workspace });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
      execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
      // A canary the -delete finding (below) would wipe out if the fix
      // regressed back to passing find an unprefixed, dash-swallowable path.
      fs.mkdirSync(path.join(workspace, "canary"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "canary", "important.txt"), "must survive");
      if (setupFn) setupFn(workspace);
      const result = { code: 0, output: "" };
      try {
        result.output = execFileSync("bash", ["-c", commitStep.run], {
          cwd: workspace,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            DEST_PATH: destPath,
            GIT_LITERAL_PATHSPECS: "1",
            BRANCH_REF: "x",
            COMMIT_MESSAGE: "m",
            EXPECTED_HEAD_SHA: "a".repeat(40),
            GH_TOKEN: "fake",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
      } catch (e) {
        result.code = e.status;
        result.output = String(e.stdout || "") + String(e.stderr || "");
      }
      result.canarySurvived = fs.existsSync(path.join(workspace, "canary", "important.txt"));
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };

  const withGitDir = runCommit("out/example", (ws) => {
    fs.mkdirSync(path.join(ws, "out/example/.git"), { recursive: true });
    fs.writeFileSync(path.join(ws, "out/example/.git/config"), "x");
    fs.writeFileSync(path.join(ws, "out/example/real.txt"), "y");
  });
  assert.equal(withGitDir.code, 1, "a .git directory inside the artifact must be rejected");
  assert.match(withGitDir.output, /contains \.git entries/);

  // Regression: an artifact with no .git entries must reach past this
  // check (it will fail later, on the push, for unrelated reasons in this
  // sandboxed test -- what matters is it does NOT fail on the .git check).
  const clean = runCommit("out/example", (ws) => {
    fs.mkdirSync(path.join(ws, "out/example"), { recursive: true });
    fs.writeFileSync(path.join(ws, "out/example/real.txt"), "y");
  });
  assert.doesNotMatch(clean.output, /contains \.git entries/);
});

test("passes find an absolute path, so a dest-path find would parse as an expression can't turn destructive", () => {
  // Real, SEVERE Codex finding on the .git-entry check above: find's
  // syntax is `find [path...] [expression]`, deciding "path" vs
  // "expression" by whether an argument starts with '-' -- with no `--`
  // escape hatch. A dest-path like "-delete" (already validated as a
  // safe relative path by the earlier checks -- nothing rejects a
  // leading '-') made find read it as the primary `-delete` instead of a
  // path, defaulting the search root to '.' (this step's cwd, the
  // checkout root) and deleting every file found there. Verified
  // directly against a real filesystem before fixing: bare `find
  // "-delete" -name .git` recursively deleted an entire populated
  // directory tree. Prefixing with $GITHUB_WORKSPACE guarantees the
  // argument always starts with '/', which find can never parse as an
  // expression.
  const commitStep = step("Commit and push");

  const runCommit = (destPath) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "find-dash-safety-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: workspace });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
      execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
      fs.mkdirSync(path.join(workspace, "canary"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "canary", "important.txt"), "must survive");
      const result = { code: 0, output: "" };
      try {
        result.output = execFileSync("bash", ["-c", commitStep.run], {
          cwd: workspace,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            DEST_PATH: destPath,
            GIT_LITERAL_PATHSPECS: "1",
            BRANCH_REF: "x",
            COMMIT_MESSAGE: "m",
            EXPECTED_HEAD_SHA: "a".repeat(40),
            GH_TOKEN: "fake",
          },
          stdio: ["ignore", "pipe", "pipe"],
        }).toString();
      } catch (e) {
        result.code = e.status;
        result.output = String(e.stdout || "") + String(e.stderr || "");
      }
      result.canarySurvived = fs.existsSync(path.join(workspace, "canary", "important.txt"));
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };

  const deleteAttempt = runCommit("-delete");
  assert.ok(
    deleteAttempt.canarySurvived,
    "a dest-path of '-delete' must never let find delete anything outside the intended destination",
  );
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
  const mismatchIdx = script.indexOf("pr.data.head.sha !== referenceHeadSha");
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

test("a checkout/guard/clear failure DOES use the live-head re-check, against EXPECTED_HEAD_SHA not HEAD_SHA", () => {
  // guard may not have even run when checkout itself fails, so HEAD_SHA (a
  // step output) can be empty here — but EXPECTED_HEAD_SHA is a WORKFLOW
  // INPUT, present regardless of what failed, and it names exactly the head
  // this failed run was trying to act on. Without this check, an older
  // overlapping run's transient checkout/guard/clear failure could still
  // overwrite a NEWER run's already-accurate, more current report — the
  // exact race the SKIPPED and DOWNLOAD/COMMIT/COMMITTED branches were
  // already fixed against, just missed here because this branch's own
  // history (see the surrounding comment) was written to solve a DIFFERENT
  // problem (an empty HEAD_SHA making the check unconditionally fail) by
  // skipping the check outright, rather than by picking a reference value
  // that's actually available.
  const script = step("Comment freshness on the PR").with.script;
  const branch = freshnessBranch(
    script,
    "process.env.CHECKOUT_OUTCOME !== 'success'",
    "process.env.SKIPPED === 'true'",
  );
  assert.ok(branch.includes("An earlier step failed"), "early-failure status text not found in its own branch");
  assert.match(branch, /needsLiveHeadCheck = true/, "this branch must opt into the live-head re-check");
  assert.match(
    branch,
    /referenceHeadSha = process\.env\.EXPECTED_HEAD_SHA/,
    "this branch must redirect the comparison to EXPECTED_HEAD_SHA (a workflow input, always present), not HEAD_SHA (a step output, often empty here)",
  );
  // EXPECTED_HEAD_SHA has to actually reach the script for that redirect to
  // work — a workflow input, not spliced directly (same injection concern
  // as every other PR-influenced value in this file).
  assert.equal(step("Comment freshness on the PR").env.EXPECTED_HEAD_SHA, "${{ inputs.expected-head-sha }}");
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
