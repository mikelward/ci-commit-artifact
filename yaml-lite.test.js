// Tests for yaml-lite.js — the same reason vitest-shim.mjs gets its own
// tests in mikelward/npm-update: anything test tooling depends on needs its
// own coverage, or a bug in the tool masks bugs in what it checks.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseWorkflowYaml } = require("./yaml-lite.js");

test("parses nested mappings and plain scalars", () => {
  const doc = parseWorkflowYaml("name: example\nnested:\n  key: value\n  n: 5\n");
  assert.equal(doc.name, "example");
  assert.equal(doc.nested.key, "value");
  assert.equal(doc.nested.n, 5);
});

test("parses block sequences of scalars", () => {
  const doc = parseWorkflowYaml("list:\n  - a\n  - b\n  - c\n");
  assert.deepEqual(doc.list, ["a", "b", "c"]);
});

test("parses flow sequences", () => {
  const doc = parseWorkflowYaml("branches: [main]\nmulti: [a, b, c]\nempty: []\n");
  assert.deepEqual(doc.branches, ["main"]);
  assert.deepEqual(doc.multi, ["a", "b", "c"]);
  assert.deepEqual(doc.empty, []);
});

test("parses a block sequence of mappings (- key: value siblings)", () => {
  const doc = parseWorkflowYaml(
    "steps:\n  - name: one\n    run: echo hi\n  - name: two\n    run: echo bye\n",
  );
  assert.equal(doc.steps.length, 2);
  assert.equal(doc.steps[0].name, "one");
  assert.equal(doc.steps[0].run, "echo hi");
  assert.equal(doc.steps[1].name, "two");
});

test("parses a block sequence item that is itself a nested mapping block", () => {
  const doc = parseWorkflowYaml(
    "steps:\n  -\n    name: one\n    with:\n      key: value\n",
  );
  assert.equal(doc.steps[0].name, "one");
  assert.equal(doc.steps[0].with.key, "value");
});

test("strips an inline comment from a plain scalar, but not a # inside a quoted one", () => {
  // Caught by Codex against this repo's own commit-artifact.yml, which uses
  // exactly this shape (`contents: write # push the commit`): without this,
  // the value parses as "write # push the commit" instead of "write",
  // silently disagreeing with what GitHub's own YAML parser reads.
  const doc = parseWorkflowYaml(
    "a: write # push the commit\nb: 'it''s # not a comment'\nc: \"a # b\"\nd: value#no-space-before-hash-is-not-a-comment\n",
  );
  assert.equal(doc.a, "write");
  assert.equal(doc.b, "it's # not a comment");
  assert.equal(doc.c, "a # b");
  assert.equal(doc.d, "value#no-space-before-hash-is-not-a-comment");
});

test("distinguishes single- and double-quoted scalars, unescaping each", () => {
  const doc = parseWorkflowYaml(
    "a: 'it''s here'\nb: \"line\\nbreak\"\nc: '${{ inputs.x }}'\n",
  );
  assert.equal(doc.a, "it's here");
  assert.equal(doc.b, "line\nbreak");
  assert.equal(doc.c, "${{ inputs.x }}");
});

test("parses booleans and null distinctly from their string forms", () => {
  const doc = parseWorkflowYaml("t: true\nf: false\nn: null\nq: 'true'\n");
  assert.equal(doc.t, true);
  assert.equal(doc.f, false);
  assert.equal(doc.n, null);
  assert.equal(doc.q, "true");
  assert.equal(typeof doc.q, "string");
});

test("does NOT expand on/off/yes/no as booleans — the YAML 1.1 Actions gotcha this parser sidesteps", () => {
  const doc = parseWorkflowYaml("on:\n  workflow_call:\nflag: off\nreply: yes\n");
  assert.ok(doc.on, "doc.on should be a real key, not lost to boolean-True normalization elsewhere");
  assert.deepEqual(Object.keys(doc.on), ["workflow_call"]);
  assert.equal(doc.flag, "off");
  assert.equal(doc.reply, "yes");
});

test("parses a literal block scalar (|) preserving embedded ${{ }} and internal newlines", () => {
  const doc = parseWorkflowYaml(
    'run: |\n  echo "hi ${{ github.sha }}"\n  exit 0\n',
  );
  assert.equal(doc.run, 'echo "hi ${{ github.sha }}"\nexit 0\n');
});

test("literal block scalar chomping: default clips to one newline, - strips", () => {
  const clip = parseWorkflowYaml("a: |\n  x\n  y\nb: 1\n");
  assert.equal(clip.a, "x\ny\n");
  const strip = parseWorkflowYaml("a: |-\n  x\n  y\nb: 1\n");
  assert.equal(strip.a, "x\ny");
});

test("literal block scalar chomping: + keeps every trailing blank line, none dropped and none invented", () => {
  // An earlier version claimed to cover + here but never actually
  // constructed a + case, and the implementation had a real bug: it
  // appended one more newline on top of an already-clipped body, so a `|+`
  // block always gained one extra trailing newline beyond what the source
  // had. Two trailing blank lines (three newlines total after "x") is the
  // case that catches both directions of getting this wrong.
  const keep = parseWorkflowYaml("a: |+\n  x\n\n\nb: 1\n");
  assert.equal(keep.a, "x\n\n\n");
  // A single trailing line with no extra blank ones: + must not invent one.
  const keepNoBlank = parseWorkflowYaml("a: |+\n  x\nb: 1\n");
  assert.equal(keepNoBlank.a, "x\n");
});

test("literal block scalar chomping: + at true EOF matches whether the source itself ends in a newline", () => {
  // A block scalar that is the LAST thing in the document is the one case
  // where collected's line count doesn't tell you whether the source had a
  // trailing newline: text.split("\n") gives no extra empty element when
  // the source doesn't end in "\n", so a document ending "...x" and one
  // ending "...x\n" produce the identical `collected`. + (keep) has to
  // tell these apart — and so does default (clip); see the sibling test
  // below. Only - (strip) is unaffected, since it discards every trailing
  // newline regardless.
  const noFinalNewline = parseWorkflowYaml("a: |+\n  x");
  assert.equal(noFinalNewline.a, "x");
  const withFinalNewline = parseWorkflowYaml("a: |+\n  x\n");
  assert.equal(withFinalNewline.a, "x\n");
});

test("literal block scalar chomping: default clip at true EOF also matches whether the source ends in a newline", () => {
  // Verified against yaml.safe_load — an earlier version of this file
  // claimed clip always normalizes to exactly one trailing newline
  // regardless of source, which is wrong specifically at true EOF: clip
  // still collapses any RUN of trailing blank lines down to at most one
  // newline (see the sibling default-clip test above), but when the source
  // has no final newline at all, clip preserves that, same as keep.
  const noFinalNewline = parseWorkflowYaml("a: |\n  x");
  assert.equal(noFinalNewline.a, "x");
  const withFinalNewline = parseWorkflowYaml("a: |\n  x\n");
  assert.equal(withFinalNewline.a, "x\n");
});

test("parses a folded block scalar (>) as GitHub Actions description fields use it", () => {
  const doc = parseWorkflowYaml(
    "description: >-\n  Line one\n  line two.\n",
  );
  assert.equal(doc.description, "Line one line two.");
});

test("folded block scalar: one blank line between content is one newline, not two", () => {
  // The spec example this mirrors: `>-\n  foo\n\n  bar` folds to "foo\nbar"
  // — a single blank line is ONE line break, not "a preserved blank line
  // plus a fold separator". An earlier version produced "foo\n\nbar" (two
  // newlines) by pushing an extra "" token per blank line and joining
  // every token with "\n", which is N+1 separators for N blank lines.
  const doc = parseWorkflowYaml("a: >-\n  foo\n\n  bar\nb: 1\n");
  assert.equal(doc.a, "foo\nbar");
});

test("folded block scalar: two consecutive blank lines fold to exactly two newlines", () => {
  const doc = parseWorkflowYaml("a: >-\n  foo\n\n\n  bar\nb: 1\n");
  assert.equal(doc.a, "foo\n\nbar");
});

test("folded block scalar: a blank line beside a more-indented line adds one break, matching the rule for either side alone", () => {
  // Verified against real yaml.safe_load, not derived by hand. The gap
  // formula is blankRun + (1 if EITHER side of the gap is more-indented,
  // else 0) — a single flag, not "+1 per more-indented side" (that
  // over-adds — see the consecutive-more-indented-lines test below).
  const blankThenIndented = parseWorkflowYaml("a: >-\n  foo\n\n    x\n  bar\nb: 1\n");
  assert.equal(blankThenIndented.a, "foo\n\n  x\nbar");
  const indentedThenBlank = parseWorkflowYaml("a: >-\n  foo\n    x\n\n  bar\nb: 1\n");
  assert.equal(indentedThenBlank.a, "foo\n  x\n\nbar");
});

test("folded block scalar: a more-indented line is never folded, and breaks around it either side", () => {
  // Spec example: a line indented past the block's own base indent is
  // literal content, not subject to folding — a line break is inserted
  // both before and after it (or a run of them), even with no blank line
  // to trigger one. `>-\n  foo\n    indented\n  bar` folds to
  // "foo\n  indented\nbar", not "foo indented bar".
  const doc = parseWorkflowYaml("a: >-\n  foo\n    indented\n  bar\nb: 1\n");
  assert.equal(doc.a, "foo\n  indented\nbar");
});

test("folded block scalar: consecutive more-indented lines get exactly one break between them, not one per side", () => {
  // Real bug in the previous fix: treating "left is more-indented" and
  // "right is more-indented" as two independent +1 contributions doubles
  // the break count when BOTH sides of a gap are more-indented (an
  // internal line within a more-indented run). Verified against
  // yaml.safe_load: `>-\n  x\n    y\n    z\n  q` -> "x\n  y\n  z\nq",
  // one newline between y and z, not two.
  const doc = parseWorkflowYaml("a: >-\n  x\n    y\n    z\n  q\nb: 1\n");
  assert.equal(doc.a, "x\n  y\n  z\nq");
});

test("folded block scalar: leading blank lines before the first content are preserved, not discarded", () => {
  // Real bug: the first-content branch replaced `joined` with just the
  // line, silently dropping any blankRun accumulated before it. Verified
  // against yaml.safe_load: `>-\n\n  x` -> "\nx", `>-\n\n\n  x` -> "\n\nx".
  const oneLeadingBlank = parseWorkflowYaml("a: >-\n\n  x\nb: 1\n");
  assert.equal(oneLeadingBlank.a, "\nx");
  const twoLeadingBlanks = parseWorkflowYaml("a: >-\n\n\n  x\nb: 1\n");
  assert.equal(twoLeadingBlanks.a, "\n\nx");
});

test("literal block scalar chomping: default clip on an empty block scalar stays empty, not '\\n'", () => {
  // `a: |` immediately followed by a sibling key has no content at all —
  // collected.length is 0. YAML evaluates that as "", and the shared clip
  // logic must not invent a trailing newline an empty block never had.
  const doc = parseWorkflowYaml("a: |\nb: 1\n");
  assert.equal(doc.a, "");
});

test("preserves blank lines inside a literal block scalar as blank lines", () => {
  const doc = parseWorkflowYaml("run: |\n  a\n\n  b\n");
  assert.equal(doc.run, "a\n\nb\n");
});

test("throws on a construct this parser doesn't support, rather than returning something silently wrong", () => {
  assert.throws(() => parseWorkflowYaml("a: &anchor value\nb: *anchor\n"));
});

test("throws on a block scalar line that dedents below the block's own indent without reaching the parent's", () => {
  // `a: |\n    x\n  y\nb: 1` is invalid YAML — "  y" is indented less than
  // the block's own established indent (4, from "    x") but still more
  // than the parent key's indent (0), so it's neither a continuation of
  // the block nor a valid dedent out of it. An earlier version silently
  // absorbed it as an empty line (raw.length < effectiveIndent) and
  // discarded "y" entirely, letting a: "x\n" pass structural assertions
  // against a document GitHub's own parser would reject outright.
  assert.throws(() => parseWorkflowYaml("a: |\n    x\n  y\nb: 1\n"));
});

test("round-trips this repository's own commit-artifact.yml without throwing", () => {
  const yamlPath = path.join(
    __dirname,
    ".github/workflows/commit-artifact.yml",
  );
  const text = fs.readFileSync(yamlPath, "utf8");
  const doc = parseWorkflowYaml(text);
  assert.ok(doc.on.workflow_call, "on.workflow_call missing");
  assert.ok(doc.jobs.commit, "jobs.commit missing");
  assert.ok(Array.isArray(doc.jobs.commit.steps), "jobs.commit.steps should be an array");
  assert.ok(doc.jobs.commit.steps.length >= 5, "expected at least 5 steps");
});
