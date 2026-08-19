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

test("flow sequence splitting: an escaped quote inside a double-quoted element doesn't close the quote early", () => {
  // `"x\"y,z"` is ONE element (`x"y,z`) — closing the quote at the escaped
  // `"` instead of skipping it would read the comma that follows as a
  // top-level separator, corrupting one element into two.
  const doc = parseWorkflowYaml(String.raw`a: ["x\"y,z", q]` + "\n");
  assert.deepEqual(doc.a, ['x"y,z', "q"]);
  const doc2 = parseWorkflowYaml(String.raw`a: [q, "x\"y,z"]` + "\n");
  assert.deepEqual(doc2.a, ["q", 'x"y,z']);
});

test("flow sequence splitting: a doubled '' inside a single-quoted element doesn't close the quote early", () => {
  // YAML's escape for a literal ' inside a single-quoted scalar is doubling
  // it, not backslashing — the same rule stripInlineComment already
  // applies to a plain scalar.
  const doc = parseWorkflowYaml("a: ['x''y,z', q]\n");
  assert.deepEqual(doc.a, ["x'y,z", "q"]);
});

test("flow sequence splitting: a quote mid-element has no quoting effect — only an element's OWN first character can start one", () => {
  // Same restriction as the sibling stripInlineComment test, applied to
  // flow-sequence elements: verified against
  // yaml.safe_load('a: [echo "hi, x", b]\n') ->
  // {'a': ['echo "hi', 'x"', 'b']} — three elements, not one long quoted
  // element swallowing the comma. Contrast with the genuinely-quoted
  // ["x, y", b] case, which still protects its internal comma because the
  // quote IS that element's first character.
  const doc = parseWorkflowYaml(String.raw`a: [echo "hi, x", b]` + "\n");
  assert.deepEqual(doc.a, ['echo "hi', 'x"', "b"]);
  const doc2 = parseWorkflowYaml(String.raw`a: ["x, y", b]` + "\n");
  assert.deepEqual(doc2.a, ["x, y", "b"]);
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

test("a quote mid-plain-scalar has no quoting effect — only a scalar's OWN first character can start one", () => {
  // Verified against yaml.safe_load('a: echo "x # y"\n') -> {'a': 'echo "x'}
  // — a shell-quoted substring inside an otherwise-plain scalar (`run: echo
  // "x # y"`, extremely common) is not a YAML-quoted scalar at all. The
  // embedded " is a literal character with no special meaning, and # still
  // starts a comment by the ordinary preceded-by-whitespace rule. Contrast
  // with c: "a # b" above, where the SAME text is genuinely quoted because
  // the value itself starts with the quote character.
  const doc = parseWorkflowYaml(
    String.raw`a: echo "x # y"` + "\n" + "b: echo 'x # y'\n",
  );
  assert.equal(doc.a, 'echo "x');
  assert.equal(doc.b, "echo 'x");
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

test("literal and folded block scalar chomping: a blank-only body clips and strips to empty, but keep preserves it", () => {
  // Verified against yaml.safe_load: `a: |\n\nb: 1\n` -> {'a': '', 'b': 1},
  // not {'a': '\n', 'b': 1} — a block scalar whose only collected line is
  // blank clips to "", the same as no content at all. Keep (+) is the one
  // mode that preserves it: `a: |+\n\nb: 1\n` -> {'a': '\n', 'b': 1}.
  assert.equal(parseWorkflowYaml("a: |\n\nb: 1\n").a, "");
  assert.equal(parseWorkflowYaml("a: |-\n\nb: 1\n").a, "");
  assert.equal(parseWorkflowYaml("a: |+\n\nb: 1\n").a, "\n");
  assert.equal(parseWorkflowYaml("a: >\n\nb: 1\n").a, "");
  // Two blank lines behave the same way under clip/strip, and keep preserves
  // both: yaml.safe_load("a: |+\n\n\nb: 1\n") -> {'a': '\n\n', 'b': 1}.
  assert.equal(parseWorkflowYaml("a: |\n\n\nb: 1\n").a, "");
  assert.equal(parseWorkflowYaml("a: |+\n\n\nb: 1\n").a, "\n\n");
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

test("throws on an unterminated flow sequence, rather than returning the malformed text as a plain string", () => {
  // "runs-on: [ubuntu-latest" (no closing ]) previously fell through to
  // parseScalar's final `return s`, silently returning the literal string
  // "[ubuntu-latest" instead of raising. Verified against
  // yaml.safe_load("runs-on: [ubuntu-latest\n"), which raises a
  // ParserError ("expected ',' or ']', but got <stream end>") — GitHub's
  // own parser rejects this workflow outright.
  assert.throws(
    () => parseWorkflowYaml("runs-on: [ubuntu-latest\n"),
    /unterminated flow sequence/,
  );
  // A valid, fully-closed flow sequence must still parse.
  const doc = parseWorkflowYaml("runs-on: [ubuntu-latest]\n");
  assert.deepEqual(doc["runs-on"], ["ubuntu-latest"]);
});

test("throws on a surplus closing bracket, not just a missing one", () => {
  // "runs-on: [ubuntu-latest]]" still ends with "]", so the unterminated
  // check above doesn't catch it — the old code sliced off exactly one
  // leading/trailing character regardless and handed splitFlowSequence
  // "ubuntu-latest]", silently returning ["ubuntu-latest]"] (a literal "]"
  // smuggled into element content) instead of rejecting it. Verified
  // against yaml.safe_load, which raises a ParserError ("while parsing a
  // block mapping") rather than returning a value.
  assert.throws(
    () => parseWorkflowYaml("runs-on: [ubuntu-latest]]\n"),
    /unbalanced flow sequence brackets/,
  );
  // Content that closes and then continues past the close, not just a
  // trailing bracket — same defect, different shape.
  assert.throws(
    () => parseWorkflowYaml("foo: [a][b]\n"),
    /unbalanced flow sequence brackets/,
  );
  // A nested, genuinely balanced flow sequence must still parse.
  const doc = parseWorkflowYaml("foo: [[a], [b]]\n");
  assert.deepEqual(doc.foo, [["a"], ["b"]]);
});

test("throws on an empty element in a flow sequence, while still allowing a single trailing comma", () => {
  // "[ubuntu-latest,,other]" (two commas in a row) pushed an empty
  // `current` at the second comma, and parseScalar turned that empty
  // string into `null` — so a missing element silently became a literal
  // null in the array instead of being rejected. Verified against
  // yaml.safe_load, which raises a ParserError for a doubled comma, a
  // leading comma, and a whitespace-only element alike, but accepts a
  // SINGLE trailing comma (dropped, not an element at all).
  assert.throws(
    () => parseWorkflowYaml("runs-on: [ubuntu-latest,,other]\n"),
    /empty element in flow sequence/,
  );
  assert.throws(
    () => parseWorkflowYaml("runs-on: [,ubuntu-latest,other]\n"),
    /empty element in flow sequence/,
  );
  assert.throws(
    () => parseWorkflowYaml("runs-on: [a, ,b]\n"),
    /empty element in flow sequence/,
  );
  assert.throws(
    () => parseWorkflowYaml("runs-on: [a,b,,]\n"),
    /empty element in flow sequence/,
  );
  // A single trailing comma is valid YAML and must still parse.
  const doc = parseWorkflowYaml("runs-on: [ubuntu-latest, other,]\n");
  assert.deepEqual(doc["runs-on"], ["ubuntu-latest", "other"]);
});

test("throws on an unquoted ': ' inside a plain scalar, in both block and flow-sequence context", () => {
  // "runs-on: ubuntu: latest" previously fell through to the plain-scalar
  // return, silently accepting "ubuntu: latest" as ordinary text. Verified
  // against yaml.safe_load, which raises a ParserError ("mapping values
  // are not allowed here") — a colon followed by whitespace (or at the
  // very end of the scalar) always reads as a nested mapping-value
  // indicator in real YAML, never as scalar content, whether the
  // whitespace is a space or a tab.
  assert.throws(
    () => parseWorkflowYaml("runs-on: ubuntu: latest\n"),
    /unquoted/,
  );
  assert.throws(() => parseWorkflowYaml("a: b:\tc\n"), /unquoted/);
  assert.throws(() => parseWorkflowYaml("a: b:\n"), /unquoted/);
  assert.throws(() => parseWorkflowYaml("a: b : c\n"), /unquoted/);

  // Inside a flow sequence, "[b: c]" isn't invalid YAML at all — it's a
  // flow-mapping SHORTHAND (yaml.safe_load resolves it to [{'b': 'c'}]),
  // a construct this minimal parser doesn't implement any more than it
  // implements bracketed "{ b: c }". Silently returning the literal
  // string "b: c" would be the same kind of wrong as silently returning
  // an unsupported flow mapping's brace text, so this rejects it the same
  // way rather than only catching the block-mapping-value shape.
  assert.throws(() => parseWorkflowYaml("a: [b: c]\n"), /unquoted/);

  // A colon NOT followed by whitespace is unambiguous and must still parse.
  assert.equal(parseWorkflowYaml("a: http://x.com\n").a, "http://x.com");
  assert.equal(parseWorkflowYaml("a: 1:30\n").a, "1:30");
  // A colon-space INSIDE a quoted scalar is unaffected — the rule only
  // applies to plain (unquoted) scalars, which is exactly the branch this
  // check lives in; a quoted scalar returns earlier and never reaches it.
  assert.equal(parseWorkflowYaml('a: "b: c"\n').a, "b: c");
});

test("throws on a tagged scalar, whether the tag is a standard resolvable one or a custom one", () => {
  // "runs-on: !!str ubuntu-latest" and "a: !custom value" both previously
  // fell through to the plain-scalar return, silently returning the tag
  // and payload together as one literal string. Tags are explicitly out
  // of this file's stated scope (see the file header), same as
  // anchors/aliases just above this check — and unlike anchors/aliases,
  // not every tagged scalar is even invalid YAML: yaml.safe_load resolves
  // "!!str ubuntu-latest" (a standard, known tag) to the plain string
  // "ubuntu-latest", while "!custom value" (an unknown local tag)
  // genuinely errors ("could not determine a constructor"). This parser
  // draws no distinction between the two cases — both are out of scope,
  // so both throw, rather than only rejecting the one real YAML itself
  // would also reject.
  assert.throws(
    () => parseWorkflowYaml("runs-on: !!str ubuntu-latest\n"),
    /tags are not supported/,
  );
  assert.throws(
    () => parseWorkflowYaml("a: !custom value\n"),
    /tags are not supported/,
  );
});

test("prefers the more specific unterminated-quote error over a generic bracket-imbalance one", () => {
  // 'a: ["b, c]' has an unterminated quote AND, read as pure bracket
  // counting, an "imbalance" (the quote swallows the sequence's own
  // closing "]" into its own unclosed run). Verified against
  // yaml.safe_load, which reports this shape as "while scanning a quoted
  // scalar" — the more specific, more useful diagnostic — not a
  // flow-sequence parse error, so hasBalancedFlowBrackets defers to the
  // existing unterminated-quoted-scalar check rather than reporting its
  // own generic error first.
  assert.throws(
    () => parseWorkflowYaml('a: ["b, c]\n'),
    /unterminated quoted scalar/,
  );
});

test("throws on a tab in a line's indentation, including when the tab is the line's very FIRST character", () => {
  // The original tab check computed indent by matching only leading SPACES
  // (raw.replace(/^ */, "")), so a line whose indentation is a tab from its
  // very first character matched zero leading spaces — indent came out 0,
  // and the check then tab-tested raw.slice(0, 0), always "". The check
  // was unreachable for exactly the case it existed to catch. Verified
  // against yaml.safe_load("a:\n\tb: c\n"), which raises a ScannerError
  // ("found character '\\t' that cannot start any token") rather than
  // accepting it as two top-level keys (the old bug's actual result).
  assert.throws(
    () => parseWorkflowYaml("a:\n\tb: c\n"),
    /tab in indentation/,
  );
  // A tab AFTER some leading spaces must be caught too — checked directly
  // rather than assumed, since it turns out the ORIGINAL (broken) check
  // missed this shape as well: raw.replace(/^ */, "") matches only the
  // leading spaces and stops at the tab, so raw.slice(0, indent) never
  // included the tab there either. Both shapes were broken; this fix
  // closes both.
  assert.throws(
    () => parseWorkflowYaml("a:\n  \tb: c\n"),
    /tab in indentation/,
  );
});

test("throws on an unterminated quoted scalar, rather than returning the malformed text as a plain string", () => {
  // `name: "example` (no closing quote) previously fell through every
  // quoted-scalar branch — startsWith('"') && endsWith('"') was false, since
  // it doesn't end with a quote at all — and returned the literal text
  // `"example`, quote character included, as an ordinary plain scalar.
  // Verified against yaml.safe_load('name: "example\n'), which raises a
  // ScannerError ("unexpected end of stream") rather than returning a
  // value: GitHub's own parser rejects this workflow outright, so silently
  // parsing it here would let a structural test stay green against YAML
  // that can't actually run.
  assert.throws(
    () => parseWorkflowYaml('a: "example\n'),
    /unterminated quoted scalar/,
  );
  assert.throws(
    () => parseWorkflowYaml("a: 'example\n"),
    /unterminated quoted scalar/,
  );
});

test("throws on an unterminated quoted scalar inside a flow sequence too, not just as a bare value", () => {
  // splitFlowSequence hands each element to the same parseScalar the bare-
  // value case above exercises, so an unterminated quote reachable only
  // through a flow-sequence element ('a: ["b, c]') needs its own case:
  // fixing only the bare-value path would leave this one silently wrong.
  assert.throws(
    () => parseWorkflowYaml('a: ["b, c]\n'),
    /unterminated quoted scalar/,
  );
});

test("does not false-positive on a validly-quoted scalar whose content happens to end in an escaped quote", () => {
  // A double-quoted scalar ending `\"` immediately before the real closing
  // quote (`"a\""` — content is a literal `a"`) must still parse: the
  // escaped quote is content, not the terminator, and the REAL terminator
  // is the character after it.
  const doc = parseWorkflowYaml('a: "a\\""\n');
  assert.equal(doc.a, 'a"');
});

test("accepts an empty flow mapping as a value, and throws on a non-empty one", () => {
  // "permissions: {}" is a common least-privilege idiom and unambiguous, so
  // it's supported directly. A non-empty flow mapping ("{ contents: read }")
  // is real, valid YAML — verified against yaml.safe_load, which parses it
  // into a genuine nested dict — but is out of this minimal parser's scope.
  // Before this fix, parseScalar had no check for either shape, so a
  // non-empty flow mapping fell through to the plain-scalar fallback and
  // was silently returned as the literal brace text (a string), not
  // rejected.
  const doc = parseWorkflowYaml("permissions: {}\n");
  assert.deepEqual(doc.permissions, {});

  assert.throws(
    () => parseWorkflowYaml("permissions: {contents: read}\n"),
    /flow mappings are not supported/,
  );
});

test("throws on an unterminated flow mapping, rather than returning the malformed text as a plain string", () => {
  // "permissions: {contents: write" (no closing brace) previously fell
  // through the old compound startsWith("{") && endsWith("}") condition —
  // false here, since there's no closing brace at all — straight to
  // parseScalar's final `return s`, silently returning the literal string
  // "{contents: write" instead of raising. Verified against
  // yaml.safe_load("permissions: {contents: write\n"), which raises a
  // ParserError ("while parsing a flow mapping") rather than returning a
  // value — the same shape of bug the unterminated-flow-sequence check
  // above already guards against for "[".
  assert.throws(
    () => parseWorkflowYaml("permissions: {contents: write\n"),
    /unterminated flow mapping/,
  );
});

test("throws on a non-empty flow mapping reached as a sequence item too, not just as a bare value", () => {
  // parseSequence's "- key: value" detection only recognizes a bare
  // identifier/quoted-string key before the colon; "- { a: 1 }" doesn't
  // match, so it falls through to parseScalar on "{ a: 1 }" — the same
  // function the bare-value case above exercises, but reached via a
  // different call site, so it needs its own coverage.
  assert.throws(
    () => parseWorkflowYaml("foo:\n  - { a: 1 }\n"),
    /flow mappings are not supported/,
  );
});

test("throws on a duplicate mapping key at the top level", () => {
  // Verified against yaml.safe_load("a: 1\na: 2\n"): PyYAML's default
  // SafeLoader is lenient and silently keeps the last value ({'a': 2}), but
  // duplicate-key rejection is the spec-correct, commonly-enforced reading
  // (confirmed with a stricter loader using a no-duplicates constructor,
  // which raises ConstructorError). Before this fix, parseMapping's
  // `obj[key] = ...` assignment was unconditional, so a repeated
  // "permissions:" block — a plausible copy-paste mistake — silently kept
  // only the last one with no signal that the first was ever discarded.
  assert.throws(
    () => parseWorkflowYaml("permissions:\n  contents: read\npermissions:\n  contents: write\n"),
    /duplicate mapping key "permissions"/,
  );
});

test("throws on a duplicate mapping key nested under another key", () => {
  assert.throws(
    () => parseWorkflowYaml("permissions:\n  contents: read\n  contents: write\n"),
    /duplicate mapping key "contents"/,
  );
});

test("throws on a duplicate mapping key inside an inline '- key: value' sequence item", () => {
  // Inline mapping items (a sequence item written as "- key: value" with
  // further "key: value" siblings at the same indent) are built by
  // applyMappingEntry via a separate `target[key] = ...` assignment site
  // from parseMapping's `obj[key] = ...` — both needed the same guard.
  assert.throws(
    () => parseWorkflowYaml("foo:\n  - a: 1\n    a: 2\n"),
    /duplicate mapping key "a"/,
  );
});

test("does not false-positive on same-named keys at different nesting levels", () => {
  // "contents" appears once under "permissions" and once under a sibling
  // "other" key — these are different objects, not a duplicate.
  const doc = parseWorkflowYaml("permissions:\n  contents: read\nother:\n  contents: write\n");
  assert.equal(doc.permissions.contents, "read");
  assert.equal(doc.other.contents, "write");
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
