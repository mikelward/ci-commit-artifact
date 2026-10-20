// Tests for .github/workflows/ci.yml's concurrency group, the one piece of
// this repository's own CI whose failure is silent: a group that cancels the
// wrong run leaves a required check canceled or missing on a head, and a
// group that cancels nothing quietly doubles every push's runs. Neither
// turns any job red, so the shape is pinned here, parsed with yaml-lite.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseWorkflowYaml } = require("./resolve-yaml-lite.js");

const doc = parseWorkflowYaml(
  fs.readFileSync(path.join(__dirname, ".github/workflows/ci.yml"), "utf8"),
);
const MAIN =
  "(github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'))";

test("declares one workflow-level concurrency group", () => {
  assert.ok(doc.concurrency, "ci.yml has no workflow-level concurrency");
  assert.equal(typeof doc.concurrency.group, "string");
});

test("groups a pull request by its number and main by commit", () => {
  // Keyed on the event rather than the ref: a push to main or a dispatch at
  // it gets its own commit-keyed group, so no main run is canceled or
  // evicted; anything else shares its pull request's group.
  assert.equal(
    doc.concurrency.group,
    `ci-\${{ ${MAIN} && format('main-{0}', github.sha) || github.event.pull_request.number || github.ref }}`,
  );
});

test("cancels on a push, open or reopen, never on main or an edit", () => {
  // An `edited` run carries the head as of the edit, and GitHub doesn't
  // promise to start runs in event order, so a canceling edit could cancel
  // the only run on a newer head; it queues instead.
  assert.equal(
    doc.concurrency["cancel-in-progress"],
    `\${{ !${MAIN} && github.event.action != 'edited' }}`,
  );
});

test("still runs on an edit, so a retarget re-runs the lane", () => {
  const types = doc.on.pull_request.types;
  assert.ok(Array.isArray(types) && types.length > 0, "pull_request types not found");
  assert.ok(types.includes("edited"));
  assert.ok(types.includes("synchronize"));
});
