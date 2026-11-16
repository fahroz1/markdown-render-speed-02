[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/fahroz1/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/fahroz1/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A dependency-free drop-in for marked 18.1.3 (default options: GFM on,
breaks off, pedantic off, async off). `parse(markdown)` returns the HTML
`marked.parse(markdown)` returns, byte for byte, and `main.ts` renders
every case in `/input/cases.json` to `/output/html.json`.

## Design

Hand-written from the CommonMark 0.31.2 + GFM 0.29 rules as marked 18.1.3
implements them (including marked's delimiter-run emphasis algorithm, its
link-reference handling, its `isLabelEndInsideToken` label check, and its
blockquote frame rule). It renders directly to HTML — no token objects,
no intermediate tree — with hot paths using `indexOf`-style scanning and
precompiled regexes.

## Status (practice set, 2026-11-17 ~02:55 WIB)

714/720 cases byte-identical to the kit's reference (all 680 spec/GFM
examples now pass, including cm-238; 34 of 40 generated READMEs pass).
The 6 remaining failures are all in the generated docs:

- cm-238 FIXED this session: a blockquote lazy line with 4+ leading
  spaces loses exactly 4 of them, but only at the paragraph-text level
  (after the paragraph is formed) — dedenting in the block content
  wrongly turns it into a list item. Lines with 0–3 leading spaces are
  kept as-is. Implemented via a per-blockquote lazy-line set
  (`BQ_LAZY`) applied in `parseBlocksSeg`'s paragraph/text branches.
- doc-03, doc-06, doc-35 — NOT fixed: a bare `www.`/`https://` URL
  that mine autolinks but marked does not. It matches in isolation, so
  the cause is persistent document-wide `IN_LINK` state (an unclosed
  literal `<a>` earlier in the document). Root cause found: `parseList`
  tokenizes ALL items first, then renders text segments deferred — so
  a `</a>` in a later item closes a `<a>` before an earlier item's
  text is rendered. A per-item state capture fixed the target URL but
  over-corrected (suppressed URLs marked DOES autolink after the
  `</a>`), so it was reverted. Speculative parses (`parseBlockquote`
  frame check, task-list checkbox re-parse) now save/restore
  `IN_LINK`/`IN_RAW_BLOCK` so they cannot leak state, but the
  deferred-render ordering issue remains.
- doc-07 — NOT fixed: nested link whose label holds an inner link plus
  an unmatched backtick (`` ` ``). Matches in isolation; differs only
  in full-document context (same persistent-state family).
- doc-13, doc-23 — NOT fixed, pre-scan regressions: the cheap
  definition pre-scan collects link-reference definitions that sit
  inside fenced code blocks (a fence opened inside a list item whose
  content line at indent 0 ends the item, cutting the fence off so a
  later fence line opens a NEW unclosed block to end-of-document).
  The pre-scan does not track list-item boundaries, so it closes the
  fence and treats the defs as top-level. The exact list/fence
  interaction was bisected but not robustly fixed.

Speed: the two-pass block lex was replaced this session with a cheap
line-based definition pre-scan (`collectDefs`, with blockquote-scoped
fence tracking). On the 40 large READMEs this build is now ~1.07–1.23x
*slower* than marked across three runs (docs: 1.158x, 1.124x, 1.219x;
all 720: 1.227x, 1.174x, 1.075x; spec: ~1.11–1.18x), i.e. the pre-scan
removed most of the old 1.3–1.7x slowdown but the entry still does NOT
beat marked. It therefore does not yet pass all 720 cases AND does not
yet beat marked, so it would not take a paid place as-is — the honest
next steps are (a) the remaining lexer-state edge cases above,
(b) list-aware fence tracking in the pre-scan, and (c) further
single-pass optimisation to get clearly below 1.0x vs marked.

## Files

- `parse.js` — the parser (`export function parse(markdown)`).
- `main.ts` — the driver the harness runs (`node /bot/main.ts`).
- `LICENSE` — MIT.

## Local test

```sh
MAKEFUN_INPUT_DIR=../markdown-render-speed-02-kit/markdown-render-speed-02-kit/practice/input \
MAKEFUN_OUTPUT_DIR=/tmp/mrs-out \
node main.ts
```

Then diff `/tmp/mrs-out/html.json` against the kit's
`practice/reference/expected.json`.
