// A hand-rolled parser for exactly the YAML subset GitHub Actions workflow
// files use — block mappings, block and flow sequences, plain/quoted
// scalars, and literal/folded block scalars. Nothing else: no anchors,
// aliases, tags, multi-document streams, or complex (multi-line) flow
// mappings. Encountering one of those is a bug in this parser's scope, not
// a thing to guess at, so it throws rather than silently returning
// something wrong.
//
// Exists so this repository's tests can assert real structure instead of
// regex/string-matching over serialized YAML text — see
// commit-artifact-workflow.test.js for what that fragility looked like in
// practice. Kept in-process and dependency-free on purpose: this repo's own
// workflow is YAML + bash + JS end to end, so shelling out to python3 for a
// real YAML parser (PyYAML, as mikelward/codex-review's check_consumer.py
// does) would be a second runtime taken on for test-time convenience, not a
// structural need the way it is there.
//
// Deliberately does NOT implement YAML 1.1's `on`/`off`/`yes`/`no`-as-boolean
// expansion (only `true`/`false`/`null`/`~` are recognized) — that quirk is
// exactly what makes a bare `on:` trigger key read as the boolean `true` in
// a spec-following YAML 1.1 parser (PyYAML included), which every GitHub
// Actions workflow then has to work around. Skipping it here isn't a
// compatibility gap; a workflow's `on:` key means the literal word "on" to
// every tool that actually reads these files, GitHub's own parser included.

function parseWorkflowYaml(text) {
  // text.split("\n") always yields one MORE element than the document has
  // real lines whenever text ends in "\n" — that trailing "" represents
  // "nothing after the final newline", not a genuine blank line the
  // document's author typed. Everywhere else that synthetic element is
  // harmless (it's blank, so the structural view below already skips it),
  // but parseBlockScalar consumes rawLines directly by raw indentation, and
  // a block scalar running to the true end of the document would swallow it
  // as if it were one more real trailing blank line — inflating `collected`
  // and, for `+` (keep) chomping specifically, changing the result. Caught
  // by a document ending exactly "...x\n" with no line after the block
  // scalar: stripping this one synthetic element up front, rather than
  // trying to special-case it inside parseBlockScalar, keeps rawLines a
  // faithful one-entry-per-real-line model throughout.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;

  // Every raw line, blank and comment lines included — a block scalar's
  // body is scanned by raw indentation, and `#` inside one is content, not
  // a comment marker (a bash comment inside a `run: |` block, most
  // pointedly). Filtering those out up front, before anything knows
  // whether a given line sits inside a block scalar, was this parser's
  // first real bug — caught by round-tripping this repo's own workflow.
  const rawLines = body.split("\n").map((raw, i) => {
    // Leading whitespace scanned as SPACES-OR-TABS first, tabs checked
    // against that — not raw.replace(/^ */, "") followed by checking
    // raw.slice(0, indent) for a tab, which made the check unreachable for
    // the exact case it exists to catch: a line whose indentation is a tab
    // from its very first character matches zero leading spaces, so indent
    // was computed as 0 and the slice it then tab-checked was always "".
    // Verified against yaml.safe_load("a:\n\tb: c\n"), which raises a
    // ScannerError ("found character '\t' that cannot start any token")
    // rather than accepting it as two top-level keys.
    const leadingWhitespace = raw.match(/^[ \t]*/)[0];
    if (leadingWhitespace.includes("\t")) {
      throw new Error(`yaml-lite: tab in indentation at line ${i + 1} — not supported`);
    }
    const indent = leadingWhitespace.length;
    const trimmed = raw.trim();
    return {
      n: i + 1,
      raw,
      indent,
      content: raw.slice(indent),
      isBlank: trimmed === "",
      isComment: trimmed.startsWith("#"),
    };
  });

  // The structural view: every raw line that isn't blank or a full-line
  // comment, each still carrying its own index into rawLines so block-scalar
  // consumption (which needs the raw stream) and structural parsing (which
  // needs blanks/comments skipped) can hand off to each other correctly.
  const structural = [];
  rawLines.forEach((line, rawIndex) => {
    if (!line.isBlank && !line.isComment) structural.push({ ...line, rawIndex });
  });

  let pos = 0;
  function peek() {
    return pos < structural.length ? structural[pos] : null;
  }
  // Advances the structural cursor past every entry whose raw line index is
  // before `rawIndex` — used after a block scalar has consumed some run of
  // raw lines directly, to resync where structural parsing resumes.
  function resyncPast(rawIndex) {
    while (pos < structural.length && structural[pos].rawIndex < rawIndex) pos++;
  }

  // Strips a ` #...` inline comment, quote-aware so a literal # inside a
  // quoted string (or a token like a git SHA that happens to follow one) is
  // never mistaken for one. YAML's own rule is the same: a comment starts
  // at a `#` that is either the first character or preceded by whitespace,
  // and is outside any quoted scalar.
  //
  // Quoting is a property of how the WHOLE scalar begins, not of any
  // character appearing partway through it — verified against
  // yaml.safe_load("a: echo \"x # y\"\n") -> {'a': 'echo "x'}, not the
  // whole string with the # preserved. A plain scalar with a shell-quoted
  // substring (`run: echo "x # y"`, extremely common) is not a quoted
  // scalar at all: the embedded " has no special meaning, and # still
  // starts a comment by the ordinary preceded-by-whitespace rule. `quote`
  // may only be entered while `sawNonSpace` is still false — i.e. at the
  // scalar's own first non-whitespace character.
  function stripInlineComment(text) {
    let quote = null;
    let sawNonSpace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) {
          if (quote === "'" && text[i + 1] === "'") {
            i++; // escaped '' inside a single-quoted scalar
            continue;
          }
          quote = null;
        } else if (quote === '"' && ch === "\\") {
          i++; // skip the escaped character
        }
        continue;
      }
      if (!sawNonSpace && (ch === "'" || ch === '"')) {
        quote = ch;
        sawNonSpace = true;
        continue;
      }
      if (!/\s/.test(ch)) sawNonSpace = true;
      if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
        return text.slice(0, i);
      }
    }
    return text;
  }

  function parseScalar(text) {
    const s = stripInlineComment(text).trim();
    if (s === "") return null;
    if (s === "null" || s === "~") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (s.startsWith("&") || s.startsWith("*")) {
      throw new Error(`yaml-lite: anchors/aliases are not supported (got ${JSON.stringify(s)})`);
    }
    // Tags ("!!str foo", "!custom bar") are explicitly out of this file's
    // header-stated scope, same as anchors/aliases above — but unlike
    // anchors/aliases, a tagged scalar isn't even always invalid YAML:
    // yaml.safe_load resolves "!!str ubuntu-latest" to the plain string
    // "ubuntu-latest" (a standard, known tag), while it genuinely errors
    // on "!custom value" ("could not determine a constructor"). This
    // parser draws no distinction between the two — both throw, since
    // implementing tag resolution is out of scope either way and silently
    // returning "!!str ubuntu-latest" as the literal 18-character string
    // (this file's previous behavior, via the plain-scalar fallback) is
    // wrong regardless of which case it is.
    if (s.startsWith("!")) {
      throw new Error(`yaml-lite: tags are not supported (got ${JSON.stringify(s)})`);
    }
    // "@", "`" and "%" are reserved as a plain scalar's OWN first
    // character — verified against yaml.safe_load, which raises a
    // ScannerError ("while scanning for the next token") for
    // "runs-on: @invalid", "a: \`invalid" and "a: %invalid" alike, while
    // the SAME characters elsewhere in a scalar are perfectly ordinary
    // ("a: b@c", "a: b\`c", "a: 100%" all parse fine). Only the leading
    // position is reserved, so this checks startsWith, not includes.
    if (s.startsWith("@") || s.startsWith("`") || s.startsWith("%")) {
      throw new Error(`yaml-lite: reserved leading character in a plain scalar (got ${JSON.stringify(s)})`);
    }
    // A scalar that OPENS a quote must genuinely close it, right at its own
    // last character — not just happen to end in a quote character (an
    // escaped one doesn't count) and not fail to close at all. A blind
    // `startsWith(q) && endsWith(q)` check (what the branches below relied
    // on alone) treats `"example` — no closing quote anywhere — as an
    // ordinary plain scalar starting with a literal `"`, silently returning
    // the malformed text instead of catching that GitHub's own parser
    // rejects it outright. Verified against yaml.safe_load('name: "example\n'),
    // which raises a ScannerError for "unexpected end of stream" rather than
    // returning a value. Reachable both directly and via a flow-sequence
    // element (splitFlowSequence hands an unterminated quoted element to
    // this same function), so one check here covers both.
    if ((s.startsWith("'") && !hasClosingQuote(s, "'")) || (s.startsWith('"') && !hasClosingQuote(s, '"'))) {
      throw new Error(`yaml-lite: unterminated quoted scalar (got ${JSON.stringify(s)})`);
    }
    if (s.startsWith("{")) {
      // Checked separately from endsWith("}") below — a compound
      // startsWith("{") && endsWith("}") condition (this file's first
      // version) is false for an unmatched opener ("permissions:
      // {contents: write", no closing brace) and falls through every
      // remaining branch to the plain-scalar return at the bottom,
      // silently returning the malformed text instead of rejecting it.
      // Verified against yaml.safe_load("permissions: {contents: write\n"),
      // which raises a ParserError ("while parsing a flow mapping")
      // rather than returning a value — the same shape of bug the
      // unterminated-flow-sequence check below already guards against.
      if (!s.endsWith("}")) {
        throw new Error(`yaml-lite: unterminated flow mapping (got ${JSON.stringify(s)})`);
      }
      // An empty flow mapping ("permissions: {}", least-privilege
      // workflows' standard idiom) is unambiguous and costs nothing to
      // support. A NON-empty one ("{ contents: read }") is out of this
      // parser's scope (see the file header) — real, valid YAML that
      // yaml.safe_load parses into a genuine nested object, but this
      // parser previously returned the brace text as a literal STRING
      // instead, silently wrong rather than merely unsupported (the file
      // header's own stated contract is to throw on out-of-scope
      // constructs, not guess). Reachable both as a plain mapping value
      // and as a sequence item's scalar ("- { a: 1 }" falls through the
      // "- key: value" check in parseSequence, since its rest starts with
      // "{" rather than a bare key, straight into this function).
      const inner = s.slice(1, -1).trim();
      if (inner === "") return {};
      throw new Error(`yaml-lite: flow mappings are not supported (got ${JSON.stringify(s)})`);
    }
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
      return JSON.parse(s);
    }
    if (s.startsWith("[")) {
      // An unmatched opening bracket ("runs-on: [ubuntu-latest", no closing
      // "]") previously fell through to the plain-scalar return below,
      // silently returning the literal text "[ubuntu-latest" instead of
      // rejecting it — verified against yaml.safe_load, which raises a
      // ParserError ("expected ',' or ']', but got <stream end>") rather
      // than returning a value.
      if (!s.endsWith("]")) {
        throw new Error(`yaml-lite: unterminated flow sequence (got ${JSON.stringify(s)})`);
      }
      // endsWith("]") alone only rules out a MISSING close, not a surplus
      // one: "runs-on: [ubuntu-latest]]" still ends with "]", but the
      // extra bracket makes it invalid YAML — verified against
      // yaml.safe_load, which raises a ParserError ("while parsing a
      // block mapping") rather than returning a value. The old check
      // sliced off exactly one leading/trailing character regardless,
      // handing splitFlowSequence "ubuntu-latest]" and silently returning
      // ["ubuntu-latest]"] — a real bracket smuggled into element content.
      // hasBalancedFlowBrackets confirms the sequence's own brackets net
      // to zero and land on the string's LAST character, not just that a
      // "]" appears somewhere after the "[".
      if (!hasBalancedFlowBrackets(s)) {
        throw new Error(`yaml-lite: unbalanced flow sequence brackets (got ${JSON.stringify(s)})`);
      }
      const inner = s.slice(1, -1).trim();
      if (inner === "") return [];
      return splitFlowSequence(inner).map(parseScalar);
    }
    // An unquoted plain scalar containing ": " (colon then whitespace) or
    // ending in a bare ":" is invalid where it's reachable from — both a
    // block mapping's value ("runs-on: ubuntu: latest", genuinely
    // ambiguous YAML: a colon followed by whitespace/EOL always reads as
    // a nested mapping-value indicator, never scalar content) and a flow
    // sequence element ("[b: c]", which real YAML resolves as a flow
    // MAPPING shorthand — {b: 'c'} — a construct this parser doesn't
    // implement, so silently returning it as the literal string "b: c"
    // would be wrong the same way an unimplemented flow mapping is
    // elsewhere in this file). Verified against yaml.safe_load: "a: b: c"
    // and "a: b:\tc" both raise "mapping values are not allowed here";
    // "a: [b: c]" parses as [{'b': 'c'}], not a scalar. A colon NOT
    // followed by whitespace ("http://x.com", "1:30", "b:c") is
    // unambiguous and stays a plain scalar.
    if (/:\s|:$/.test(s)) {
      throw new Error(`yaml-lite: unquoted ": " or trailing ":" in a plain scalar (got ${JSON.stringify(s)})`);
    }
    return s;
  }

  // Whether `s` (which starts with `quoteChar`) has a genuine, unescaped
  // closing quote as its very last character. Forward scan skipping the
  // character after a backslash inside a double-quoted run, and a doubled
  // `''` inside a single-quoted one — the same escape-tracking style as
  // stripInlineComment and splitFlowSequence below, kept consistent rather
  // than reinvented, since getting this asymmetric by accident is exactly
  // how this file's earlier quote-handling bugs happened.
  function hasClosingQuote(s, quoteChar) {
    for (let i = 1; i < s.length; i++) {
      const ch = s[i];
      if (quoteChar === '"' && ch === "\\") {
        i++; // skip the escaped character
        continue;
      }
      if (ch === quoteChar) {
        if (quoteChar === "'" && s[i + 1] === "'") {
          i++; // escaped '' inside a single-quoted scalar
          continue;
        }
        return i === s.length - 1;
      }
    }
    return false;
  }

  // Whether `s` (a flow sequence, brackets included) has genuinely
  // balanced [ ] delimiters: depth never goes negative (no unmatched
  // closer) and returns to exactly 0 only once, at the string's own last
  // character (no unmatched opener, and nothing trailing after the
  // sequence's own close — "[a]]" and "[a][b]" both fail this the same
  // way, at the first bracket that closes the depth-0 case is not the
  // final character). Quote-aware — the same reason splitFlowSequence and
  // stripInlineComment are: a bracket character inside a quoted element
  // ("[\"a]b\"]") is content, not a delimiter, so it must not be counted.
  // `elementStart` restricts quote-opening to an element's OWN first
  // character, same rule and same reason as splitFlowSequence's
  // `current.trim() === ""` guard: without it, this function previously
  // entered quote mode for ANY quote character anywhere, so
  // "[echo \"x]y\", q]" swallowed the real closing "]" right after "x"
  // into a synthetic quote run and read the whole thing as balanced —
  // verified against yaml.safe_load, which rejects it outright. `[` and
  // `,` both start a fresh element (nested or sibling); any non-whitespace
  // character ends "start of element".
  function hasBalancedFlowBrackets(s) {
    let depth = 0;
    let quote = null;
    let elementStart = true;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (quote === '"' && ch === "\\") {
          i++; // skip the escaped character
          continue;
        }
        if (ch === quote) {
          if (quote === "'" && s[i + 1] === "'") {
            i++; // escaped '' inside a single-quoted element
            continue;
          }
          quote = null;
        }
        continue;
      }
      if ((ch === "'" || ch === '"') && elementStart) {
        quote = ch;
        elementStart = false;
        continue;
      }
      if (ch === "[") {
        depth++;
        elementStart = true;
        continue;
      }
      if (ch === "]") {
        depth--;
        elementStart = false;
        if (depth < 0) return false;
        if (depth === 0) return i === s.length - 1;
        continue;
      }
      if (ch === ",") {
        elementStart = true;
        continue;
      }
      if (!/\s/.test(ch)) elementStart = false;
    }
    // A quote still open at the string's end ('a: ["b, c]') is a
    // different, more specific defect — an unterminated quoted scalar —
    // that parseScalar/hasClosingQuote already catches once this element
    // is actually parsed. Deferring to that here (rather than reporting
    // it as an unbalanced-bracket problem) keeps the more accurate
    // diagnostic: verified against yaml.safe_load, which reports this
    // shape as "while scanning a quoted scalar", not a flow-sequence
    // parse error.
    if (quote) return true;
    return depth === 0;
  }

  // Same escape handling as stripInlineComment, and for the same reason: a
  // quoted flow-sequence element can contain the comma or the quote
  // character this function splits/closes on. `"x\"y,z"` is ONE element
  // (`x"y,z`) to a real YAML parser — closing the quote at the escaped `"`
  // (as an earlier version did, by only checking `ch === quote`) makes the
  // comma that follows read as a top-level separator, corrupting it into
  // two. Index-based, not for-of, so `i++` can consume the escaped
  // character's index directly.
  function splitFlowSequence(inner) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = "";
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (quote) {
        current += ch;
        if (ch === quote) {
          if (quote === "'" && inner[i + 1] === "'") {
            current += inner[++i]; // escaped '' inside a single-quoted element
            continue;
          }
          quote = null;
        } else if (quote === '"' && ch === "\\") {
          current += inner[++i]; // skip the escaped character
        }
        continue;
      }
      // Same restriction as stripInlineComment, for the same reason: a
      // quote only starts a quoted ELEMENT when it's that element's own
      // first character (nothing but whitespace accumulated since the
      // last split point), not wherever one happens to appear —
      // `[echo "hi, x", b]` is a plain scalar `echo "hi` split at the
      // embedded comma the same as GitHub's own parser, not one long
      // quoted element. Verified against yaml.safe_load.
      if ((ch === "'" || ch === '"') && current.trim() === "") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "[") depth++;
      if (ch === "]") depth--;
      if (ch === "," && depth === 0) {
        // An empty element (two commas in a row, or a leading comma) is
        // invalid — verified against yaml.safe_load, which raises a
        // ParserError for "[a,,b]", "[,a,b]" and "[a, ,b]" alike. A SINGLE
        // trailing comma ("[a,b,]") is valid and never reaches this throw:
        // it splits off "b" here (current is non-empty at that point) and
        // the resulting empty tail is dropped below, after the loop, by
        // the trim() check that already existed — this only rejects an
        // element that is empty at a SPLIT point, not the harmless nothing
        // that follows the sequence's own last comma.
        if (current.trim() === "") {
          throw new Error(
            `yaml-lite: empty element in flow sequence (got ${JSON.stringify(`[${inner}]`)})`,
          );
        }
        parts.push(current);
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim() !== "") parts.push(current);
    return parts;
  }

  // Consumes a `|`/`|-`/`|+`/`>`/`>-`/`>+` block scalar, reading RAW lines
  // (blanks and `#`-leading lines included, verbatim) starting right after
  // the header line at raw index `startRawIndex`. A non-blank raw line
  // whose indentation drops to `parentIndent` or shallower ends the block.
  // Resyncs the structural cursor past whatever it consumed before
  // returning, so mapping/sequence parsing picks back up in the right place.
  function parseBlockScalar(style, chomp, parentIndent, startRawIndex) {
    const collected = [];
    let blockIndent = null;
    let i = startRawIndex;
    while (i < rawLines.length) {
      const line = rawLines[i];
      if (!line.isBlank) {
        if (blockIndent === null) {
          if (line.indent <= parentIndent) break;
          blockIndent = line.indent;
        } else if (line.indent <= parentIndent) {
          break;
        } else if (line.indent < blockIndent) {
          // A non-blank line indented less than the block's own first line
          // but still more than the parent — neither a continuation of the
          // block (it doesn't reach blockIndent) nor a dedent out of it (it
          // doesn't reach back to parentIndent). That's not valid YAML; an
          // earlier version silently absorbed it as an empty line instead
          // of rejecting it, which let `a: |\n    x\n  y\nb: 1` parse as
          // `a: "x\n"` with y silently discarded, passing structural
          // assertions against a document GitHub's own parser would reject.
          throw new Error(
            `yaml-lite: line ${line.n} dedents to indent ${line.indent}, between the block scalar's own indent (${blockIndent}) and its parent's (${parentIndent}) — not valid YAML`,
          );
        }
      }
      const effectiveIndent = blockIndent === null ? line.indent : blockIndent;
      collected.push(line.raw.length >= effectiveIndent ? line.raw.slice(effectiveIndent) : "");
      i++;
    }
    // Consumption stopped either because a sibling/dedent line followed (in
    // which case every collected line was genuinely terminated by a "\n" in
    // the source) or because it ran off the true end of the document. Only
    // in the latter case does it matter whether the source itself ended
    // with a trailing newline — text.split("\n") gives the final line no
    // extra empty element when it doesn't, so a document ending "...x" (no
    // final \n) and one ending "...x\n" produce the SAME `collected`, but
    // they are not the same source and `+` (keep) must not treat them
    // alike. Missed on the first fix here — that one only got the
    // already-wrong +/- reconstruction right, not this.
    const hitTrueEOF = i >= rawLines.length;
    const sourceEndsWithNewline = !hitTrueEOF || text.endsWith("\n");
    resyncPast(i);

    let joined;
    if (style === "|") {
      joined = collected.join("\n");
    } else {
      // Folded: verified against real yaml.safe_load output, not derived by
      // hand — this exact reasoning got it wrong twice already (once on the
      // blank+more-indented interaction, then again by treating "more-indented
      // on the left" and "more-indented on the right" as two INDEPENDENT
      // extra breaks that add, when a run of consecutive more-indented lines
      // proved they don't: `>-\n  x\n    y\n    z\n  q` is
      // "x\n  y\n  z\nq", one newline between y and z, not two). The actual
      // rule, checked against ~10 combinations: the newline count for a gap
      // between two content lines is blankRun + (1 if EITHER side of the gap
      // is more-indented, else 0) — a single flag, not one contribution per
      // side. Zero (ordinary, no blank, ordinary) is the only case that
      // folds to a space instead of a literal newline. A leading blank run
      // before the very first content line also needs the same prefix
      // treatment (`>-\n\n  x` is "\nx", not "x") — missed on the previous
      // pass, which discarded blankRun entirely when setting the first line.
      joined = "";
      let blankRun = 0;
      let sawContent = false;
      let prevMoreIndented = false;
      for (const l of collected) {
        if (l.trim() === "") {
          blankRun++;
          continue;
        }
        const moreIndented = /^[ \t]/.test(l);
        if (!sawContent) {
          joined = blankRun > 0 ? "\n".repeat(blankRun) + l : l;
        } else {
          const breaks = blankRun + (prevMoreIndented || moreIndented ? 1 : 0);
          joined += breaks > 0 ? "\n".repeat(breaks) + l : " " + l;
        }
        blankRun = 0;
        sawContent = true;
        prevMoreIndented = moreIndented;
      }
      // Blank lines trailing the last content line still owe their newlines
      // — folded here into `joined` itself so the shared chomp logic below,
      // which (like the literal style) treats `joined` as "content with the
      // final line's own terminator not yet added back", stays correct for
      // a folded scalar too.
      if (blankRun > 0) joined += "\n".repeat(blankRun);
    }
    // `collected` holds one entry per consumed line with no trailing
    // newline of its own (that's what join("\n") strips), so the block's
    // literal content — every consumed line INCLUDING a trailing blank one,
    // each ending in the newline the source actually had — is `joined` plus
    // one newline back for every line that really had one. That's exactly
    // one, UNLESS the block ran to the true end of a document with no final
    // newline, in which case the last collected line had none. This
    // reconstruction is exact for all three chomp modes' *shared* base, not
    // just clip: an earlier version special-cased "keep" as `body + "\n"`
    // on top of the SAME already-clipped `body` other modes used, so a `|+`
    // block silently gained an extra trailing newline beyond whatever the
    // source actually had.
    const literal = collected.length > 0 ? joined + (sourceEndsWithNewline ? "\n" : "") : "";
    if (chomp === "-") return literal.replace(/\n*$/, "");
    // Keep: exactly what the source had, EOF-without-a-final-newline
    // included — nothing to normalize.
    if (chomp === "+") return literal;
    // Clip: collapses any run of trailing blank lines down to at most one
    // newline, but — verified against yaml.safe_load, correcting an earlier
    // version of this comment's claim that clip always normalizes to
    // exactly one trailing "\n" regardless of the source — clip shares
    // keep's EOF-awareness: `a: |\n  x` with no final source newline at all
    // (the block is the last thing in the document) clips to "x", not
    // "x\n". Stripping trailing newlines FIRST, then testing for emptiness,
    // covers both "no content lines at all" (`a: |` with a sibling key right
    // after — collected.length === 0, literal === "" already) and "content
    // lines that are all blank" (`a: |\n\n` — collected.length === 1 but the
    // one collected line is "", so literal is "\n" going in, not ""): both
    // clip to "", verified against yaml.safe_load(\"a: |\\n\\n\") ->
    // {'a': ''}, not {'a': '\\n'}. The second case was missed on the first
    // pass, which only tested `literal === ""` directly and let a blank-only
    // scalar's newline survive the clip.
    const stripped = literal.replace(/\n*$/, "");
    if (stripped === "") return "";
    return stripped + (sourceEndsWithNewline ? "\n" : "");
  }

  function parseNode(indent) {
    const line = peek();
    if (!line) return null;
    if (line.indent < indent) return null;

    if (line.content.startsWith("- ") || line.content === "-") {
      return parseSequence(line.indent);
    }
    return parseMapping(line.indent);
  }

  function parseSequence(indent) {
    const result = [];
    while (peek() && peek().indent === indent && (peek().content.startsWith("- ") || peek().content === "-")) {
      const line = structural[pos];
      const rest = line.content === "-" ? "" : line.content.slice(2);
      pos++;
      if (rest.trim() === "") {
        const next = peek();
        result.push(next && next.indent > indent ? parseNode(next.indent) : null);
      } else if (/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9_.\-]+):( |$)/.test(rest)) {
        // "- key: value" — an inline mapping item. Its siblings (if any)
        // are indented past the dash itself, i.e. past where `rest` starts.
        const siblingIndent = indent + (line.content.length - rest.length);
        result.push(parseInlineMappingItem(rest, siblingIndent, line.rawIndex));
      } else {
        result.push(parseScalar(rest));
      }
    }
    return result;
  }

  // Verified against yaml.safe_load("a: 1\na: 2\n"), which raises a
  // ConstructorError under a duplicate-key-rejecting loader (PyYAML's
  // default SafeLoader is lenient and keeps the last value, but rejecting
  // is the spec-correct, commonly-enforced reading) — silently keeping the
  // last value here would hide a workflow author's copy-paste mistake
  // (two "permissions:" blocks, the second one clobbering the first)
  // rather than surfacing it.
  function checkDuplicateKey(target, key, lineNumber) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      throw new Error(`yaml-lite: duplicate mapping key ${JSON.stringify(key)} at line ${lineNumber}`);
    }
  }

  function parseInlineMappingItem(firstLineRest, siblingIndent, firstLineRawIndex) {
    const obj = {};
    applyMappingEntry(obj, firstLineRest, siblingIndent, firstLineRawIndex);
    while (peek() && peek().indent === siblingIndent) {
      const line = structural[pos];
      pos++;
      applyMappingEntry(obj, line.content, siblingIndent, line.rawIndex);
    }
    return obj;

    function applyMappingEntry(target, content, ownIndent, rawIndex) {
      const { key, rest, isBlockScalar, style, chomp } = splitKeyValue(content);
      checkDuplicateKey(target, key, rawLines[rawIndex].n);
      if (isBlockScalar) {
        target[key] = parseBlockScalar(style, chomp, ownIndent, rawIndex + 1);
      } else if (rest === "") {
        const next = peek();
        target[key] = next && next.indent > ownIndent ? parseNode(next.indent) : null;
      } else {
        target[key] = parseScalar(rest);
      }
    }
  }

  function splitKeyValue(content) {
    const m = content.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:]+?):(?:\s(.*))?$/);
    if (!m) throw new Error(`yaml-lite: could not parse mapping entry: ${JSON.stringify(content)}`);
    let key = m[1].trim();
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = parseScalar(key);
    }
    const rest = (m[2] ?? "").trim();
    const blockMatch = rest.match(/^([|>])([+-]?)$/);
    if (blockMatch) {
      return { key, rest: "", isBlockScalar: true, style: blockMatch[1], chomp: blockMatch[2] };
    }
    return { key, rest, isBlockScalar: false };
  }

  function parseMapping(indent) {
    const obj = {};
    while (peek() && peek().indent === indent) {
      const line = structural[pos];
      pos++;
      const { key, rest, isBlockScalar, style, chomp } = splitKeyValue(line.content);
      checkDuplicateKey(obj, key, line.n);
      if (isBlockScalar) {
        obj[key] = parseBlockScalar(style, chomp, indent, line.rawIndex + 1);
      } else if (rest === "") {
        const next = peek();
        obj[key] = next && next.indent > indent ? parseNode(next.indent) : null;
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  if (structural.length === 0) return {};
  const doc = parseNode(structural[0].indent);
  if (pos < structural.length) {
    throw new Error(
      `yaml-lite: stopped parsing at line ${structural[pos].n} — unsupported construct or indentation this parser doesn't handle`,
    );
  }
  return doc;
}

module.exports = { parseWorkflowYaml };
