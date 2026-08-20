// Randomized adversarial testing for yaml-lite.js. Every hand-written test
// in yaml-lite.test.js was added AFTER a specific bug was found — several of
// them by Codex review, some by hand-derivation that turned out wrong twice
// before being fixed (see the folded-block-scalar comments). Fuzzing exists
// to catch the next one before a review round has to.
//
// The contract under test is narrow and stated in yaml-lite.js's own header:
// parseWorkflowYaml either returns a correct structural result or throws.
// This file cannot check "correct" for arbitrary input (there's no oracle
// here, and installing PyYAML to compare against would be exactly the
// dependency this repo exists to avoid) — what it CAN check, for any input,
// is that the parser never does anything worse than throw: no unbounded
// hang, no stack overflow, no uncaught non-Error throw, and — the specific
// bug this file caught on its first real run (see yaml-lite.test.js's
// "invalid escape sequence" test) — no error that isn't in this parser's
// own "yaml-lite: ..." convention or a small allow-listed exception.
//
// Seeded (mulberry32), not Math.random(): a fuzz failure needs to be
// reproducible from the seed printed in the failure message, not a fluke
// that only happened in one CI run and never again.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseWorkflowYaml } = require("./yaml-lite.js");

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// Fragments chosen to land near this parser's actual decision points —
// quote characters, block-scalar indicators, brackets, tabs, the reserved
// leading characters, escape sequences — rather than pure random bytes,
// which would mostly exercise only the trivial plain-scalar path.
const FRAGMENTS = [
  "a", "b", "-", "- ", "-  ", "--", ": ", ":", "::", "  ", "\t", "\n", "\n\n",
  '"', "'", "''", '\\"', "\\q", "\\n", "\\t", "\\u", "{", "}", "{}", "[", "]",
  "[]", "[,]", ",", "|", "|-", "|+", ">", ">-", ">+", "&", "*", "!", "!!str",
  "@", "`", "%", "#", " #", "on:", "run:", "true", "false", "null", "~",
  "yes", "no", "off", "key", "0", "-1", "1.5", "${{ github.sha }}",
  "steps.x.outputs.y", "__proto__", "constructor", "prototype",
  // A U+00A0 (NBSP) character and a tab-only "blank" line — both found real gaps here:
  // JS's \s matches NBSP but YAML's own separation-whitespace doesn't, and
  // a tab-only line trims to "" (this file's own isBlank definition) but
  // still has indentation to validate.
  " ", "\t\n", "\t\t\n",
];

function randomYamlish(rng, maxFragments) {
  const n = 1 + Math.floor(rng() * maxFragments);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += pick(rng, FRAGMENTS);
    if (rng() < 0.3) out += pick(rng, [" ", "\n", "  "]);
  }
  return out;
}

// A short allow-list of native error types this parser is known to
// legitimately let through today, alongside its own "yaml-lite: ..."
// convention — anything outside both is a gap to fix, not a fuzz false
// positive to suppress. Kept intentionally tiny: growing this list should
// require the same scrutiny as growing the parser's own throw sites did.
const ALLOWED_NATIVE_ERROR = () => false;

test("fuzz: never hangs, never stack-overflows, never throws outside its own error convention", () => {
  const rng = mulberry32(0xc0ffee);
  const seenErrorKinds = new Set();
  for (let i = 0; i < 20000; i++) {
    const input = randomYamlish(rng, 12);
    try {
      const doc = parseWorkflowYaml(input);
      // A non-throwing result must at least be a plausible YAML value —
      // never undefined (every code path either returns a real value or
      // throws; undefined would mean a branch fell through both).
      assert.notEqual(doc, undefined, `parsed to undefined for input ${JSON.stringify(input)}`);
    } catch (e) {
      assert.ok(
        e instanceof Error,
        `threw a non-Error for input ${JSON.stringify(input)}: ${String(e)}`,
      );
      const isOwnError = /^yaml-lite: /.test(e.message);
      if (!isOwnError) seenErrorKinds.add(`${e.constructor.name}: ${e.message}`);
      assert.ok(
        isOwnError || ALLOWED_NATIVE_ERROR(e),
        `input ${JSON.stringify(input)} (seed 0xc0ffee, iteration ${i}) threw ` +
          `outside yaml-lite's own error convention: ${e.constructor.name}: ${e.message}`,
      );
    }
  }
  assert.deepEqual(
    [...seenErrorKinds],
    [],
    "every rejection must use yaml-lite's own error convention — see the list above for what leaked through",
  );
});

test("fuzz: recursive-structure inputs (deeply nested flow sequences and block mappings) terminate", () => {
  const rng = mulberry32(0x5eed);
  for (let i = 0; i < 200; i++) {
    const depth = 5 + Math.floor(rng() * 200);
    const nested = "[".repeat(depth) + "a" + "]".repeat(depth) + "\n";
    // Must either parse (balanced) or throw (this generator always balances,
    // so it should always parse) — the property under test is termination
    // and a clean throw/return, not a specific structural result.
    assert.doesNotThrow(() => parseWorkflowYaml(`a: ${nested}`));

    // An unbalanced version (one extra opener) must throw cleanly rather
    // than hang or crash with something other than this parser's own error.
    const unbalanced = "[".repeat(depth + 1) + "a" + "]".repeat(depth) + "\n";
    assert.throws(() => parseWorkflowYaml(`a: ${unbalanced}`), /yaml-lite:/);

    // Deeply nested block mappings — one key per level, each value being
    // the next level's mapping. Unambiguous recursion depth (parseMapping
    // -> parseNode -> parseMapping -> ...) one call per level, unlike a
    // hand-built sequence-of-keyed-items shape that turned out not to be
    // well-formed YAML for every depth tried. The innermost value is an
    // inline scalar ON the last key's own line ("kN: x"), not a bare
    // scalar on its own deeper line — the latter is an implicit multi-line
    // plain scalar block value, a different (and unsupported, see
    // parseNode) construct fuzzing found by accident while this test was
    // being written.
    const mappingDepth = Math.min(depth, 300);
    const lines = [];
    for (let level = 0; level < mappingDepth - 1; level++) {
      lines.push(`${"  ".repeat(level)}k${level}:`);
    }
    lines.push(`${"  ".repeat(mappingDepth - 1)}k${mappingDepth - 1}: x`);
    assert.doesNotThrow(() => parseWorkflowYaml(lines.join("\n") + "\n"));
  }
});

test("fuzz: adversarial expression-injection-shaped inputs never silently drop the expression", () => {
  // Not a security boundary in itself (this parser doesn't evaluate
  // anything) — but a consumer using it to assert "no ${{ }} expression
  // appears outside an env: block" depends on the parser preserving the
  // expression text verbatim rather than mangling or swallowing it, in
  // every scalar context it can appear in.
  const rng = mulberry32(0xbadc0de);
  const expressions = [
    "${{ steps.x.outputs.y }}",
    "${{ needs.job.outputs.z }}",
    "${{ github.event.repository.default_branch }}",
    "${{ secrets.TOKEN }}",
  ];
  for (let i = 0; i < 500; i++) {
    const expr = pick(rng, expressions);
    const wrapper = pick(rng, [
      (e) => `a: ${e}\n`,
      (e) => `a: "${e}"\n`,
      (e) => `a: '${e}'\n`,
      (e) => `a: echo ${e}\n`,
      (e) => `a: |\n  echo ${e}\n`,
      (e) => `a: [${e}]\n`,
      (e) => `a: "prefix ${e} suffix"\n`,
    ]);
    const text = wrapper(expr);
    let doc;
    try {
      doc = parseWorkflowYaml(text);
    } catch (e) {
      assert.match(e.message, /^yaml-lite: /, `unexpected error shape for ${JSON.stringify(text)}`);
      continue;
    }
    assert.ok(
      JSON.stringify(doc).includes("steps.x") ||
        JSON.stringify(doc).includes("needs.job") ||
        JSON.stringify(doc).includes("default_branch") ||
        JSON.stringify(doc).includes("secrets.TOKEN"),
      `expression text vanished from parsed result for ${JSON.stringify(text)}: got ${JSON.stringify(doc)}`,
    );
  }
});
