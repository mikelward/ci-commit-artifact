// Resolves the canonical yaml-lite parser for the test suite. It is not
// vendored here: the canonical copy is mikelward/yaml-lite, tracked @main
// like the fleet's other shared machinery (codex-review, the reusable
// workflows themselves). CI checks it out into .yaml-lite/ (see ci.yml);
// locally a sibling clone serves the same role. Required, never skipped:
// a skip would let CI go green with the structural YAML checks silently
// not running — the exact false-pass shape AGENTS.md warns about — so a
// missing parser fails loudly with the fix in the message instead.
const fs = require("node:fs");
const path = require("node:path");

const candidate = [".yaml-lite/yaml-lite.js", "../yaml-lite/yaml-lite.js"]
  .map((p) => path.join(__dirname, p))
  .find((p) => fs.existsSync(p));
if (!candidate) {
  throw new Error(
    "yaml-lite.js not found — it is no longer vendored; the canonical copy is mikelward/yaml-lite. " +
      "CI checks it out into .yaml-lite/ (see ci.yml). Locally: git clone https://github.com/mikelward/yaml-lite ../yaml-lite",
  );
}
module.exports = require(candidate);
