// LLMs often write LaTeX with \( … \) and \[ … \] delimiters, but remark-math only understands
// $…$ and $$…$$. Convert them before rendering — without touching fenced or inline code.

/**
 * Convert `\( … \)` → `$…$` and `\[ … \]` → `$$…$$` outside fenced code blocks and inline code spans.
 * A line consisting only of `$$ … $$` becomes a display block (remark-math would render it inline).
 * Unbalanced delimiters (e.g. while the answer is still streaming) are left untouched.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes('\\(') && !markdown.includes('\\[') && !markdown.includes('$$')) return markdown;

  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; len: number } | null = null;

  const flushProse = () => {
    if (prose.length > 0) {
      out.push(convertProse(prose.join('\n')));
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
