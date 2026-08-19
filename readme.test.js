// Tests for README.md's consumer-facing YAML examples. A snippet that isn't
// actually valid YAML — or that's syntactically valid but not a valid
// GitHub Actions job (a job value must be a mapping with a `steps:` key,
// not a bare sequence of steps) — sends a reader who copies it straight
// into a schema error, with nothing here to catch it first.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseWorkflowYaml } = require("./yaml-lite.js");

const README_PATH = path.join(__dirname, "README.md");
const readmeText = fs.readFileSync(README_PATH, "utf8");

function fencedYamlBlocks(text) {
  const blocks = [];
  const re = /```yaml\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

const blocks = fencedYamlBlocks(readmeText);

test("README.md has at least one fenced yaml example", () => {
  // A regex that stops finding matches is the false-pass this suite's own
  // AGENTS.md warns about — assert the extraction itself found something,
  // not just that whatever it found (possibly nothing) parses.
  assert.ok(blocks.length > 0, "expected at least one ```yaml fenced block in README.md");
});

test("every fenced yaml example in README.md is parseable", () => {
  for (const block of blocks) {
    assert.doesNotThrow(() => parseWorkflowYaml(block), `failed to parse:\n${block}`);
  }
});

test("the consumer wiring example's render job is a mapping with a steps: key, not a bare step sequence", () => {
  // Caught by Codex: `jobs.render:` was previously assigned a sequence
  // directly (a comment line followed by "- uses: ..." with no `steps:`
  // key in between). GitHub Actions requires every job to be a mapping and
  // every action invocation to appear beneath `steps:` — a bare sequence
  // there is a schema error, not an abbreviated-but-fixable example.
  const wiringBlock = blocks.find((b) => b.includes("uses: mikelward/ci-commit-artifact"));
  assert.ok(wiringBlock, "expected to find the consumer wiring example");
  const doc = parseWorkflowYaml(wiringBlock);
  assert.ok(Array.isArray(doc.jobs.render.steps), "jobs.render.steps should be an array");
  assert.ok(doc.jobs.render.steps.length > 0);
});
