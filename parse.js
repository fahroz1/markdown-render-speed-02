// parse.js — a fast, dependency-free drop-in for marked 18.1.3 (default options:
// GFM on, breaks off, pedantic off, async off). Hand-written from the CommonMark
// 0.31.2 + GFM 0.29 rules as marked implements them; renders directly to HTML
// (no token objects) for speed. Byte-identical output is the goal.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_TEST = /[&<>"']/;
const ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

function escHtml(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_RE, c => ESC[c]);
  } else if (ESC_TEST_NO_ENCODE.test(s)) {
    return s.replace(ESC_NO_ENCODE_RE, c => ESC[c]);
  }
  return s;
}

const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!NUM_REF_RE.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP_RE, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

// marked's isLabelEndInsideToken: a link is not formed when the ']' that
// ends its label sits inside an HTML tag, an autolink, or a code span that
// starts inside the label (the token would swallow the closing bracket).
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = RE_CODE.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = RE_TAG.exec(tokenSrc) || RE_AUTOLINK.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Split a table row into cells (GFM). Escaped pipes stay literal.
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
function splitCells(row, count) {
  const r = row.replace(FIND_PIPE, (m, offset, str) => {
    let escaped = false;
    let cur = offset;
    while (--cur >= 0 && str[cur] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = r.split(SPLIT_PIPE);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ---- shared state for one parse() call ----
let LINKS; // object: normalized label -> { href, title }

let SKIP_INLINE = false;
// marked's lexer state, persistent across the whole parse (not per paragraph):
// IN_LINK is set by a literal <a> tag (until </a>) and while rendering a
// link's label; it suppresses the gfm extended autolink. IN_RAW_BLOCK is set
// by <pre>/<code>/<kbd>/<script> (until the matching close tag) and makes
// inline text pass through unescaped.
let IN_LINK = false;
let IN_RAW_BLOCK = false;
// Lazy lines of the blockquote currently being parsed: a lazy line with 4+
// leading spaces loses exactly 4 of them, but ONLY at the paragraph-text
// level (after the paragraph is formed). Dedenting it in the block content
// would wrongly turn it into a list item (a list can interrupt a paragraph).
// Lines with 0-3 leading spaces are kept as-is. The set holds the exact
// line texts (no trailing newline); null outside a blockquote.
let BQ_LAZY = null;
function dedentLazyText(text) {
  if (!BQ_LAZY || BQ_LAZY.size === 0 || text.indexOf('\n') === -1 && !BQ_LAZY.has(text)) return text;
  const lines = text.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (BQ_LAZY.has(ln) && ln.charAt(0) === ' ' && ln.charAt(1) === ' ' && ln.charAt(2) === ' ' && ln.charAt(3) === ' ') {
      lines[i] = ln.slice(4);
      changed = true;
    }
  }
  return changed ? lines.join('\n') : text;
}
export function parse(markdown) {
  LINKS = Object.create(null);
  IN_LINK = false;
  IN_RAW_BLOCK = false;
  let src = String(markdown).replace(/\r\n|\r/g, '\n');
  // Cheap pre-scan: collect every link reference definition in one fast
  // line pass (a reference may be used before the definition that defines
  // it). Replaces the old two-pass block lex, which parsed every case twice.
  collectDefs(src);
  const html = parseBlocks(src, true);
  LINKS = null;
  return html;
}

// ---- inline grammar (GFM, the default) ----
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_CHAR = /^((?![*_])[\s\p{P}\p{S}])/u; // whitespace or punctuation, excl * _
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu; // backslash + punctuation -> punctuation
function unescapePunct(s) { return s.replace(ANY_PUNCT_RE, '$1'); }
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM: ~ is not punctuation for strong/em flanking
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;
const ALPHA_NUM = /[\p{L}\p{N}]/u;

const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;

const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const RE_TAG = new RegExp(
  '^' + _comment.source.replace('(?:-->|$)', '-->')
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
);

// link label: brackets nest to 2 levels, code spans and escapes allowed
const LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_INNER = '(?:\\[(?:' + LABEL_BRACKETS.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const RE_LINK = new RegExp('^!?\\[(' + LABEL_INNER + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
const BLOCK_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const RE_REFLINK = new RegExp('^!?\\[(' + LABEL_INNER + ')\\]\\[(' + BLOCK_LABEL + ')\\]');
const RE_NOLINK = new RegExp('^!?\\[(' + BLOCK_LABEL + ')\\](?:\\[\\])?');

// GFM extended autolink
const RE_URL = /^(?:(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// emStrong delimiters (GFM)
const EM_L_DELIM = new RegExp('^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?', 'u');
const EM_R_AST = new RegExp(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])'
  + '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)'
  + '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)'
  + '|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))'
  + '|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])'
  + '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])'
  + '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))', 'gu');
const EM_R_UND = new RegExp(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])'
  + '|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)'
  + '|[\\s\\p{P}\\p{S}][^](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)'.replace('[\\s\\p{P}\\p{S}][^]', '[^\\s\\p{P}\\p{S}]')
  + '|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])'
  + '|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])'
  + '|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])', 'gu');

// strikethrough delimiters
const DEL_L_DELIM = new RegExp(/^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/.source, 'u');
const DEL_R_DELIM = new RegExp(
  '^[^~]+(?=[^~])'
  + '|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)'
  + '|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)'
  + '|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])'
  + '|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])'
  + '|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])'
  + '|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])', 'gu');

// text: stop before a special char; GFM also stops before www./protocol/email
const RE_INLINE_TEXT = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;

// masking helpers (for emStrong/del): hide links, code, html, escapes
const RE_BLOCK_SKIP = /(?:\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\))|(?:(?<!`)()(?<b>`+)[^`]+\k<b>(?!`))|(?:<(?! )[^<>]*?>)/g;
const RE_ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_REFLINK_SEARCH = new RegExp(
  '!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:' + LABEL_BRACKETS.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]'
  + '|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()', 'g');

function linkInText(text) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(RE_BLOCK_SKIP)) {
    if (RE_LINK.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  for (const m of text.matchAll(RE_REFLINK_SEARCH)) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!') continue;
    // the reference to look up: for [label][ref] it is ref; for a collapsed
    // [label][] or a shortcut [label] it is the label itself.
    let lookup;
    if (refStart === 0) lookup = m0.slice(1, -1);
    else {
      const ref = m0.slice(refStart + 1, -1);
      lookup = ref ? ref : m0.slice(1, refStart - 1);
    }
    if (!Object.hasOwn(LINKS, normalizeLabel(lookup))) continue;
    if (refStart > 1 && linkInText(m0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

function maskSrc(src) {
  let masked = src;
  if (LINKS && src.includes('[')) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(LINKS, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(text)) {
          return '[' + text.replace(RE_REFLINK_SEARCH, maskReflink)
            + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(RE_REFLINK_SEARCH, maskReflink);
  }
  masked = masked.replace(RE_ANY_PUNCT_OUTSIDE_CODE, (m0, code, punct) => {
    if (punct) return '+'.repeat(m0.length);
    if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m0;
  });
  masked = masked.replace(RE_BLOCK_SKIP, (m0, _link, context) => {
    const offset = context ? context.length : 0;
    return m0.slice(0, offset) + '[' + 'a'.repeat(m0.length - offset - 2) + ']';
  });
  return masked;
}

// last index of a run that can close em/strong/del in maskedSrc
function lastCloser(masked, delim) {
  let lastEm = -1, lastDel = -1;
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else if (ch === delim) lastEm = i;
    }
    i = j - 1;
  }
  return delim === '~' ? lastDel : lastEm;
}

// Render inline content to plain text (for image alt attributes): emphasis,
// links, code spans etc. contribute only their text, no HTML tags.
function plainInline(src) {
  // strip emphasis/strong/del markers, code backticks, links -> their text
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/.test(src[i + 1])) {
      out += src[i + 1]; i += 2; continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < src.length && src[j] === '`') j++;
      const run = src.slice(i, j);
      const close = src.indexOf(run, j);
      if (close !== -1) {
        let t = src.slice(j, close).replace(/\n/g, ' ');
        if (/[^ ]/.test(t) && /^ /.test(t) && / $/.test(t)) t = t.substring(1, t.length - 1);
        out += t; i = close + run.length; continue;
      }
      out += ch; i++; continue;
    }
    if (ch === '<') {
      const tagM = /^<[a-zA-Z][^>]*>|^<\/[^>]*>|^<!--(?:-?>|[\s\S]*?(?:-->|$))/.exec(src.slice(i));
      if (tagM) { i += tagM[0].length; continue; }
      out += ch; i++; continue;
    }
    out += ch; i++;
  }
  // resolve links/images to their label text
  out = out.replace(/!?\[([^\[\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/g, '$1');
  out = out.replace(/\*\*([^*]*)\*\*|\*([^*]*)\*|__([^_]*)__|_([^_]*)_|~~([^~]*)~~/g, (_, a, b, c, d, e) => a ?? b ?? c ?? d ?? e ?? '');
  return decodeNumericRefs(out);
}

// ---- inline renderer: src -> HTML ----
function inlineHtml(src, inRawBlock, inLink) {
  if (SKIP_INLINE) return '';
  // A link label forces IN_LINK for its duration (marked's outputLink);
  // the outer state is restored afterwards. A literal <a> tag instead sets
  // the persistent lexer state until </a>.
  const isLabel = inLink === true;
  const savedLink = IN_LINK;
  const savedRaw = IN_RAW_BLOCK;
  if (isLabel) IN_LINK = true;
  const masked = (src.includes('*') || src.includes('_') || src.includes('~')) ? maskSrc(src) : src;
  let out = '';
  let prevChar = '';
  let keepPrev = false;
  let rest = src;
  let mRest = masked;
  while (rest) {
    if (!keepPrev) prevChar = '';
    keepPrev = false;
    let m;

    // escape
    if ((m = RE_ESCAPE.exec(rest))) {
      out += escHtml(m[1], false);
      rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
      continue;
    }
    // tag (raw html)
    if ((m = RE_TAG.exec(rest))) {
      out += m[0];
      if (!IN_LINK && /^<a /i.test(m[0])) IN_LINK = true;
      else if (IN_LINK && /^<\/a>/i.test(m[0])) IN_LINK = false;
      if (!IN_RAW_BLOCK && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) IN_RAW_BLOCK = true;
      else if (IN_RAW_BLOCK && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) IN_RAW_BLOCK = false;
      rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
      continue;
    }
    // link / image
    if ((m = RE_LINK.exec(rest))) {
      const isImg = m[0][0] === '!';
      const label = m[1];
      if (isLabelEndInsideToken(rest, label, isImg ? 2 : 1)) {
        // the ']' ending the label is inside a tag/autolink/code span:
        // not a link; fall through to the following tokenizers
      } else {
      let href = m[2] || '';
      let title = m[3];
      // marked's link() validation: an angle-bracketed destination must end
      // with an unescaped '>'; an unquoted one must balance parentheses and
      // its closing ')' must not be escaped.
      let valid = true;
      if (href.trim()[0] === '<') {
        const t = href.trim();
        if (!t.endsWith('>')) valid = false;
        else {
          const noSlash = rtrim(t.slice(0, -1), '\\');
          if ((t.length - noSlash.length) % 2 === 0) valid = false;
        }
      } else {
        const lastParen = findClosingBracket(href, '()');
        if (lastParen === -2) valid = false;
        else {
          if (lastParen > -1) {
            const start = isImg ? 5 : 4;
            const linkLen = start + label.length + lastParen;
            href = href.substring(0, lastParen);
            m[2] = href;
            m[0] = m[0].substring(0, linkLen).trim();
            m[3] = '';
            title = '';
          }
          const unesc = rtrim(m[0].slice(0, -1), '\\');
          if ((m[0].length - unesc.length) % 2 === 0) valid = false;
        }
      }
      if (valid) {
        if (href[0] === '<') href = href.slice(1, -1);
        href = unescapePunct(href.trim());
        const clean = cleanUrl(href);
        const labelText = label.replace(/\\([\[\]])/g, '$1');
        // Links may not contain other links: if the label holds one, the outer
        // link is not created and the '[' is left as text.
        if (!isImg && linkInText(labelText)) {
          // do not consume: fall through to the following tokenizers in this pass
        } else {
          if (clean !== null) {
            const inner = isImg ? plainInline(labelText) : inlineHtml(decodeNumericRefs(labelText), false, true);
            const t = title ? ' title="' + escHtml(unescapePunct(title.slice(1, -1)), false) + '"' : '';
            if (isImg) out += '<img src="' + escHtml(clean, false) + '" alt="' + escHtml(inner, false) + '"' + t + '>';
            else out += '<a href="' + escHtml(clean, false) + '"' + t + '>' + inner + '</a>';
          } else {
            // cleanUrl null: link consumed, only its inner text is rendered
            out += isImg ? escHtml(plainInline(labelText), false) : inlineHtml(decodeNumericRefs(labelText), false, true);
          }
          rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
          continue;
        }
      }
      // not a valid link: fall through to the following tokenizers
      }
    }
    // reflink / nolink
    if ((m = RE_REFLINK.exec(rest)) || (m = RE_NOLINK.exec(rest))) {
      const isImg = m[0][0] === '!';
      const label = m[1];
      if (isLabelEndInsideToken(rest, label, isImg ? 2 : 1)) {
        // label's ']' is inside a tag/autolink/code span: not a reflink;
        // only the first character becomes literal text
        const lit = m[0].charAt(0);
        out += escHtml(decodeNumericRefs(lit), false);
        rest = rest.slice(1); mRest = mRest.slice(1);
        continue;
      }
      const ref = m[2] !== undefined ? m[2] : m[1];
      const link = LINKS[normalizeLabel(ref)];
      if (link) {
        const clean = cleanUrl(link.href);
        const labelText = label.replace(/\\([\[\]])/g, '$1');
        if (!isImg && linkInText(labelText)) {
          // label holds a link: outer link not created; '[' stays as text
          const lit = m[0].charAt(0);
          out += escHtml(decodeNumericRefs(lit), false);
          rest = rest.slice(1); mRest = mRest.slice(1);
          continue;
        }
        if (clean !== null) {
          const inner = isImg ? plainInline(labelText) : inlineHtml(decodeNumericRefs(labelText), false, true);
          const t = link.title ? ' title="' + escHtml(link.title, false) + '"' : '';
          if (isImg) out += '<img src="' + escHtml(clean, false) + '" alt="' + escHtml(inner, false) + '"' + t + '>';
          else out += '<a href="' + escHtml(clean, false) + '"' + t + '>' + inner + '</a>';
        } else {
          out += isImg ? escHtml(plainInline(labelText), false) : inlineHtml(decodeNumericRefs(labelText), false, true);
        }
        rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
        continue;
      }
      // not a link: only the first character becomes literal text
      const lit = m[0].charAt(0);
      out += escHtml(decodeNumericRefs(lit), false);
      rest = rest.slice(1); mRest = mRest.slice(1);
      continue;
    }
    // em & strong
    {
      const r = emStrong(rest, mRest, prevChar);
      if (r) {
        out += r.html;
        rest = rest.slice(r.raw.length); mRest = mRest.slice(r.raw.length);
        continue;
      }
    }
    // codespan
    if ((m = RE_CODE.exec(rest))) {
      let text = m[2].replace(/\n/g, ' ');
      const hasNonSpace = /[^ ]/.test(text);
      const spaceBoth = /^ /.test(text) && / $/.test(text);
      if (hasNonSpace && spaceBoth) text = text.substring(1, text.length - 1);
      out += '<code>' + escHtml(text, true) + '</code>';
      rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
      continue;
    }
    // br
    if ((m = RE_BR.exec(rest))) {
      out += '<br>';
      rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
      continue;
    }
    // del
    {
      const r = delParse(rest, mRest, prevChar);
      if (r) {
        out += r.html;
        rest = rest.slice(r.raw.length); mRest = mRest.slice(r.raw.length);
        continue;
      }
    }
    // autolink
    if ((m = RE_AUTOLINK.exec(rest))) {
      let text, href;
      if (m[1].includes('@') && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(m[1])) {
        text = m[1]; href = 'mailto:' + text;
      } else {
        text = m[1]; href = text;
      }
      out += '<a href="' + escHtml(cleanUrl(href) ?? href, false) + '">' + escHtml(text, false) + '</a>';
      rest = rest.slice(m[0].length); mRest = mRest.slice(m[0].length);
      continue;
    }
    // url (gfm extended autolink) -- not inside a link
    if (!IN_LINK && (m = RE_URL.exec(rest))) {
      let text, href;
      if (m[0].includes('@') && !/^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//.test(m[0]) && !/^www\./i.test(m[0])) {
        // email (possibly with mailto:/xmpp: prefix)
        text = m[0];
        href = /^(?:mailto|xmpp):/i.test(text) ? text : 'mailto:' + text;
      } else {
        let cap0 = m[0];
        let prev;
        do {
          prev = cap0;
          cap0 = RE_BACKPEDAL.exec(cap0)?.[0] ?? '';
        } while (prev !== cap0);
        text = cap0;
        href = /^www\./i.test(cap0) ? 'http://' + cap0 : cap0;
      }
      out += '<a href="' + escHtml(cleanUrl(href) ?? href, false) + '">' + escHtml(text, false) + '</a>';
      // consume only the backpedalled length; trimmed punctuation stays as text
      rest = rest.slice(text.length); mRest = mRest.slice(text.length);
      continue;
    }
    // text
    if ((m = RE_INLINE_TEXT.exec(rest))) {
      const raw = m[0];
      out += IN_RAW_BLOCK ? raw : escHtml(decodeNumericRefs(raw), false);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrev = true;
      rest = rest.slice(raw.length); mRest = mRest.slice(raw.length);
      continue;
    }
    // should not happen; consume one char to avoid infinite loop
    out += escHtml(rest[0], false);
    rest = rest.slice(1); mRest = mRest.slice(1);
  }
  if (isLabel) {
    // restore the outer lexer state (a </a> inside the label does not leak)
    IN_LINK = savedLink;
    IN_RAW_BLOCK = savedRaw;
  }
  return out;
}

// emphasis / strong, following marked's delimiter-run algorithm
function emStrong(src, maskedSrc, prevChar) {
  const m = EM_L_DELIM.exec(src);
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delimChar = m[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!PUNCT_CHAR.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!PUNCT_CHAR.exec(prevChar);
  if (m[4] && ALPHA_NUM.test(prevChar)) return null;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...m[0]].length - 1;
    let delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? EM_R_AST : EM_R_UND;
    const lastCloserIdx = lastCloser(maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastCloserIdx < windowStart) return null;
    const win = maskedSrc.slice(-src.length + lLength);
    const lastInWindow = lastCloserIdx - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(win)) !== null) {
      if (match.index > lastInWindow) break;
      const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      const rLength = [...rDelim].length;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLen = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLen);
      if (Math.min(lLength, rLen) % 2) {
        const text = raw.slice(1, -1);
        return { raw, html: '<em>' + inlineHtml(text, false) + '</em>' };
      }
      const text = raw.slice(2, -2);
      return { raw, html: '<strong>' + inlineHtml(text, false) + '</strong>' };
    }
  }
  return null;
}

// strikethrough (GFM)
function delParse(src, maskedSrc, prevChar) {
  const m = DEL_L_DELIM.exec(src);
  if (!m) return null;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || PUNCT_CHAR.exec(prevChar)) {
    const lLength = [...m[0]].length - 1;
    let delimTotal = lLength;
    const lastCloserIdx = lastCloser(maskedSrc, '~');
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastCloserIdx < windowStart) return null;
    const win = maskedSrc.slice(-src.length + lLength);
    const lastInWindow = lastCloserIdx - windowStart;
    DEL_R_DELIM.lastIndex = 0;
    let match;
    while ((match = DEL_R_DELIM.exec(win)) !== null) {
      if (match.index > lastInWindow) break;
      const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      const rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLen = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLen);
      const text = raw.slice(lLength, -lLength);
      return { raw, html: '<del>' + inlineHtml(text, false) + '</del>' };
    }
  }
  return null;
}

// ---- block grammar (GFM) ----
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const RE_LIST_START = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;

const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const RE_HTML_BLOCK = new RegExp(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(?:' + TAG_LIST + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i');

const BLOCK_LABEL_INNER = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const RE_DEF = new RegExp('^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)'.replace('label', BLOCK_LABEL_INNER).replace('title', '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))'));

// ---- cheap link-reference definition pre-scan ----
// Collects every link reference definition in one fast line pass, so a
// reference may be used before its definition without lexing every block
// twice. Handles top-level defs, defs inside blockquotes ('> ' markers
// stripped) and defs indented up to 3 spaces (e.g. inside list items, whose
// content indent RE_DEF already allows). Skips fenced code blocks and
// enforces "a definition cannot interrupt a paragraph" via the inPara state.
// A def's lines are still consumed by the real block parse; this only
// populates LINKS early (first definition wins, as in the block parse).
const RE_DEF_STICKY = new RegExp(RE_DEF.source, 'ym');
const BQ_MARKER = /^( {0,3})>([ \t]?)/;
// Fences may sit inside list items, so their raw indent can exceed 3 spaces;
// detect them on the whitespace-stripped line (an indented-code line that
// starts with a fence run is vanishingly rare in practice, and a missed
// fence would wrongly collect definitions from code).
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const IS_BLANK = /^[ \t]*$/;
const IS_ATX = /^ {0,3}#{1,6}(?:\s|$)/;
const IS_LIST = /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;
const IS_HTML_START = /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>|$)|^ {0,3}(?:<!--|<\?|<![A-Za-z]|<!\[CDATA\[)/i;
const IS_TABLE_DELIM = /^ {0,3}\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const IS_SETEXT_EQ = /^ {0,3}=+[ \t]*$/;
const IS_SETEXT_DASH = /^ {0,3}-+[ \t]*$/;
const IS_HR = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/;
const IS_INDENTED_CODE = /^(?: {4}|\t)/;
// A line starts a block (so a definition on the next line is not a
// paragraph continuation) when it is a heading, list, html block, table
// delimiter, hr, indented code, or a setext underline following a paragraph.
function isBlockStart(line, inPara) {
  if (IS_ATX.test(line) || IS_LIST.test(line) || IS_HTML_START.test(line)
    || IS_TABLE_DELIM.test(line) || IS_HR.test(line) || IS_INDENTED_CODE.test(line)) return true;
  if (IS_SETEXT_DASH.test(line)) return true; // setext underline or hr: boundary either way
  if (IS_SETEXT_EQ.test(line)) return inPara; // '===' is a setext underline only after a paragraph
  return false;
}

function collectDefs(src) {
  // Strip blockquote markers (possibly nested) and expand tabs, line by line.
  // hadBq[i] records whether the line carried a '>' marker: a fence opened
  // on such a line is scoped to that blockquote and cannot extend past it.
  const rawLines = src.split('\n');
  const lines = new Array(rawLines.length);
  const hadBq = new Array(rawLines.length);
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    let m;
    let bq = false;
    while ((m = BQ_MARKER.exec(line))) { line = line.slice(m[0].length); bq = true; }
    if (line.indexOf('\t') !== -1) line = expandTabs(line);
    lines[i] = line;
    hadBq[i] = bq;
  }
  const clean = lines.join('\n');
  const offsets = new Array(lines.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < lines.length; i++) offsets[i + 1] = offsets[i] + lines[i].length + 1;
  let inFence = null; // {ch, len, bq}
  let inPara = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (IS_BLANK.test(line)) { inPara = false; continue; }
    // Fenced code blocks: a closing fence is only fence markers plus
    // trailing whitespace (a line like ```inner``` is fence *content*,
    // not a closer); a backtick opener's info string holds no backtick.
    // Fences are detected on the whitespace-stripped line so fences inside
    // list items (indented past 3 spaces) are still recognised.
    // A fence opened inside a blockquote ends with that blockquote: a
    // line with no '>' marker (blank lines included) closes it, because
    // a code block cannot take lazy continuation lines.
    const stripped = line.replace(/^[ \t]+/, '');
    const fenceCloseM = FENCE_CLOSE.exec(stripped);
    if (inFence) {
      if (inFence.bq && !hadBq[i]) {
        // The blockquote ended on this line, so its fence ends too; the
        // line itself is ordinary content -- fall through and process it.
        inFence = null;
      } else if (fenceCloseM && fenceCloseM[1][0] === inFence.ch && fenceCloseM[1].length >= inFence.len) {
        inFence = null;
        continue; // this line is the closing fence; skip it
      } else {
        continue; // still inside the fence
      }
    }
    const fenceOpenM = FENCE_OPEN.exec(stripped);
    if (fenceOpenM && (fenceOpenM[1][0] === '~' || stripped.indexOf('`', fenceOpenM[0].length) === -1)) {
      inFence = { ch: fenceOpenM[1][0], len: fenceOpenM[1].length, bq: hadBq[i] };
      inPara = false;
      continue;
    }
    if (!inPara) {
      const lead = line.search(/[^ ]/);
      if (lead !== -1 && lead <= 3 && line[lead] === '[') {
        RE_DEF_STICKY.lastIndex = offsets[i];
        const m = RE_DEF_STICKY.exec(clean);
        if (m && !(m[2] && !/^</.test(m[2]) && findClosingBracket(m[2], '()') !== -1)) {
          const tag = normalizeLabel(m[1]);
          let href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : '';
          const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : m[3];
          if (!LINKS[tag]) LINKS[tag] = { href, title };
          // Skip the lines this (possibly multi-line) definition consumed.
          const body = m[0].replace(/\n+$/, '');
          i += (body.match(/\n/g) || []).length;
          inPara = false;
          continue;
        }
      }
    }
    inPara = !isBlockStart(line, inPara);
  }
}

const RE_TABLE = new RegExp(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:</?(?:' + TAG_LIST + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)');

function lheadingRegex() {
  const core = '^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
  return new RegExp(core
    .replace(/bull/g, ' {0,3}(?:[*+-]|\\d{1,9}[.)])')
    .replace(/blockCode/g, '(?: {4}| {0,3}\\t)')
    .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
    .replace(/blockquote/g, ' {0,3}>')
    .replace(/heading/g, ' {0,3}#{1,6}(?:\\s|$)')
    .replace(/hr/g, ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
    .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
    .replace(/table/g, ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'));
}
const RE_LHEADING = lheadingRegex();

function paragraphRegex(listInterrupt) {
  const core = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
  return new RegExp(core
    .replace('hr', ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)')
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('table', '[^\\n]+\\n {0,3}(?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?(?:\\n|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:' + TAG_LIST + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'));
}
const RE_PARAGRAPH = paragraphRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const RE_PARAGRAPH_BQ = paragraphRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)');
const RE_BLOCKQUOTE = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + RE_PARAGRAPH_BQ.source.slice(1) + ')|[^\\n]*)(?:\\n|$))+');
const RE_TEXT = /^[^\n]+/;

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (!m) return text;
  const indentToCode = m[1];
  return text.split('\n').map(node => {
    const mm = node.match(/^\s+/);
    if (!mm) return node;
    return node.slice(Math.min(mm[0].length, indentToCode.length));
  }).join('\n');
}

// ---- block parser: src -> HTML. `top` false inside list items (no <p> for plain text). ----
// Segments: {t: true} = plain text block (inline HTML, no <p>); {t: false} = full block HTML.
// `top` false inside list items (paragraphs become plain text blocks).
function parseBlocksSeg(src, top = true) {
  const segs = [];
  let guard = Infinity;
  let textBreak = false; // a blank line separates text blocks: do not merge across it
  while (src) {
    if (src.length < guard) guard = src.length;
    else break;
    let m;

    if ((m = RE_NEWLINE.exec(src))) {
      // a single \n folds into the previous block; a longer run is a blank
      // line and breaks text merging. A blank line between two top-level
      // blocks is what makes a list loose (marked's space-token rule); blank
      // lines inside a nested list do not count, so this is tracked here
      // where only top-level segments are visible.
      if (m[0].length > 1) {
        textBreak = true;
        src = src.slice(m[0].length);
        if (segs.length > 0 && /\S/.test(src)) segs.blankBetween = true;
        continue;
      }
      src = src.slice(m[0].length);
      continue;
    }
    if ((m = RE_BLOCK_CODE.exec(src))) {
      const rawFull = m[0];
      const raw = trimTrailingBlankLines(rawFull);
      const text = raw.replace(/^(?: {0,3}\t| {1,4})/gm, '');
      src = src.slice(rawFull.length);
      const last = segs[segs.length - 1];
      if (last && last.t && !textBreak) {
        // an indented code block cannot interrupt a paragraph: its dedented
        // text joins the paragraph
        last.raw += '\n' + text;
        textBreak = false;
      } else {
        segs.push({ t: false, html: renderCode(text, '') });
      }
      continue;
    }
    if ((m = RE_FENCES.exec(src))) {
      const raw = m[0];
      const text = indentCodeCompensation(raw, m[3] || '');
      const lang = m[2] ? m[2].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : m[2];
      src = src.slice(raw.length);
      segs.push({ t: false, html: renderCode(text, lang) });
      continue;
    }
    if ((m = RE_HEADING.exec(src))) {
      let text = m[2].trim();
      if (/#$/.test(text)) {
        const trimmed = rtrim(text, '#');
        if (!trimmed || /[ \t]$/.test(trimmed)) text = trimmed.trim();
      }
      const depth = m[1].length;
      src = src.slice(rtrim(m[0], '\n').length);
      segs.push({ t: false, html: '<h' + depth + '>' + inlineHtml(text, false) + '</h' + depth + '>\n' });
      continue;
    }
    if ((m = RE_HR.exec(src))) {
      src = src.slice(rtrim(m[0], '\n').length);
      segs.push({ t: false, html: '<hr>\n' });
      continue;
    }
    if ((m = RE_BLOCKQUOTE.exec(src))) {
      const raw = m[0];
      const r = parseBlockquote(raw);
      src = src.slice(r.consumed);
      segs.push({ t: false, html: r.html });
      continue;
    }
    {
      const r = parseList(src);
      if (r) {
        src = src.slice(r.raw.length);
        segs.push({ t: false, html: r.html });
        continue;
      }
    }
    if ((m = RE_HTML_BLOCK.exec(src))) {
      const raw = trimTrailingBlankLines(m[0]);
      src = src.slice(m[0].length);
      segs.push({ t: false, html: raw });
      continue;
    }
    if ((m = RE_DEF.exec(src))) {
      const raw = rtrim(m[0], '\n');
      src = src.slice(m[0].length);
      const lastSeg = segs[segs.length - 1];
      if (lastSeg && lastSeg.t && !textBreak) {
        // a definition cannot interrupt a paragraph: it stays literal text
        lastSeg.raw += '\n' + raw;
        textBreak = false;
        continue;
      }
      if (m[2] && !/^</.test(m[2]) && findClosingBracket(m[2], '()') !== -1) {
        src = raw + src;
      } else {
        const tag = normalizeLabel(m[1]);
        let href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : m[3];
        if (!LINKS[tag]) LINKS[tag] = { href, title };
        continue;
      }
    }
    if ((m = RE_TABLE.exec(src))) {
      const r = parseTable(m);
      if (r) {
        src = src.slice(r.raw.length);
        segs.push({ t: false, html: r.html });
        continue;
      }
    }
    if ((m = RE_LHEADING.exec(src))) {
      const text = m[1].trim();
      const depth = m[2].charAt(0) === '=' ? 1 : 2;
      src = src.slice(rtrim(m[0], '\n').length);
      segs.push({ t: false, html: '<h' + depth + '>' + inlineHtml(text, false) + '</h' + depth + '>\n' });
      continue;
    }
    if (top && (m = RE_PARAGRAPH.exec(src))) {
      const raw = m[0];
      let text = m[1];
      if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
      text = dedentLazyText(text);
      src = src.slice(raw.length);
      segs.push({ t: false, html: '<p>' + inlineHtml(text, false) + '</p>\n' });
      continue;
    }
    if ((m = RE_TEXT.exec(src))) {
      const raw = dedentLazyText(m[0]);
      src = src.slice(m[0].length);
      const last = segs[segs.length - 1];
      if (last && last.t && !textBreak) {
        last.raw += '\n' + raw;
      } else {
        segs.push({ t: true, raw });
      }
      textBreak = false;
      continue;
    }
    break;
  }
  return segs;
}

// Join segments to HTML: text segments become <p>...</p> when `top` is true.
function joinSegs(segs, top) {
  let out = '';
  for (const s of segs) {
    if (s.t) {
      const inner = inlineHtml(s.raw, false);
      out += top ? '<p>' + inner + '</p>\n' : inner;
    } else {
      out += s.html;
    }
  }
  return out;
}

function parseBlocks(src, top = true) {
  return joinSegs(parseBlocksSeg(src, top), top);
}

function renderCode(text, lang) {
  const langStr = (lang || '').match(/^\S*/)?.[0];
  const code = text ? text.replace(/\n$/, '') + '\n' : '';
  if (!langStr) return '<pre><code>' + escHtml(code, true) + '</code></pre>\n';
  return '<pre><code class="language-' + escHtml(langStr) + '">' + escHtml(code, true) + '</code></pre>\n';
}

function parseTable(m) {
  if (!/[:|]/.test(m[2])) return null;
  const headers = splitCells(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  if (headers.length !== aligns.length) return null;
  const rows = m[3] && m[3].trim() ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const align = aligns.map(a => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  let html = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < headers.length; i++) {
    html += '<th' + (align[i] ? ' align="' + align[i] + '"' : '') + '>' + inlineHtml(headers[i], false) + '</th>\n';
  }
  html += '</tr>\n</thead>\n';
  if (rows.length) {
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>\n';
      const cells = splitCells(row, headers.length);
      for (let i = 0; i < cells.length; i++) {
        html += '<td' + (align[i] ? ' align="' + align[i] + '"' : '') + '>' + inlineHtml(cells[i], false) + '</td>\n';
      }
      html += '</tr>\n';
    }
    html += '</tbody>';
  }
  html += '</table>\n';
  return { raw: rtrim(m[0], '\n'), html };
}

function parseBlockquote(rawSrc) {
  // Returns {html, consumed}: a lazy line (no '>') continues the blockquote
  // only while the content so far ends in a paragraph. Once a code block,
  // heading, list, etc. has closed the paragraph, a lazy line is outside
  // the blockquote (marked's frame rule); the leftover raw is re-parsed by
  // the caller as top-level blocks.
  const rawLines = [];
  let pos = 0;
  while (pos < rawSrc.length) {
    const nl = rawSrc.indexOf('\n', pos);
    const end = nl === -1 ? rawSrc.length : nl + 1;
    rawLines.push(rawSrc.slice(pos, end));
    pos = end;
  }
  const contentLines = [];
  const lazyLines = new Set();
  let consumed = 0;
  for (let li = 0; li < rawLines.length; li++) {
    const lineText = rawLines[li];
    const m = /^( {0,3}>)([ \t]+)?/.exec(lineText);
    if (m) {
      let rest = lineText.slice(m[0].length);
      if (m[2]) {
        const spaces = expandTabs(m[2], m[1].length);
        rest = spaces.slice(1) + rest;
      }
      contentLines.push(rest);
      consumed += lineText.length;
    } else {
      // lazy line: include only if the content so far ends in a paragraph
      // (or in a container -- blockquote/list -- whose innermost paragraph
      // the inner frame will decide about; a code block, heading, hr, html
      // or table closes the paragraph and ends the blockquote here).
      if (contentLines.length === 0) break;
      const lastContent = contentLines[contentLines.length - 1];
      if (!lastContent.trim()) break; // blank line closed the paragraph
      // speculative parse: its inline state (IN_LINK/IN_RAW_BLOCK) must not
      // leak into the real parse (a later </a> processed here would wrongly
      // close a <a> that is still open at this point in the document).
      const savedLink = IN_LINK, savedRaw = IN_RAW_BLOCK;
      const segs = parseBlocksSeg(contentLines.join(''), false);
      IN_LINK = savedLink; IN_RAW_BLOCK = savedRaw;
      const lastSeg = segs[segs.length - 1];
      if (!lastSeg) break;
      if (!lastSeg.t && !/^(<blockquote|<ul|<ol)/.test(lastSeg.html)) break;
      contentLines.push(lineText);
      lazyLines.add(lineText.charAt(lineText.length - 1) === '\n' ? lineText.slice(0, -1) : lineText);
      consumed += lineText.length;
    }
  }
  const content = rtrim(contentLines.join(''), '\n');
  // A lazy setext underline must not become a heading: precede it with 4 spaces.
  const neutralized = content.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
  const prevLazy = BQ_LAZY;
  BQ_LAZY = lazyLines;
  const html = parseBlocks(neutralized, true);
  BQ_LAZY = prevLazy;
  return { html: '<blockquote>\n' + html + '</blockquote>\n', consumed };
}

// ---- list parsing (mirrors marked's list tokenizer) ----
const _ci = (indent) => Math.max(0, Math.min(3, indent - 1));
const RE_LIST_ITEM = (bull) => new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const RE_NEXT_BULLET = (indent) => new RegExp(`^ {0,${_ci(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
const RE_HR_I = (indent) => new RegExp(`^ {0,${_ci(indent)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
const RE_FENCES_BEGIN = (indent) => new RegExp(`^ {0,${_ci(indent)}}(?:\`\`\`|~~~)`);
const RE_HEADING_BEGIN = (indent) => new RegExp(`^ {0,${_ci(indent)}}#{1,6}(?:\\s|$)`);
const RE_HTML_BEGIN = (indent) => new RegExp(`^ {0,${_ci(indent)}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const RE_BQ_BEGIN = (indent) => new RegExp(`^ {0,${_ci(indent)}}>`);

function parseList(src) {
  const cap0 = RE_LIST_START.exec(src);
  if (!cap0) return null;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap0[1].trim();
  const isordered = bull.length > 1;
  const start = isordered ? +bull.slice(0, -1) : '';
  const list = { ordered: isordered, start, loose: false, items: [] };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = RE_LIST_ITEM(bull);
  let endsWithBlankLine = false;
  let cap;

  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (RE_HR.test(src)) break;
    const itemStart = taken();
    src = src.slice(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && /^[ \t]*$/.test(nextLine)) {
      src = src.slice(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = RE_NEXT_BULLET(indent);
      const hrRegex = RE_HR_I(indent);
      const fencesBeginRegex = RE_FENCES_BEGIN(indent);
      const headingBeginRegex = RE_HEADING_BEGIN(indent);
      const htmlBeginRegex = RE_HTML_BEGIN(indent);
      const blockquoteBeginRegex = RE_BQ_BEGIN(indent);
      while (src) {
        const rawLine = src.split('\n', 1)[0];
        let nextLine2 = rawLine;
        const nextLineWithoutTabs = nextLine2.replace(/^[ \t]+/, (ws) => expandTabs(ws));
        if (fencesBeginRegex.test(nextLine2)) break;
        if (headingBeginRegex.test(nextLine2)) break;
        if (htmlBeginRegex.test(nextLine2)) break;
        if (blockquoteBeginRegex.test(nextLine2)) break;
        if (nextBulletRegex.test(nextLine2)) break;
        if (hrRegex.test(nextLine2)) break;
        if (nextLineWithoutTabs.search(/[^ ]/) >= indent || !nextLine2.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(/\t/g, '    ').search(/[^ ]/) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine2)
            && RE_LHEADING.test(`${line}\n${nextLine2}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine2;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine2.trim();
        src = src.slice(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({ raw, task: /^\[[ xX]\][ \t]+\S/.test(itemContents), text: itemContents });
  }

  const lastItem = list.items[list.items.length - 1];
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  const listRaw = listSrc.slice(0, taken()).trimEnd();

  // loose if any item's top-level blocks are separated by a blank line
  // (marked: a space token whose raw holds more than one line break).
  // blankBetween is tracked in parseBlocksSeg, so blank lines inside a
  // nested list do not make the outer list loose.
  for (const item of list.items) {
    const segs = parseBlocksSeg(item.text, false);
    item.segs = segs;
    if (!list.loose && segs.blankBetween) list.loose = true;
  }

  let html = '';
  const type = list.ordered ? 'ol' : 'ul';
  const startAttr = (list.ordered && list.start !== 1) ? ` start="${list.start}"` : '';
  html += `<${type}${startAttr}>\n`;
  for (const item of list.items) {
    let segs = item.segs;
    let checkboxHtml = '';
    let isTask = item.task;
    if (isTask) {
      // first segment must be text for the checkbox to render
      const first = segs[0];
      if (first && first.t) {
        // strip the checkbox marker from the text segment's source: re-render
        // the text without it. The marker is at the start of the item text.
        const mTask = /^\[[ xX]\][ \t]+/.exec(item.text);
        if (mTask) {
          const checked = item.text[mTask[0].indexOf('[') + 1] !== ' ';
          checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
          // rebuild first text segment without the marker
          const newText = item.text.slice(mTask[0].length);
          // re-parse: its inline state must not leak (the item text was
          // already parsed once; re-applying its <a> opens/closes would
          // corrupt the document-wide IN_LINK/IN_RAW_BLOCK state).
          const savedLink = IN_LINK, savedRaw = IN_RAW_BLOCK;
          const newSegs = parseBlocksSeg(newText, false);
          IN_LINK = savedLink; IN_RAW_BLOCK = savedRaw;
          // keep only the leading text segment(s) from the re-parse, then the rest
          segs = newSegs;
        } else {
          isTask = false;
        }
      } else {
        isTask = false;
      }
    }
    let body = '';
    if (list.loose) {
      let firstSeg = true;
      for (const s of segs) {
        if (s.t) {
          let inner = inlineHtml(s.raw, false);
          if (firstSeg && isTask && checkboxHtml) { inner = checkboxHtml + inner; checkboxHtml = ''; }
          body += '<p>' + inner + '</p>\n';
        } else {
          body += s.html;
        }
        firstSeg = false;
      }
      if (isTask && checkboxHtml) body = '<p>' + checkboxHtml + '</p>\n' + body;
    } else {
      if (isTask && checkboxHtml) body += checkboxHtml;
      for (const s of segs) body += s.t ? inlineHtml(s.raw, false) : s.html;
    }
    html += '<li>' + body + '</li>\n';
  }
  html += `</${type}>\n`;
  return { raw: listRaw, html };
}
