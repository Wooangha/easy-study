// LLMs often write LaTeX with \( … \) and \[ … \] delimiters, but remark-math only understands
// $…$ and $$…$$. Convert them before rendering — without touching fenced or inline code.
//
// remark-math also ends an inline `$…$` span at the `$` of an escaped `\$` (backslashes do not
// escape inside math), so `$\{ \$ \}$` — the end-of-input marker in FIRST/FOLLOW sets and LL(1)
// tables — used to render as a KaTeX error. Inside inline math such a `\$` is rewritten to
// `{\char36}` (KaTeX renders it as "$"), so the span ends where the author meant it to.

/**
 * Prepare LLM Markdown for react-markdown + remark-math (outside fenced code blocks and inline code):
 * - `\( … \)` → `$…$` and `\[ … \]` → `$$…$$`; a line consisting only of `$$ … $$` becomes a display
 *   block (remark-math would render it inline);
 * - inside inline `$…$` math, `\$` → `{\char36}` (see above);
 * - a stray `$` in prose that would pair with a later `$` and turn the prose in between into math
 *   (e.g. "the end marker $ is appended; FIRST($\alpha$)") is escaped.
 * Unbalanced delimiters (e.g. while the answer is still streaming) are left untouched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[') && !markdown.includes('$')) return markdown;

  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;

  const flushProse = () => {
    if (prose.length > 0) {
      out.push(protectInlineMath(convertProse(prose.join('\n'))));
      prose = [];
    }
  };

  for (const line of markdown.split('\n')) {
    if (fence) {
      out.push(line);
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      flushProse();
      fence = { char: open[1][0], len: open[1].length };
      out.push(line);
      continue;
    }
    const displayLine = /^([ \t]*)\$\$(.+?)\$\$[ \t]*$/.exec(line);
    if (displayLine && !displayLine[2].includes('$$') && displayLine[2].trim() !== '') {
      const [, indent, inner] = displayLine;
      prose.push(`${indent}$$`, `${indent}${inner.trim()}`, `${indent}$$`);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return out.join('\n');
}

/** Split prose into inline-code spans (kept verbatim) and text (math-converted). */
function convertProse(text: string): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf('`', i);
    if (tick === -1) {
      result += convertMath(text.slice(i));
      break;
    }
    let runEnd = tick;
    while (text[runEnd] === '`') runEnd++;
    const close = findClosingBacktickRun(text, runEnd, runEnd - tick);
    if (close === -1) {
      // Unclosed backticks are literal text.
      result += convertMath(text.slice(i, runEnd));
      i = runEnd;
      continue;
    }
    result += convertMath(text.slice(i, tick)) + text.slice(tick, close + (runEnd - tick));
    i = close + (runEnd - tick);
  }
  return result;
}

function findClosingBacktickRun(text: string, from: number, len: number): number {
  let k = from;
  for (;;) {
    const t = text.indexOf('`', k);
    if (t === -1) return -1;
    let e = t;
    while (text[e] === '`') e++;
    if (e - t === len) return t;
    k = e;
  }
}

/** True when the backslash at `index` is itself escaped (preceded by an odd number of backslashes). */
function isEscaped(s: string, index: number): boolean {
  let n = 0;
  for (let k = index - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

function findToken(s: string, token: string, from: number): number {
  let idx = s.indexOf(token, from);
  // Skip `\\[` (a LaTeX line break with spacing, e.g. `a \\[4pt] b`) and similar escaped forms.
  while (idx !== -1 && isEscaped(s, idx)) idx = s.indexOf(token, idx + 1);
  return idx;
}

function convertMath(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const paren = findToken(s, '\\(', i);
    const bracket = findToken(s, '\\[', i);
    let start: number;
    let display: boolean;
    if (paren === -1 && bracket === -1) break;
    if (bracket === -1 || (paren !== -1 && paren < bracket)) {
      start = paren;
      display = false;
    } else {
      start = bracket;
      display = true;
    }

    const end = findToken(s, display ? '\\]' : '\\)', start + 2);
    if (end === -1) break; // unbalanced — leave the rest as is
    const inner = s.slice(start + 2, end).trim();
    if (inner === '') {
      out += s.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    out += s.slice(i, start);
    i = end + 2;
    if (!display) {
      out += `$${inner}$`;
      continue;
    }

    const lineStart = s.lastIndexOf('\n', start - 1) + 1;
    const prefix = s.slice(lineStart, start);
    if (/^[ \t]*$/.test(prefix)) {
      // `\[` starts its line → a math block, indented like the line (keeps list items intact).
      const body = inner
        .split('\n')
        .map((l) => prefix + l.trim())
        .join('\n');
      out += `$$\n${body}\n${prefix}$$`;
      const restOfLine = /^[^\n]*/.exec(s.slice(i))?.[0] ?? '';
      if (restOfLine.trim() !== '') out += `\n${prefix}`;
    } else {
      out += `$$${inner.replace(/\s*\n\s*/g, ' ')}$$`;
    }
  }
  return out + s.slice(i);
}

// ---------------------------------------------------------------------------------------------
// Inline math repair: `\$` inside `$…$`, stray `$` in prose
// ---------------------------------------------------------------------------------------------

/** KaTeX-safe spelling of a literal dollar sign inside math (braced so a following digit is not part of the char code). */
const MATH_DOLLAR = '{\\char36}';

interface Edit {
  from: number;
  to: number;
  text: string;
}

const BLANK_RE = /^\s*$/;
/** Opening fence of a `$$` math block (the meta may not contain `$`). */
const MATH_FENCE_RE = /^\s*(\${2,})[^$]*$/;
/** GFM table delimiter row, e.g. `|---|:---:|` or `--- | ---`. */
const TABLE_DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** Lines that start a new block (heading, list item, block quote): an inline span never continues into them. */
const BLOCK_START_RE = /^\s*(#{1,6}(\s|$)|>|([-*+]|\d{1,9}[.)])(\s|$))/;

/**
 * Find inline math spans the way remark-math does (an opening run of n `$` closes at the next run of
 * exactly n `$`, inside one paragraph / heading / table cell), except that a `$` preceded by an odd
 * number of backslashes is content. Such `\$` are rewritten to `{\char36}`. `$$` math blocks and
 * inline code are left alone. `text` contains no fenced code (the caller splits it out).
 */
function protectInlineMath(text: string): string {
  if (!text.includes('$')) return text;
  const lines = text.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineEnd = (i: number) => starts[i] + lines[i].length;
  const tableLines = findTableLines(lines);

  const edits: Edit[] = [];
  let runStart = -1; // offset where the current paragraph-like run starts, or -1
  const endRun = (end: number) => {
    if (runStart !== -1) scanInline(text, runStart, end, edits);
    runStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (BLANK_RE.test(line)) {
      endRun(starts[i]);
      continue;
    }
    const mathFence = MATH_FENCE_RE.exec(line);
    if (mathFence) {
      // `$$` block: its lines are raw TeX up to a closing fence of at least the same length.
      endRun(starts[i]);
      const closeRe = new RegExp(`^\\s*\\\${${mathFence[1].length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      i = j;
      continue;
    }
    if (tableLines.has(i)) {
      // Table cells are parsed one by one: a span never crosses an unescaped `|` or a row.
      endRun(starts[i]);
      let cellStart = starts[i];
      for (let k = starts[i]; k <= lineEnd(i); k++) {
        if (k === lineEnd(i) || (text[k] === '|' && text[k - 1] !== '\\')) {
          scanInline(text, cellStart, k, edits);
          cellStart = k + 1;
        }
      }
      continue;
    }
    if (BLOCK_START_RE.test(line)) endRun(starts[i]);
    if (runStart === -1) runStart = starts[i];
    // A heading is a single line.
    if (/^\s*#{1,6}(\s|$)/.test(line)) endRun(lineEnd(i));
  }
  endRun(text.length);

  if (edits.length === 0) return text;
  edits.sort((a, b) => a.from - b.from);
  let result = '';
  let pos = 0;
  for (const e of edits) {
    result += text.slice(pos, e.from) + e.text;
    pos = e.to;
  }
  return result + text.slice(pos);
}

/** Indexes of lines that belong to GFM tables (header row, delimiter row and body rows). */
function findTableLines(lines: string[]): Set<number> {
  const table = new Set<number>();
  for (let i = 1; i < lines.length; i++) {
    const header = lines[i - 1];
    if (table.has(i - 1) || !lines[i].includes('-') || !TABLE_DELIMITER_RE.test(lines[i])) continue;
    if (!header.includes('|') || BLANK_RE.test(header)) continue;
    if (!lines[i].includes('|') && !/^\s*\|/.test(header)) continue;
    table.add(i - 1);
    table.add(i);
    let j = i + 1;
    while (j < lines.length && !BLANK_RE.test(lines[j]) && !BLOCK_START_RE.test(lines[j])) table.add(j++);
    i = j;
  }
  return table;
}

const isAsciiPunctuation = (c: string | undefined) => c !== undefined && /[!-/:-@[-`{-~]/.test(c);

/** Scan text[from, to) — one paragraph, heading or table cell — for inline code and inline math. */
function scanInline(text: string, from: number, to: number, edits: Edit[]): void {
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === '\\') {
      // Character escape (`\$`, `\\`, …) outside math.
      i += isAsciiPunctuation(text[i + 1]) && i + 1 < to ? 2 : 1;
      continue;
    }
    if (c === '`') {
      let runEnd = i;
      while (runEnd < to && text[runEnd] === '`') runEnd++;
      const close = findBacktickRun(text, runEnd, to, runEnd - i);
      i = close === -1 ? runEnd : close + (runEnd - i);
      continue;
    }
    if (c !== '$') {
      i++;
      continue;
    }

    let openEnd = i;
    while (openEnd < to && text[openEnd] === '$') openEnd++;
    const size = openEnd - i;
    const escapedDollars: number[] = [];
    let close = -1;
    let j = openEnd;
    while (j < to) {
      if (text[j] === '\\') {
        let k = j;
        while (k < to && text[k] === '\\') k++;
        if ((k - j) % 2 === 1 && text[k] === '$' && k < to) {
          escapedDollars.push(k); // `\$` inside math: content, not the closing delimiter
          j = k + 1;
        } else {
          j = k;
        }
        continue;
      }
      if (text[j] === '$') {
        let k = j;
        while (k < to && text[k] === '$') k++;
        if (k - j === size) {
          close = j;
          break;
        }
        j = k;
        continue;
      }
      j++;
    }

    if (close === -1) {
      // No closing run: the `$` are literal text.
      i = openEnd;
      continue;
    }
    if (size === 1 && looksLikeProse(text.slice(openEnd, close))) {
      // A stray `$` in prose: keep it literal so the next `$` can open real math.
      edits.push({ from: i, to: openEnd, text: '\\$' });
      i = openEnd;
      continue;
    }
    for (const k of escapedDollars) edits.push({ from: k - 1, to: k + 1, text: MATH_DOLLAR });
    i = close + size;
  }
}

function findBacktickRun(text: string, from: number, to: number, len: number): number {
  let k = from;
  while (k < to) {
    const t = text.indexOf('`', k);
    if (t === -1 || t >= to) return -1;
    let e = t;
    while (e < to && text[e] === '`') e++;
    if (e - t === len) return t;
    k = e;
  }
  return -1;
}

const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;

/**
 * True when the text between a `$` and the next `$` is clearly prose, not TeX: it starts with a space,
 * Hangul or a digit (a stray `$` before a particle, or a price), uses no TeX command, and contains Hangul
 * outside braces or at least two English words — e.g. " is appended; FIRST(", "를 FOLLOW 집합에 넣고 "
 * or "5이고 할인하면 ".
 */
function looksLikeProse(content: string): boolean {
  if (!/^[\s\d\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(content)) return false;
  if (/[\\^_]/.test(content)) return false;
  let depth = 0;
  let hangulOutside = false;
  for (const ch of content) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && HANGUL_RE.test(ch)) hangulOutside = true;
  }
  return hangulOutside || /[A-Za-z]{2,}[ \t]+[A-Za-z]{2,}/.test(content);
}
