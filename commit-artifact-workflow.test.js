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

// The validate step's own early read (branch_existed_at_start) reaches out
// to a real https://github.com/... URL, which most tests below have no
// opinion about and shouldn't depend on real network reachability to run
// (this sandbox happens to have egress, but that's not guaranteed, and even
// where it does the round trip is real latency for a value these tests
// never check). A GIT_CONFIG_GLOBAL pointing every "https://x-access-token:"
// URL (a fixed prefix regardless of the token/repo that follows) at a
// nonexistent local path makes that call fail fast and deterministically,
// with no network involved -- verified directly (a bogus HTTPS_PROXY was
// tried first and did NOT reliably block the real connection; this does).
const NO_NETWORK_GIT_CONFIG = path.join(os.tmpdir(), "commit-artifact-test-no-network-gitconfig");
fs.writeFileSync(
  NO_NETWORK_GIT_CONFIG,
  '[url "file:///nonexistent-test-remote/"]\n\tinsteadOf = https://x-access-token:\n',
);

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

test("declares push-token as an optional secret", () => {
  const secrets = doc.on.workflow_call.secrets;
  assert.ok(secrets, "no secrets: block declared");
  assert.ok(secrets["push-token"], "missing secret: push-token");
  assert.equal(secrets["push-token"].required, false);
});

test("refuses dispatch-workflow without push-token for any trigger other than pull_request", () => {
  // The caller's trigger is read from github.event_name directly (Codex
  // review, PR #1) -- not a caller-supplied input, which a caller could get
  // wrong and silently defeat this whole check. The test harness plays the
  // role of the Actions runner here: it can't set github.event_name itself
  // (that's not a real env var), so it sets EVENT_NAME directly, which is
  // exactly what ${{ github.event_name }} would have been mapped to by the
  // runner in a real run.
  //
  // Allowlist, not a denylist of one named trigger (Codex review, this PR):
  // an earlier version only excluded EVENT_NAME == "pull_request_target" by
  // name, so any OTHER non-pull_request trigger (workflow_run, schedule,
  // issue_comment, ...) sailed through the same unsafe dispatch path
  // unchecked, even though the push-token secret's own description already
  // documents dispatch-without-a-token as safe ONLY for pull_request.
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  const validate = steps[validateIdx];
  assert.equal(validate.env.EVENT_NAME, "${{ github.event_name }}");
  assert.match(validate.run, /EVENT_NAME" != "pull_request"/);

  const runCase = (eventName, dispatchWorkflow, hasPushToken) => {
    try {
      execFileSync("bash", ["-c", validate.run], {
        env: {
          ...process.env,
          ARTIFACT_NAME: "ui-snapshots",
          BRANCH_REF: "feature/some-branch",
          EXPECTED_HEAD_SHA: "a".repeat(40),
          PR_NUMBER: dispatchWorkflow ? "1" : "",
          COMMENT_MARKER: "",
          DISPATCH_WORKFLOW: dispatchWorkflow,
          EVENT_NAME: eventName,
          HAS_PUSH_TOKEN: hasPushToken,
          // A real, writable sink: the script's last line on any passing
          // path writes here, and every case in this test that expects
          // code 0 has to actually reach it.
          GITHUB_OUTPUT: "/dev/null",
          GH_TOKEN: "fake",
          GITHUB_REPOSITORY: "test-owner/test-repo",
          GIT_CONFIG_GLOBAL: NO_NETWORK_GIT_CONFIG,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0 };
    } catch (e) {
      return { code: e.status, output: String(e.stdout) + String(e.stderr) };
    }
  };

  // Every non-pull_request trigger, dispatching, with no token: unsafe.
  // pull_request_target is the originally-caught case; workflow_run and
  // schedule are two more that read the workflow definition from the
  // default branch the same way and were NOT caught by the old denylist.
  for (const eventName of ["pull_request_target", "workflow_run", "schedule"]) {
    const unsafe = runCase(eventName, "ci.yml", "false");
    assert.equal(unsafe.code, 1, `${eventName} + dispatch-workflow + no push-token must be refused`);
    assert.match(unsafe.output, /no push-token secret was given/);
  }

  // Every other combination is fine.
  assert.equal(
    runCase("pull_request_target", "ci.yml", "true").code,
    0,
    "pull_request_target + dispatch-workflow + push-token is safe (the push retriggers directly)",
  );
  assert.equal(
    runCase("workflow_run", "", "false").code,
    0,
    "workflow_run with no dispatch-workflow at all has nothing unsafe to refuse",
  );
  assert.equal(
    runCase("pull_request", "ci.yml", "false").code,
    0,
    "plain pull_request + dispatch-workflow + no push-token is the only trigger this fallback is safe for",
  );
});

test("a caller with no dispatch-workflow set is never refused on trigger alone, whatever the trigger", () => {
  // The trigger check only fires when dispatch-workflow is actually set --
  // github.event_name is ground truth about the run, not a caller's claim
  // to validate against an enum, so a trigger this workflow has no other
  // opinion about (push, a future caller shape) must pass through
  // untouched when there's no dispatch to make unsafe.
  const validateIdx = steps.findIndex((s) => s.name === "Validate the input combination");
  const validate = steps[validateIdx];
  execFileSync("bash", ["-c", validate.run], {
    env: {
      ...process.env,
      ARTIFACT_NAME: "ui-snapshots",
      BRANCH_REF: "feature/some-branch",
      EXPECTED_HEAD_SHA: "a".repeat(40),
      PR_NUMBER: "",
      COMMENT_MARKER: "",
      DISPATCH_WORKFLOW: "",
      EVENT_NAME: "push",
      HAS_PUSH_TOKEN: "false",
      GITHUB_OUTPUT: "/dev/null",
      GH_TOKEN: "fake",
      GITHUB_REPOSITORY: "test-owner/test-repo",
      GIT_CONFIG_GLOBAL: NO_NETWORK_GIT_CONFIG,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // execFileSync throws on a nonzero exit, so reaching here already proves
  // success -- nothing further to assert.
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
  // 'false' there, which only the || fallback delivers. Also falls back
  // through checkout-guard's own committed output (set when branch-ref
  // vanished before checkout could even run), ahead of the final 'false'.
  assert.match(
    doc.jobs.commit.outputs.committed,
    /steps\.commit\.outputs\.committed \|\| steps\.checkout-guard\.outputs\.committed \|\| 'false'/,
  );
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
          EVENT_NAME: "pull_request",
          HAS_PUSH_TOKEN: "false",
          GITHUB_OUTPUT: "/dev/null",
          GH_TOKEN: "fake",
          GITHUB_REPOSITORY: "test-owner/test-repo",
          GIT_CONFIG_GLOBAL: NO_NETWORK_GIT_CONFIG,
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
          EVENT_NAME: "pull_request",
          HAS_PUSH_TOKEN: "false",
          GITHUB_OUTPUT: "/dev/null",
          GH_TOKEN: "fake",
          GITHUB_REPOSITORY: "test-owner/test-repo",
          GIT_CONFIG_GLOBAL: NO_NETWORK_GIT_CONFIG,
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
  assert.match(commitStep.run, /realpath -m -- "\$GITHUB_WORKSPACE\/\$DEST_PATH"/);
  assert.match(commitStep.run, /find "\$resolved_dest" -name \.git/);
  const gitAddIdx = commitStep.run.indexOf('git add -f -A -- "$DEST_PATH"');
  const checkIdx = commitStep.run.indexOf('find "$resolved_dest" -name .git');
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

test("canonicalizes dest-path before find, so an unnormalized-but-safe path doesn't abort a valid commit", () => {
  // Real Codex finding on the absolute-path fix above: a dest-path like
  // "missing/../snapshots" is an accepted shape -- it already resolves
  // safely inside the checkout, same as the "Empty the destination"
  // step's own already-handled case -- but "missing" never actually
  // exists on disk. git add and actions/download-artifact both handle
  // this fine because both resolve '..' lexically before touching the
  // filesystem (verified against the action's own source: it calls
  // path.resolve(inputs.path) before creating anything, so "missing" is
  // never created; and `git add -f -A -- "missing/../snapshots"` stages
  // correctly with no such directory needed) -- but a bare
  // $GITHUB_WORKSPACE/$DEST_PATH concatenation isn't lexical, so find
  // needs "missing" to be a real, traversable directory and fails
  // closed with "No such file or directory", aborting an otherwise
  // completely valid commit under set -e. realpath -m collapses '..'
  // the same lexical way, without needing "missing" to exist.
  const commitStep = step("Commit and push");

  const runCommit = (destPath, setupFn) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dotdot-safety-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: workspace });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
      execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
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
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };

  const result = runCommit("missing/../snapshots", (ws) => {
    fs.mkdirSync(path.join(ws, "snapshots"), { recursive: true });
    fs.writeFileSync(path.join(ws, "snapshots", "real.txt"), "y");
  });
  assert.doesNotMatch(
    result.output,
    /No such file or directory/,
    "an unnormalized-but-safe dest-path must not make find abort the step",
  );
  assert.doesNotMatch(result.output, /contains \.git entries/);
});

test("refuses to commit when the index has a stale submodule (gitlink) entry under dest-path", () => {
  // Real Codex finding: a previously-committed submodule at dest-path
  // leaves a mode-160000 "gitlink" index entry (a recorded commit SHA, no
  // blob) that rm -rf + re-extract + `git add -f -A` does NOT update or
  // replace -- verified directly with a real repo: after rm -rf and
  // writing a real file back in its place, `git add -f -A -- "$DEST_PATH"`
  // exits 0, `git ls-files -s` still shows the untouched 160000 entry, the
  // real file is never staged, and `git status --short` reports NO changes
  // at all -- a silently-uncommitted artifact with no empty-diff signal to
  // catch it (worse: other unrelated changes in the same run would make
  // the step "succeed" while quietly omitting this path's real content).
  const commitStep = step("Commit and push");
  assert.match(commitStep.run, /git ls-files -s -- "\$DEST_PATH"/);
  // lastIndexOf for the git add call: the comment just above it (explaining
  // this very check) also mentions the literal text 'git add -f -A --
  // "$DEST_PATH"' in prose, earlier in the file than the real invocation.
  const gitAddIdx = commitStep.run.lastIndexOf('git add -f -A -- "$DEST_PATH"');
  const checkIdx = commitStep.run.indexOf('git ls-files -s -- "$DEST_PATH"');
  assert.ok(checkIdx > -1 && checkIdx < gitAddIdx, "the gitlink check must run before git add");

  const runCommit = (setupFn) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "commit-gitlink-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: workspace });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
      execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
      fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "out", "README.md"), "hi");
      execFileSync("git", ["add", "out/README.md"], { cwd: workspace });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
      if (setupFn) setupFn(workspace);
      const result = { code: 0, output: "" };
      try {
        result.output = execFileSync("bash", ["-c", commitStep.run], {
          cwd: workspace,
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            DEST_PATH: "out/example",
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
      return result;
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  };

  const withGitlink = runCommit((ws) => {
    execFileSync(
      "git",
      ["update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,out/example"],
      { cwd: ws },
    );
    execFileSync("git", ["commit", "-qm", "add fake submodule"], { cwd: ws });
    fs.mkdirSync(path.join(ws, "out", "example"), { recursive: true });
    fs.writeFileSync(path.join(ws, "out", "example", "real.txt"), "y");
  });
  assert.equal(withGitlink.code, 1, "a stale gitlink at dest-path must be rejected");
  assert.match(withGitlink.output, /stale submodule \(gitlink\) entry/);

  // Regression: a dest-path with no gitlink entry must reach past this
  // check (it will fail later, on the push, for unrelated reasons in this
  // sandboxed test -- what matters is it does NOT fail on the gitlink
  // check).
  const clean = runCommit((ws) => {
    fs.mkdirSync(path.join(ws, "out", "example"), { recursive: true });
    fs.writeFileSync(path.join(ws, "out", "example", "real.txt"), "y");
  });
  assert.doesNotMatch(clean.output, /stale submodule \(gitlink\) entry/);
});

test("the empty-render sentinel is stripped before committing, resulting in an all-deletions commit rather than a committed placeholder", () => {
  // Codex review: the artifact-name input's own advice for a render that
  // can legitimately produce zero files ("upload a placeholder") was
  // incomplete -- actions/download-artifact would extract that placeholder
  // under dest-path same as any real content, and git add -f -A below
  // would then COMMIT it, which is the opposite of the "genuinely empty,
  // all-deletions" result the advice was meant to enable. This is the
  // workflow's own end of that contract: a reserved sentinel filename gets
  // stripped before it can ever reach git add, so the destination is
  // really empty and any previously-tracked content under it is deleted,
  // nothing new staged in its place.
  const commitStep = step("Commit and push");
  assert.match(commitStep.run, /\.ci-commit-artifact-empty/);
  const sentinelIdx = commitStep.run.indexOf("empty_sentinel=");
  const gitAddIdx = commitStep.run.lastIndexOf('git add -f -A -- "$DEST_PATH"');
  assert.ok(sentinelIdx > -1 && sentinelIdx < gitAddIdx, "the sentinel must be stripped before git add");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "commit-emptysentinel-"));
  try {
    execFileSync("git", ["init", "-q", "."], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "out", "README.md"), "hi");
    // Previously-generated content under dest-path from an earlier run --
    // this run's render legitimately produced nothing, so it should be
    // deleted, not left behind.
    fs.mkdirSync(path.join(workspace, "out", "example"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "out", "example", "real.txt"), "old content");
    execFileSync("git", ["add", "out/README.md", "out/example/real.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });

    // Simulate the "Empty the destination" + "Download the artifact" steps
    // for a caller-uploaded empty-render sentinel: dest-path is cleared,
    // then re-populated with only the reserved sentinel file, exactly what
    // download-artifact would produce for a single-file artifact.
    fs.rmSync(path.join(workspace, "out", "example"), { recursive: true, force: true });
    fs.mkdirSync(path.join(workspace, "out", "example"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "out", "example", ".ci-commit-artifact-empty"), "");

    try {
      execFileSync("bash", ["-c", commitStep.run], {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          DEST_PATH: "out/example",
          GIT_LITERAL_PATHSPECS: "1",
          BRANCH_REF: "x",
          COMMIT_MESSAGE: "m",
          EXPECTED_HEAD_SHA: "a".repeat(40),
          GH_TOKEN: "fake",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // The push itself fails for unrelated reasons in this sandboxed test
      // (no real github.com to push to) -- same posture as the gitlink
      // "clean" regression above. What matters happened locally before
      // that: the sentinel's removal and the commit it enabled.
    }

    assert.ok(
      !fs.existsSync(path.join(workspace, "out", "example", ".ci-commit-artifact-empty")),
      "the sentinel file must not survive on disk",
    );
    const committedFiles = execFileSync("git", ["show", "--stat", "--format=", "HEAD"], {
      cwd: workspace,
    }).toString();
    assert.doesNotMatch(
      committedFiles,
      /\.ci-commit-artifact-empty/,
      "the sentinel must never appear in a real commit",
    );
    assert.match(
      committedFiles,
      /real\.txt/,
      "the previously-generated file's deletion must be part of the commit",
    );
    const stillTracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: workspace,
    }).toString();
    assert.doesNotMatch(
      stillTracked,
      /out\/example/,
      "dest-path must end up genuinely empty in the resulting commit, not holding the sentinel",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the git push authenticates via an explicit token URL, not the origin remote name", () => {
  const commit = step("Commit and push").run;
  // push_url is its own variable now (the graceful-degradation handling
  // below reuses it for a second, ls-remote call), not inlined into the
  // git push line itself -- so this checks the definition and the push's
  // use of it separately rather than one combined regex.
  assert.match(commit, /push_url="https:\/\/x-access-token:\$\{GH_TOKEN\}@github\.com/);
  assert.match(commit, /git push --force-with-lease=[^ ]+ "\$push_url"/);
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
  assert.match(
    commitStep.run,
    /--force-with-lease="refs\/heads\/\$BRANCH_REF:\$EXPECTED_HEAD_SHA"/,
  );
});

test("both sides of the push are qualified refs/heads/ refs, not bare names an unqualified refspec could resolve into refs/tags/ instead", () => {
  // Codex review: an unqualified push destination is resolved the same way
  // a local ref name is, so a branch-ref that happens to collide with an
  // EXISTING TAG of the same name (and no branch of that name) pushes into
  // refs/tags/ instead of refs/heads/ — verified directly against real git
  // (see the execution regression below). Every earlier guard passes in
  // that shape, since none of them look at which namespace the checked-out
  // ref actually resolved into.
  const commitStep = step("Commit and push");
  assert.match(commitStep.run, /"HEAD:refs\/heads\/\$BRANCH_REF"/);
  assert.doesNotMatch(commitStep.run, /"HEAD:\$BRANCH_REF"/);
});

test("a branch-ref colliding with an existing tag of the same name is rejected, not pushed into refs/tags/", () => {
  // End-to-end regression for the Codex finding above, executing the
  // step's own script (not a hand-typed reproduction) against a real git
  // remote. Redirects the hardcoded github.com push URL to a local bare
  // repo via `url.<base>.insteadOf`, so the actual push line runs for
  // real instead of only being regex-matched.
  const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "commit-tagcollision-remote-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "commit-tagcollision-work-"));
  const pushUrl = "https://x-access-token:faketoken@github.com/test-owner/test-repo.git";
  try {
    execFileSync("git", ["init", "-q", "--bare", "."], { cwd: bareRemote });

    execFileSync("git", ["init", "-q", "."], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
    fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "out", "README.md"), "hi");
    execFileSync("git", ["add", "out/README.md"], { cwd: workspace });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
    const tagSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace })
      .toString()
      .trim();
    // Push that commit to the bare remote as a TAG named "release" —
    // deliberately no branch of that name exists there.
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/tags/release"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", `url.${bareRemote}.insteadOf`, pushUrl], {
      cwd: workspace,
    });

    // Run the real validate-step probe against this exact setup, deriving
    // BRANCH_EXISTED_AT_START from its actual output rather than asserting
    // it: refs/heads/release never existed here, only the tag did, so the
    // probe itself must be the one to say "false" for this test to reach
    // the never-existed-branch failure rather than the vanished-branch one.
    const validateStep = step("Validate the input combination");
    const validateResult = runValidateStep(validateStep, workspace, "release", tagSha);
    assert.equal(validateResult.code, 0, "the validate step must not fail on a tag-only ref");
    assert.equal(
      validateResult.outputs.branch_existed_at_start,
      "false",
      "the probe must not see a branch here -- only a tag exists",
    );

    fs.mkdirSync(path.join(workspace, "out", "example"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "out", "example", "real.txt"), "y");

    const commitStep = step("Commit and push");
    const result = { code: 0, output: "" };
    try {
      result.output = execFileSync("bash", ["-c", commitStep.run], {
        cwd: workspace,
        env: {
          ...process.env,
          GITHUB_WORKSPACE: workspace,
          DEST_PATH: "out/example",
          GIT_LITERAL_PATHSPECS: "1",
          BRANCH_REF: "release",
          COMMIT_MESSAGE: "m",
          // The worst case: the guard step's SHA comparison would have let
          // this through, since it never looks at which namespace
          // branch-ref resolved into.
          EXPECTED_HEAD_SHA: tagSha,
          GH_TOKEN: "faketoken",
          GITHUB_REPOSITORY: "test-owner/test-repo",
          BRANCH_EXISTED_AT_START: validateResult.outputs.branch_existed_at_start,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }).toString();
    } catch (e) {
      result.code = e.status;
      result.output = String(e.stdout || "") + String(e.stderr || "");
    }

    assert.notEqual(result.code, 0, "the push must fail rather than silently rewrite the tag");
    const tagAfter = execFileSync("git", ["rev-parse", "refs/tags/release"], {
      cwd: bareRemote,
    })
      .toString()
      .trim();
    assert.equal(tagAfter, tagSha, "refs/tags/release on the remote must be untouched");
    assert.throws(
      () =>
        execFileSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/release"], {
          cwd: bareRemote,
          stdio: ["ignore", "ignore", "ignore"],
        }),
      "refs/heads/release must not have been created either",
    );
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

// Shared scaffolding for the three push-failure-handling regressions below:
// a bare remote, a workspace cloned from nothing with an initial commit, and
// the same url.insteadOf redirect the tag-collision regression above uses so
// the step's own hardcoded github.com push URL reaches a real local remote.
function setUpPushHarness() {
  const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), "commit-pushfail-remote-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "commit-pushfail-work-"));
  const pushUrl = "https://x-access-token:faketoken@github.com/test-owner/test-repo.git";
  execFileSync("git", ["init", "-q", "--bare", "."], { cwd: bareRemote });
  execFileSync("git", ["init", "-q", "."], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "t"], { cwd: workspace });
  fs.mkdirSync(path.join(workspace, "out"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "out", "README.md"), "hi");
  execFileSync("git", ["add", "out/README.md"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });
  const initialSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace })
    .toString()
    .trim();
  execFileSync("git", ["config", `url.${bareRemote}.insteadOf`, pushUrl], { cwd: workspace });
  return { bareRemote, workspace, pushUrl, initialSha };
}

// Runs the real "Validate the input combination" step's script (not a
// hand-typed reproduction of its branch_existed_at_start probe) against the
// harness above, so a regression test that needs BRANCH_EXISTED_AT_START
// exercises the actual probe instead of asserting a hand-picked value for
// it. Codex review: the push-failure regressions below originally hardcoded
// BRANCH_EXISTED_AT_START via runPushStep's default, so a bug in the probe
// itself (stops emitting the output, or misidentifies the exact ref) would
// go uncaught -- production would then treat a since-deleted branch as one
// that never existed (a hard failure) while every regression stayed green.
function runValidateStep(validateStep, workspace, branchRef, expectedHeadSha, extraEnv = {}) {
  const outputFile = path.join(workspace, ".github_output_validate");
  fs.writeFileSync(outputFile, "");
  const result = { code: 0, output: "" };
  try {
    result.output = execFileSync("bash", ["-c", validateStep.run], {
      cwd: workspace,
      env: {
        ...process.env,
        ARTIFACT_NAME: "example",
        BRANCH_REF: branchRef,
        EXPECTED_HEAD_SHA: expectedHeadSha,
        PR_NUMBER: "",
        COMMENT_MARKER: "",
        DISPATCH_WORKFLOW: "",
        EVENT_NAME: "pull_request",
        HAS_PUSH_TOKEN: "true",
        GH_TOKEN: "faketoken",
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_OUTPUT: outputFile,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    result.code = e.status;
    result.output = String(e.stdout || "") + String(e.stderr || "");
  }
  result.outputs = Object.fromEntries(
    fs
      .readFileSync(outputFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
  return result;
}

// Runs the real "Handle a branch-ref that vanished before or during
// checkout" step's script against the harness above (no working-directory
// git repo is needed here — unlike runPushStep, this step only queries the
// remote, it never touches a local checkout).
function runCheckoutGuardStep(checkoutGuardStep, workspace, branchRef, expectedHeadSha, extraEnv = {}) {
  const outputFile = path.join(workspace, ".github_output_checkout_guard");
  fs.writeFileSync(outputFile, "");
  const result = { code: 0, output: "" };
  try {
    result.output = execFileSync("bash", ["-c", checkoutGuardStep.run], {
      cwd: workspace,
      env: {
        ...process.env,
        BRANCH_REF: branchRef,
        EXPECTED_HEAD_SHA: expectedHeadSha,
        GH_TOKEN: "faketoken",
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_OUTPUT: outputFile,
        BRANCH_EXISTED_AT_START: "true",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    result.code = e.status;
    result.output = String(e.stdout || "") + String(e.stderr || "");
  }
  result.outputs = Object.fromEntries(
    fs
      .readFileSync(outputFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
  return result;
}

// Runs the real "Commit and push" step script (not a hand-typed
// reproduction) against the harness above, staging a real new file so
// there's always something to commit, and returns its exit code, output,
// and parsed $GITHUB_OUTPUT.
function runPushStep(commitStep, workspace, branchRef, expectedHeadSha, extraEnv = {}) {
  fs.mkdirSync(path.join(workspace, "out", "example"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "out", "example", "real.txt"), "y");
  const outputFile = path.join(workspace, ".github_output");
  fs.writeFileSync(outputFile, "");
  const result = { code: 0, output: "" };
  try {
    result.output = execFileSync("bash", ["-c", commitStep.run], {
      cwd: workspace,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: workspace,
        DEST_PATH: "out/example",
        GIT_LITERAL_PATHSPECS: "1",
        BRANCH_REF: branchRef,
        COMMIT_MESSAGE: "m",
        EXPECTED_HEAD_SHA: expectedHeadSha,
        GH_TOKEN: "faketoken",
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_OUTPUT: outputFile,
        // Defaults to "true" (a real, still-existing branch) -- the
        // tag-collision regression overrides it to "false", matching what
        // the validate step's own early read would have found in that
        // shape.
        BRANCH_EXISTED_AT_START: "true",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } catch (e) {
    result.code = e.status;
    result.output = String(e.stdout || "") + String(e.stderr || "");
  }
  result.outputs = Object.fromEntries(
    fs
      .readFileSync(outputFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
  );
  return result;
}

test("a vanished branch-ref degrades the push to a warning, not a job failure", () => {
  // Ported from a real production case (typelauncher, before this workflow
  // existed): the PR merges or closes -- GitHub auto-deletes the head
  // branch -- while this job is still rendering/committing. There is
  // nothing left to sync at that point; failing the run would be reporting
  // a problem that isn't one.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });

    // Run the real validate-step probe WHILE the branch still exists, same
    // as production does early in the job -- deriving
    // BRANCH_EXISTED_AT_START from the actual probe output rather than
    // asserting it, so a bug in the probe itself would surface here.
    const validateStep = step("Validate the input combination");
    const validateResult = runValidateStep(validateStep, workspace, "feature", initialSha);
    assert.equal(validateResult.code, 0, "the validate step must not fail while the branch exists");
    assert.equal(
      validateResult.outputs.branch_existed_at_start,
      "true",
      "the probe must see the branch while it still exists",
    );

    // Delete the branch on the remote -- simulating the PR merging/closing
    // mid-run -- via a real push, not update-ref, so this is exactly what
    // GitHub's own auto-delete does.
    execFileSync("git", ["push", "-q", bareRemote, "--delete", "refs/heads/feature"], {
      cwd: workspace,
    });

    const commitStep = step("Commit and push");
    const result = runPushStep(commitStep, workspace, "feature", initialSha, {
      BRANCH_EXISTED_AT_START: validateResult.outputs.branch_existed_at_start,
    });

    assert.equal(result.code, 0, "a vanished branch must not fail the job");
    assert.match(result.output, /no longer exists on the remote/);
    assert.equal(result.outputs.committed, "false");
    assert.equal(result.outputs.raced, "true", "the freshness comment must be told to defer, not report up-to-date");
    assert.throws(
      () =>
        execFileSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/feature"], {
          cwd: bareRemote,
          stdio: ["ignore", "ignore", "ignore"],
        }),
      "the deleted branch must not have been recreated",
    );
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkout is continue-on-error, so a branch vanishing there doesn't fail the job before checkout-guard runs", () => {
  const checkoutStep = step("Check out the branch");
  assert.equal(checkoutStep.id, "checkout");
  assert.equal(checkoutStep["continue-on-error"], true);
});

test("checkout-guard, and every step after checkout, is gated on checkout having actually succeeded", () => {
  // steps.guard.outputs.skip is unset (not the string 'true') when guard
  // itself never ran -- '' != 'true' evaluates truthy in Actions
  // expressions, so without an explicit checkout.outcome term, clear/
  // download/commit would run against a checkout that never happened.
  assert.equal(step("Handle a branch-ref that vanished before or during checkout").id, "checkout-guard");
  assert.equal(
    step("Handle a branch-ref that vanished before or during checkout").if,
    "steps.checkout.outcome != 'success'",
  );
  assert.match(step("Refuse to act on an untested branch head").if, /steps\.checkout\.outcome == 'success'/);
  assert.match(step("Empty the destination before extracting the artifact").if, /steps\.checkout\.outcome == 'success'/);
  assert.match(step("Download the artifact").if, /steps\.checkout\.outcome == 'success'/);
  assert.match(step("Commit and push").if, /steps\.checkout\.outcome == 'success'/);
});

test("a branch-ref that vanished before checkout ever ran degrades gracefully, exactly like a post-guard vanish", () => {
  // Codex review: the graceful vanished-branch handling this workflow
  // already had (in "Commit and push") only covers the window from the
  // guard step onward -- a branch deleted between the validate step's
  // probe and checkout itself (not narrow; the render job triggering this
  // one can run for minutes first) made checkout fail outright, well
  // before any of that handling could run.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });
    execFileSync("git", ["push", "-q", bareRemote, "--delete", "refs/heads/feature"], {
      cwd: workspace,
    });

    const checkoutGuardStep = step("Handle a branch-ref that vanished before or during checkout");
    const result = runCheckoutGuardStep(checkoutGuardStep, workspace, "feature", initialSha, {
      BRANCH_EXISTED_AT_START: "true",
    });

    assert.equal(result.code, 0, "a vanished branch-ref must not fail the job here either");
    assert.match(result.output, /no longer exists on the remote/);
    assert.equal(result.outputs.committed, "false");
    assert.equal(result.outputs.commit_sha, initialSha);
    assert.equal(result.outputs.raced, "true");
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the validate step's probe captures the SHA it actually saw, not just true/false", () => {
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });

    const validateStep = step("Validate the input combination");
    const result = runValidateStep(validateStep, workspace, "feature", initialSha);

    assert.equal(result.outputs.branch_existed_at_start, "true");
    assert.equal(result.outputs.branch_sha_at_start, initialSha);
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a branch-ref that advanced past expected-head-sha, then vanished before checkout, reports the SHA the validate probe actually saw — not the by-then-stale expected-head-sha", () => {
  // Codex review: a compound race on top of the one the previous test
  // covers. The validate step's probe can itself observe branch-ref
  // already past expected-head-sha (a legitimate push landed between this
  // run's trigger and its own validate step) — if branch-ref THEN vanishes
  // before checkout runs, checkout-guard's own re-probe finds nothing and
  // has nothing left to observe itself. Falling back to expected-head-sha
  // (a workflow INPUT, stale by the time this run even started) would
  // violate commit-sha's documented "last head this run actually observed"
  // contract; the validate step's own earlier observation is what's true.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });

    // A second, independent clone advances the branch past initialSha —
    // this run's validate step will observe THIS new head, not initialSha.
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), "commit-validate-advance-"));
    let advancedSha;
    try {
      execFileSync("git", ["clone", "-q", bareRemote, "."], { cwd: otherClone });
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: otherClone });
      execFileSync("git", ["config", "user.email", "racer@example.com"], { cwd: otherClone });
      execFileSync("git", ["config", "user.name", "racer"], { cwd: otherClone });
      fs.writeFileSync(path.join(otherClone, "out", "README.md"), "advanced");
      execFileSync("git", ["commit", "-aqm", "advanced before validate ran"], { cwd: otherClone });
      execFileSync("git", ["push", "-q", "origin", "feature"], { cwd: otherClone });
      advancedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: otherClone }).toString().trim();
    } finally {
      fs.rmSync(otherClone, { recursive: true, force: true });
    }
    assert.notEqual(advancedSha, initialSha, "the race setup must actually have moved the branch");

    const validateStep = step("Validate the input combination");
    const validateResult = runValidateStep(validateStep, workspace, "feature", initialSha);
    assert.equal(validateResult.outputs.branch_existed_at_start, "true");
    assert.equal(validateResult.outputs.branch_sha_at_start, advancedSha);

    // Now branch-ref vanishes before checkout ever gets a chance to run.
    execFileSync("git", ["push", "-q", bareRemote, "--delete", "refs/heads/feature"], {
      cwd: workspace,
    });

    const checkoutGuardStep = step("Handle a branch-ref that vanished before or during checkout");
    const result = runCheckoutGuardStep(checkoutGuardStep, workspace, "feature", initialSha, {
      BRANCH_EXISTED_AT_START: validateResult.outputs.branch_existed_at_start,
      BRANCH_SHA_AT_START: validateResult.outputs.branch_sha_at_start,
    });

    assert.equal(result.code, 0);
    assert.equal(
      result.outputs.commit_sha,
      advancedSha,
      "must report the SHA the validate probe actually observed, not the stale expected-head-sha input",
    );
    assert.notEqual(result.outputs.commit_sha, initialSha);
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkout failing for a reason OTHER than the branch vanishing (it still exists) still fails the job loudly", () => {
  // The negative case: checkout can fail for reasons that have nothing to
  // do with branch-ref vanishing (auth, a transient network blip) while
  // the branch itself is still right there on the remote -- must not be
  // waved through as a benign deletion just because checkout itself failed.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });

    const checkoutGuardStep = step("Handle a branch-ref that vanished before or during checkout");
    const result = runCheckoutGuardStep(checkoutGuardStep, workspace, "feature", initialSha, {
      BRANCH_EXISTED_AT_START: "true",
    });

    assert.notEqual(result.code, 0, "checkout failing while the branch still exists must be a real failure");
    assert.match(result.output, /reason other than the branch vanishing/);
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkout failing on a branch-ref that never existed (only ever a tag) fails loudly, not the vanished-branch wording", () => {
  const { workspace, initialSha } = setUpPushHarness();
  try {
    const checkoutGuardStep = step("Handle a branch-ref that vanished before or during checkout");
    const result = runCheckoutGuardStep(checkoutGuardStep, workspace, "never-a-branch", initialSha, {
      BRANCH_EXISTED_AT_START: "false",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /did not exist at the start of this run either/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("checkout failing with an inconclusive validate probe (unknown) reports honestly, not the tag-only wording", () => {
  const { workspace, initialSha } = setUpPushHarness();
  try {
    const checkoutGuardStep = step("Handle a branch-ref that vanished before or during checkout");
    const result = runCheckoutGuardStep(checkoutGuardStep, workspace, "feature", initialSha, {
      BRANCH_EXISTED_AT_START: "unknown",
    });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /could not confirm whether it existed/);
    assert.doesNotMatch(result.output, /did not exist at the start of this run either/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("the validate step's probe reports 'unknown', not 'false', when it can't even query the remote", () => {
  // Codex review: collapsing a failed ls-remote (transport/auth) into the
  // same 'false' a genuine not-found produces means a branch that later
  // really does vanish gets diagnosed with "did not exist at the start
  // either" even though this step never actually confirmed that. A `git`
  // wrapper on PATH that fails only `ls-remote` (passing every other git
  // subcommand through to the real binary) reproduces a query that
  // genuinely cannot run, as opposed to one that runs and finds nothing.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "commit-validate-fakegit-"));
  try {
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const wrapperPath = path.join(fakeBin, "git");
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\nif [ "$1" = "ls-remote" ]; then\n  echo "fatal: simulated transport failure" >&2\n  exit 128\nfi\nexec "${realGit}" "$@"\n`,
    );
    fs.chmodSync(wrapperPath, 0o755);

    const validateStep = step("Validate the input combination");
    const result = runValidateStep(validateStep, workspace, "feature", initialSha, {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    assert.equal(result.code, 0, "a probe failure must not fail the validate step itself");
    assert.match(result.output, /could not query.*unconfirmed/s);
    assert.equal(result.outputs.branch_existed_at_start, "unknown");
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("a branch that later genuinely vanishes, after an inconclusive probe, still fails loudly -- with an honest message, not the tag-collision wording", () => {
  // The negative case for the 'unknown' probe state above: the commit step
  // must still hard-fail here (this workflow's fail-closed default -- never
  // silently swallow a disappearance the validate step couldn't rule out),
  // but the message must not claim "did not exist at the start either",
  // since BRANCH_EXISTED_AT_START=unknown means this never actually checked
  // that -- it would be indistinguishable from a real branch that vanished
  // right after an auth hiccup in the validate step.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });
    execFileSync("git", ["push", "-q", bareRemote, "--delete", "refs/heads/feature"], {
      cwd: workspace,
    });

    const commitStep = step("Commit and push");
    const result = runPushStep(commitStep, workspace, "feature", initialSha, {
      BRANCH_EXISTED_AT_START: "unknown",
    });

    assert.notEqual(result.code, 0, "an unconfirmed-then-vanished branch must still fail the job");
    assert.match(result.output, /could not confirm whether it existed/);
    assert.doesNotMatch(
      result.output,
      /did not exist at the start of this run either/,
      "must not claim it verified something it never actually checked",
    );
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a branch-ref that advanced past expected-head-sha degrades the push to a warning (a lost race), not a job failure", () => {
  // A concurrent push to branch-ref between the guard step observing it and
  // this step reaching the push -- this workflow's own guard step can't see
  // it, but the lease will. Whatever run produced that newer head is
  // responsible for its own sync; this run has nothing current left to add.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });

    // A second, independent clone races in a real commit of its own.
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), "commit-pushfail-racer-"));
    try {
      execFileSync("git", ["clone", "-q", bareRemote, "."], { cwd: otherClone });
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: otherClone });
      execFileSync("git", ["config", "user.email", "racer@example.com"], { cwd: otherClone });
      execFileSync("git", ["config", "user.name", "racer"], { cwd: otherClone });
      fs.writeFileSync(path.join(otherClone, "out", "README.md"), "raced");
      execFileSync("git", ["commit", "-aqm", "concurrent update"], { cwd: otherClone });
      execFileSync("git", ["push", "-q", "origin", "feature"], { cwd: otherClone });
    } finally {
      fs.rmSync(otherClone, { recursive: true, force: true });
    }
    const racedSha = execFileSync("git", ["ls-remote", bareRemote, "refs/heads/feature"], {})
      .toString()
      .split(/\s+/)[0];
    assert.notEqual(racedSha, initialSha, "the race setup must actually have moved the branch");

    const commitStep = step("Commit and push");
    // Still using the STALE initialSha -- what this run's own guard step
    // observed before the race landed.
    const result = runPushStep(commitStep, workspace, "feature", initialSha);

    assert.equal(result.code, 0, "a lost race must not fail the job");
    assert.match(result.output, /advanced past/);
    assert.equal(result.outputs.committed, "false");
    assert.equal(result.outputs.raced, "true", "the freshness comment must be told to defer, not report up-to-date");
    // Codex review: the reported commit_sha must be the racing commit that
    // is actually branch-ref's head now, not the stale initialSha this
    // run's own guard step observed before the race -- the documented
    // output contract promises the CURRENT head when nothing was pushed.
    assert.equal(result.outputs.commit_sha, racedSha);
    const shaAfter = execFileSync("git", ["ls-remote", bareRemote, "refs/heads/feature"], {})
      .toString()
      .split(/\s+/)[0];
    assert.equal(shaAfter, racedSha, "the racing commit must survive untouched, not be overwritten");
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("an unrelated branch whose name ends in refs/heads/$BRANCH_REF does not corrupt the diagnosis", () => {
  // Codex review: `git ls-remote <url> refs/heads/feature` matches as a
  // SUFFIX pattern, not an exact ref name -- verified directly, a real
  // branch named "a/refs/heads/feature" is returned right alongside the
  // real "refs/heads/feature" for that same query. Naively taking the
  // first returned line's SHA can therefore pick up a completely
  // unrelated branch's commit instead of the one this run actually cares
  // about, potentially misclassifying a real failure as a benign one (or
  // vice versa). This reproduces exactly that collision and asserts the
  // diagnosis still lands on the real branch, not the decoy.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });
    // A decoy branch whose name happens to end in "refs/heads/feature" --
    // git allows slashes in branch names, so this is a legal ref.
    execFileSync(
      "git",
      ["push", "-q", bareRemote, "HEAD:refs/heads/decoy/refs/heads/feature"],
      { cwd: workspace },
    );
    const decoySha = execFileSync(
      "git",
      ["ls-remote", bareRemote, "refs/heads/decoy/refs/heads/feature"],
      {},
    )
      .toString()
      .split(/\s+/)[0];

    // Race a real commit onto the REAL "feature" branch, same as the lost-
    // race test above -- the decoy is a distractor, not the thing racing.
    const otherClone = fs.mkdtempSync(path.join(os.tmpdir(), "commit-pushfail-decoy-racer-"));
    let racedSha;
    try {
      execFileSync("git", ["clone", "-q", bareRemote, "."], { cwd: otherClone });
      execFileSync("git", ["checkout", "-q", "feature"], { cwd: otherClone });
      execFileSync("git", ["config", "user.email", "racer@example.com"], { cwd: otherClone });
      execFileSync("git", ["config", "user.name", "racer"], { cwd: otherClone });
      fs.writeFileSync(path.join(otherClone, "out", "README.md"), "raced");
      execFileSync("git", ["commit", "-aqm", "concurrent update"], { cwd: otherClone });
      execFileSync("git", ["push", "-q", "origin", "feature"], { cwd: otherClone });
      racedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: otherClone }).toString().trim();
    } finally {
      fs.rmSync(otherClone, { recursive: true, force: true });
    }
    assert.notEqual(racedSha, decoySha, "the decoy and the real race must land on different commits, or this test proves nothing");

    const commitStep = step("Commit and push");
    const result = runPushStep(commitStep, workspace, "feature", initialSha);

    assert.equal(result.code, 0, "a lost race must not fail the job even with a colliding decoy ref present");
    assert.equal(result.outputs.committed, "false");
    // The load-bearing assertion: the reported SHA must be the REAL
    // branch's race winner, never the decoy's.
    assert.equal(result.outputs.commit_sha, racedSha);
    assert.notEqual(result.outputs.commit_sha, decoySha);
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a push that actually landed is reported as committed, even though git push itself exited nonzero", () => {
  // Codex review: a dropped connection after GitHub accepts the ref update
  // but before the client reads the response makes `git push` exit nonzero
  // for a push that in fact succeeded.
  //
  // First attempt at reproducing this pre-landed the exact commit the
  // script would build (same parent/tree/message/identity/timestamps) onto
  // branch-ref before the script ran, expecting its force-with-lease to
  // reject since the remote had "moved" past EXPECTED_HEAD_SHA. It didn't:
  // git's own push short-circuits to "Everything up-to-date" (exit 0, no
  // network round-trip at all) whenever the local HEAD already equals the
  // remote's current state, regardless of the lease's expected OLD value --
  // verified directly. That's a different, already-handled shape (the
  // ordinary success path), not Codex's scenario: there, the client
  // genuinely doesn't get a response and reports failure even though the
  // server applied the update.
  //
  // Reproduced properly with a `git` wrapper on PATH: it lets `git push`
  // actually run for real (so the remote is genuinely mutated), then
  // deliberately reports failure regardless of the real outcome -- exactly
  // "the server accepted it, the client didn't find out." Every other git
  // invocation passes straight through to the real binary.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "commit-pushfail-fakegit-"));
  try {
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });

    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    const wrapperPath = path.join(fakeBin, "git");
    fs.writeFileSync(
      wrapperPath,
      `#!/bin/sh\nif [ "$1" = "push" ]; then\n  "${realGit}" "$@"\n  code=$?\n  if [ "$code" -eq 0 ]; then\n    exit 1\n  fi\n  exit "$code"\nfi\nexec "${realGit}" "$@"\n`,
    );
    fs.chmodSync(wrapperPath, 0o755);

    const commitStep = step("Commit and push");
    const result = runPushStep(commitStep, workspace, "feature", initialSha, {
      PATH: `${fakeBin}:${process.env.PATH}`,
    });

    const pushedSha = execFileSync("git", ["ls-remote", bareRemote, "refs/heads/feature"], {})
      .toString()
      .split(/\s+/)[0];
    assert.notEqual(pushedSha, initialSha, "the wrapped push must have actually mutated the remote");
    assert.equal(result.code, 0, "an already-landed push must not fail the job");
    assert.match(result.output, /already reports this run's own new commit/);
    assert.equal(result.outputs.committed, "true");
    assert.equal(result.outputs.commit_sha, pushedSha);
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("a push rejected for a reason other than a vanished or moved branch still fails the job loudly", () => {
  // The negative case for both regressions above: when the remote still
  // reports branch-ref at exactly expected-head-sha (no deletion, no race)
  // and the push is STILL rejected -- a branch-protection rule or similar
  // -- this is a real failure of the sync mechanism itself and must not be
  // swallowed as though it were one of the benign cases. A pre-receive
  // hook that rejects unconditionally reproduces that without needing a
  // real GitHub branch-protection rule: git ls-remote doesn't invoke
  // server-side hooks, so it still reports the true, unchanged ref.
  const { bareRemote, workspace, initialSha } = setUpPushHarness();
  try {
    // A plain push, before the hook exists, to seed the branch -- so only
    // the actual test push below hits the hook.
    execFileSync("git", ["push", "-q", bareRemote, "HEAD:refs/heads/feature"], { cwd: workspace });
    const hookPath = path.join(bareRemote, "hooks", "pre-receive");
    fs.writeFileSync(hookPath, '#!/bin/sh\necho "rejected by policy" >&2\nexit 1\n');
    fs.chmodSync(hookPath, 0o755);

    const commitStep = step("Commit and push");
    const result = runPushStep(commitStep, workspace, "feature", initialSha);

    assert.equal(result.code, 1, "a genuinely rejected push must fail the job");
    assert.doesNotMatch(result.output, /no longer exists on the remote/);
    assert.doesNotMatch(result.output, /advanced past/);
    assert.match(result.output, /real failure/);
  } finally {
    fs.rmSync(bareRemote, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("CI is dispatched only after a real commit, and only when the caller asked for it", () => {
  assert.match(
    step("Dispatch CI on the new commit").if,
    /steps\.commit\.outputs\.committed == 'true' && inputs\.dispatch-workflow != ''/,
  );
});

test("CI is not dispatched again when push-token already retriggered it", () => {
  // A push-token push authenticates as a real user and retriggers the
  // caller's own trigger on its own; dispatching on top of that would start
  // a second, redundant run of the same workflow for the same commit.
  assert.match(
    step("Dispatch CI on the new commit").if,
    /steps\.validate\.outputs\.use_push_token != 'true'/,
  );
  // The inverse step exists and fires in exactly the opposite condition, so
  // one or the other always explains what happened to a caller reading the
  // run log — never neither.
  const notice = step("Note that push-token already retriggered CI");
  assert.match(notice.if, /steps\.commit\.outputs\.committed == 'true' && inputs\.dispatch-workflow != ''/);
  assert.match(notice.if, /steps\.validate\.outputs\.use_push_token == 'true'/);
});

test("the freshness comment never runs without both a marker and a PR number", () => {
  assert.match(
    step("Comment freshness on the PR").if,
    /inputs\.comment-marker != '' && inputs\.pr-number != ''/,
  );
});

test("the existing sticky comment is found by an anchored marker match, not a bare substring", () => {
  // Codex review: comment-marker is caller-chosen, and the body is always
  // built as `${marker}\n...` -- a bare .includes(marker) would also match
  // an unrelated bot comment that merely happens to CONTAIN the marker text
  // somewhere in its own content (another automation's output, or a
  // different caller's longer marker that this one is a substring of), and
  // then overwrite that comment's content instead of posting or updating
  // this workflow's own.
  const script = step("Comment freshness on the PR").with.script;
  assert.doesNotMatch(
    script,
    /c\.body\.includes\(marker\)/,
    "still a bare substring search -- a marker occurring anywhere in an unrelated bot comment would match",
  );
  assert.match(
    script,
    /c\.body\.startsWith\(`\$\{marker\}\\n`\)/,
    "must anchor to the exact start of the body, matching how it's actually constructed just above",
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

test("a post-guard race (branch vanished or advanced during the push itself) also posts nothing, not an up-to-date report", () => {
  // Codex review: the commit step's own graceful-degradation handling
  // (vanished branch-ref, or a race lost between the guard step and the
  // actual push) reports committed=false -- accurate, but indistinguishable
  // from "genuinely nothing to commit" without the RACED signal this step
  // also sets in exactly those two cases. Without checking it, this branch
  // would report "up-to-date" for a run that in fact deferred to someone
  // else's newer state -- the same overwrite risk the guard-stage SKIPPED
  // branch above already guards against, just one step later.
  const script = step("Comment freshness on the PR").with.script;
  const branch = freshnessBranch(script, "process.env.RACED === 'true'", "} else {");
  assert.match(branch, /\breturn;/, "the RACED branch must return without posting a comment");
  assert.ok(!branch.includes("pulls.get"), "the RACED branch must not perform (or depend on) the live-head re-check");
  assert.ok(!branch.includes("status ="), "the RACED branch must not build a status message to post");
  // Checked strictly after COMMITTED === 'true', not before it: a run that
  // both raced AND still has committed=='true' (the already-landed-push
  // case, which never sets raced) must still report as regenerated. Fully
  // qualified with the process.env. prefix, not a bare "RACED === 'true'"
  // substring search — CHECKOUT_GUARD_RACED === 'true' (a distinct,
  // earlier check) also contains that bare substring and would otherwise
  // be found instead of this (the post-guard) occurrence.
  const committedIdx = script.indexOf("process.env.COMMITTED === 'true'");
  const racedIdx = script.indexOf("process.env.RACED === 'true'");
  assert.ok(committedIdx > -1 && committedIdx < racedIdx, "COMMITTED === 'true' must be checked before RACED");
});

test("the commit step signals RACED only for the two branch-moved degradations, not for a genuine no-change run", () => {
  const commitStep = step("Commit and push");
  // The two graceful-degradation branches (vanished, advanced-past-expected)
  // both set raced=true; the plain "git diff --cached --quiet" no-change
  // exit earlier in the same script must not.
  const racedCount = (commitStep.run.match(/raced=true/g) || []).length;
  assert.equal(racedCount, 2, "expected exactly the vanished-branch and lost-race branches to set raced=true");
  const noChangeIdx = commitStep.run.indexOf("No changes under");
  const firstRacedIdx = commitStep.run.indexOf("raced=true");
  assert.ok(noChangeIdx > -1 && noChangeIdx < firstRacedIdx, "the no-change exit must come before either raced=true write");
  assert.doesNotMatch(
    commitStep.run.slice(noChangeIdx, commitStep.run.indexOf("git commit -q -m")),
    /raced=true/,
    "the no-change branch itself must not set raced=true",
  );
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
