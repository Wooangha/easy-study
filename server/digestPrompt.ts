// Prompts and output parsing for the digest ("정리본", DESIGN §11): an LLM reads every slide image
// once and writes a faithful per-slide transcription + explanation, plus a lecture summary that is
// used as course context for later lectures.
//
// Like prompts.ts, everything here is deterministic (no dates, ids or randomness).
import type { DigestSlide } from '../shared/types.ts';
import { cleanExtractedText, prepareMarkdown, truncateText } from './context.ts';
import type { Part } from './providers/types.ts';

/** Consecutive slides per provider call. */
export const DIGEST_BATCH_SIZE = 4;

/** Markdown stored for a slide whose output could not be parsed (entry has failed: true). */
export const DIGEST_FAILED_PLACEHOLDER = '_(이 슬라이드의 정리본을 만들지 못했습니다. 다시 만들기를 시도해 보세요.)_';

/** Extracted text handed to the digest model per slide (it is only a hint; the image is the source). */
const MAX_BATCH_TEXT_CHARS = 6_000;
/** Per-slide and whole-digest caps for the lecture summary input. */
const MAX_SUMMARY_SLIDE_CHARS = 4_000;
const MAX_SUMMARY_INPUT_CHARS = 200_000;
const MAX_TITLE_CHARS = 200;

// ---------------------------------------------------------------------------
// Per-slide digest
// ---------------------------------------------------------------------------

export const DIGEST_SYSTEM_PROMPT = `You turn lecture slides into a faithful, self-contained Markdown digest that a student can study from instead of the slide images.

## Input
You receive a batch of consecutive slides of one lecture deck. For every slide you get its full-resolution image and the text extracted from the PDF text layer. The IMAGE IS THE SOURCE OF TRUTH: the extracted text is often garbled, incomplete or out of order, and it regularly loses or mangles symbols (α β ε ∪ ∩ ∈ ∉ ⊆ → ⇒ ⊢ ∀ ∃ subscripts, superscripts, primes). Use it only to double-check spelling.

## What to write for each slide
1. Transcription — reproduce ALL text on the slide, in reading order and in its ORIGINAL language (never translate; keep technical terms, identifiers, grammar symbols and notation exactly as written). Keep the slide's structure: bullets stay bullets, sub-bullets stay indented, numbered steps stay numbered.
   - Math and formal notation in LaTeX: inline $...$, display $$...$$ (never \\( \\) or \\[ \\]). Example: $A \\rightarrow \\alpha \\mid \\beta$, $\\mathrm{FIRST}(\\alpha) \\cup \\{\\varepsilon\\}$, $x_1, \\dots, x_n$.
   - Tables (including tables drawn as pictures) as Markdown tables with the same rows and columns, cell contents verbatim.
   - Code, pseudo-code and algorithm listings in fenced code blocks, keeping line breaks and indentation.
   - Do not use Markdown headings (#); use **bold** for sub-headings. Do not repeat the slide title in the body.
2. Figures — describe every diagram, tree, graph, automaton, chart, plot or picture explicitly, in Korean: what the boxes/nodes are and their exact labels, every arrow (from → to, with its label), values and axes, what is highlighted, circled or coloured, and what the figure shows. Start such a paragraph with "**그림:**". Skip this for slides without figures.
3. A final line starting with "핵심:" — a 1–2 sentence takeaway in Korean saying what the slide teaches (keep technical terms in the original language where natural).

## Faithfulness
- Never invent content: no facts, examples, steps or values that are not on the slide. Do not complete cut-off text or fill in blanks the slide leaves open (e.g. an exercise); describe them as they are.
- If something is unreadable, write [illegible] instead of guessing.
- Title-only, section-divider or nearly empty slides still get a block (transcribe what is there, then the 핵심 line).

## Output format (exactly this, nothing before or after)
<<<SLIDE n>>>
TITLE: <the slide's title as written on the slide, or empty if it has none>
<Markdown body: transcription, then figure description, then the 핵심 line>

- One block per slide of the batch, in ascending order, with the slide numbers given in the message (they are PDF page positions — ignore page numbers printed on the slides).
- The marker line is exactly <<<SLIDE n>>> on its own line. Do not wrap the output in a code fence.

Everything you need is attached to the message. Do not run tools or commands and do not read or write files for this task — just write the digest.`;

export function digestSystemPrompt(): string {
  return DIGEST_SYSTEM_PROMPT;
}

export interface DigestBatchSlide {
  /** 1-based slide number (PDF page position). */
  slide: number;
  /** Absolute path of the slide's full-resolution PNG. */
  imagePath: string;
  /** Extracted text of the slide ('' when none). */
  text: string;
}

export interface DigestBatchInput {
  deckTitle: string;
  pageCount: number;
  /** Title of the course the deck belongs to, if any. */
  courseTitle?: string | null;
  slides: DigestBatchSlide[];
}

/** The user turn of one digest batch: every slide's image followed by its extracted text. */
export function buildDigestBatchParts(input: DigestBatchInput): Part[] {
  const slides = [...input.slides].sort((a, b) => a.slide - b.slide);
  const numbers = slides.map((s) => s.slide);
  const course = input.courseTitle?.trim() ? ` (course "${input.courseTitle.trim()}")` : '';
  const pages = input.pageCount === 1 ? '1 slide' : `${input.pageCount} slides`;
  const parts: Part[] = [];
  let pending = [
    `# Lecture deck: "${input.deckTitle}"${course} · ${pages}`,
    `This batch: ${slideList(numbers)}. For each slide: its full-resolution image, then the text extracted from the PDF (unreliable — the image wins).`,
  ].join('\n');

  for (const s of slides) {
    pending += `\n\n## Slide ${s.slide} of ${input.pageCount}\nFull-resolution image of slide ${s.slide}:`;
    parts.push({ type: 'text', text: pending });
    parts.push({ type: 'image', path: s.imagePath, detail: 'high', label: `Slide ${s.slide}` });
    const text = cleanExtractedText(String(s.text ?? ''));
    pending = text
      ? `<extracted_text slide="${s.slide}">\n${truncateText(text, MAX_BATCH_TEXT_CHARS)}\n</extracted_text>`
      : `(slide ${s.slide} has no extractable text — read everything from the image)`;
  }

  const markers = numbers.map((n) => `<<<SLIDE ${n}>>>`).join(', ');
  pending +=
    `\n\nNow write the digest for ${slideList(numbers)}: exactly ${numbers.length} block${numbers.length === 1 ? '' : 's'} ` +
    `(${markers}) in the output format from your instructions. Transcribe faithfully in the original language, ` +
    'describe figures in Korean, and end every block with a "핵심:" line in Korean.';
  parts.push({ type: 'text', text: pending });
  return parts;
}

function slideList(numbers: number[]): string {
  if (numbers.length === 0) return 'no slides';
  if (numbers.length === 1) return `slide ${numbers[0]}`;
  const contiguous = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  return contiguous ? `slides ${numbers[0]}–${numbers[numbers.length - 1]}` : `slides ${numbers.join(', ')}`;
}

// ---------------------------------------------------------------------------
// Parsing the model output
// ---------------------------------------------------------------------------

/**
 * A marker line, tolerating decoration: "<<<SLIDE 5>>>", "**<<< Slide 5 >>>**", "`<<<slide #5>>>`",
 * "### <<<SLIDE 5>>>". Anything after the marker on the same line is kept as body text.
 */
const MARKER_RE = /^[\s>#*_`-]*<{2,}\s*[*_]*\s*slide\s*[#:]?\s*(\d{1,5})\s*[*_]*\s*>{2,}[*_`]*\s*(.*)$/i;
/** "TITLE: …" (also "**Title:**", "제목:"), with an ASCII or full-width colon. */
const TITLE_RE = /^\s*[*_]*\s*(?:title|제목)\s*[*_]*\s*[:：]\s*(.*)$/i;
const FENCE_LINE_RE = /^\s{0,3}(```|~~~)\s*([\w-]*)\s*$/;
const ANY_FENCE_RE = /^\s{0,3}(```|~~~)/;
const RULE_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const EMPTY_TITLE_RE = /^[(\[]?\s*(?:none|no title|untitled|n\/a|없음|제목 없음)\s*[)\]]?$/i;

/**
 * Parses digest output into one entry per expected slide (ascending). Lenient: text before the first
 * marker, decorated markers, CRLF, code fences around the output and a missing TITLE line are all
 * tolerated; a repeated marker replaces the earlier block (the last non-empty one wins); unexpected
 * slide numbers are ignored. Expected slides without a usable block get failed: true and a placeholder.
 */
export function parseDigestOutput(output: string, expectedSlides: number[]): DigestSlide[] {
  const expected = [...new Set(expectedSlides.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const lines = String(output ?? '').replace(/\r\n?/g, '\n').split('\n');

  // Every block of every expected slide, in output order (a slide may be repeated).
  const blocks = new Map<number, string[][]>();
  let current: string[] | null = null;
  let markers = 0;
  for (const line of lines) {
    const m = MARKER_RE.exec(line);
    if (m) {
      markers++;
      const n = Number(m[1]);
      current = null; // unexpected slide numbers: their block is dropped
      if (expected.includes(n)) {
        current = [];
        const rest = m[2].replace(/[*_`]+$/, '').trim();
        if (rest) current.push(rest);
        blocks.set(n, [...(blocks.get(n) ?? []), current]);
      }
      continue;
    }
    current?.push(line);
  }

  // A single expected slide answered without any marker: accept it when it has a TITLE line.
  if (markers === 0 && expected.length === 1) {
    const start = lines.findIndex((line) => TITLE_RE.test(line));
    if (start >= 0) blocks.set(expected[0], [lines.slice(start)]);
  }

  return expected.map((slide) => {
    const parsed = (blocks.get(slide) ?? []).map(parseBlock);
    // The last block with content wins (a repeated marker usually means the model corrected itself).
    const best = [...parsed].reverse().find((b) => b.markdown);
    if (best) return { slide, title: best.title, markdown: best.markdown };
    const title = parsed.length > 0 ? parsed[parsed.length - 1].title : '';
    return { slide, title, markdown: DIGEST_FAILED_PLACEHOLDER, failed: true };
  });
}

/** Title + cleaned Markdown body of one block. */
function parseBlock(raw: string[]): { title: string; markdown: string } {
  let lines = trimBlankLines(raw);

  // A fence opened before the TITLE line (the model fenced its whole answer or this block).
  if (lines.length > 1 && FENCE_LINE_RE.test(lines[0]) && TITLE_RE.test(firstNonBlank(lines.slice(1)))) {
    lines = trimBlankLines(lines.slice(1));
  }

  let title = '';
  const titleAt = lines.findIndex((line) => line.trim() !== '');
  if (titleAt >= 0) {
    const m = TITLE_RE.exec(lines[titleAt]);
    if (m) {
      title = cleanTitle(m[1]);
      lines = trimBlankLines(lines.slice(titleAt + 1));
    }
  }

  lines = stripWrappingFences(lines);
  // Separators models put between blocks ("---") are not part of the slide.
  while (lines.length > 0 && RULE_RE.test(lines[lines.length - 1])) lines = trimBlankLines(lines.slice(0, -1));

  // Headings are kept as written; consumers demote them under their own headings.
  return { title, markdown: prepareMarkdown(lines.join('\n'), { demoteHeadings: false }) };
}

/**
 * Removes fence lines that wrap the body rather than belong to it: an opening ```markdown / ```md
 * fence around the whole body, or a stray unbalanced fence at the start/end (left over from a fence
 * around the whole output). A code block left open is closed.
 */
function stripWrappingFences(input: string[]): string[] {
  let lines = input;
  const first = lines.length > 0 ? FENCE_LINE_RE.exec(lines[0]) : null;
  const lastIsBareFence = lines.length > 1 && /^\s{0,3}(```|~~~)\s*$/.test(lines[lines.length - 1]);
  if (first && /^(markdown|md)$/i.test(first[2]) && lastIsBareFence) {
    lines = trimBlankLines(lines.slice(1, -1));
  }
  if (countFences(lines) % 2 === 1) {
    const last = lines[lines.length - 1];
    const head = lines.length > 0 ? FENCE_LINE_RE.exec(lines[0]) : null;
    if (last !== undefined && /^\s{0,3}(```|~~~)\s*$/.test(last)) {
      lines = trimBlankLines(lines.slice(0, -1));
    } else if (head && /^(markdown|md)$/i.test(head[2])) {
      lines = trimBlankLines(lines.slice(1));
    } else {
      // A code block the model never closed: close it so it does not swallow what follows.
      lines = [...lines, '```'];
    }
  }
  return lines;
}

function countFences(lines: string[]): number {
  return lines.filter((line) => ANY_FENCE_RE.test(line)).length;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

function firstNonBlank(lines: string[]): string {
  return lines.find((line) => line.trim() !== '') ?? '';
}

function cleanTitle(raw: string): string {
  let title = raw.replace(/\s+/g, ' ').trim();
  // Decoration around the value: **Title**, `Title`, "Title".
  title = title.replace(/^[*_`"“]+|[*_`"”]+$/g, '').trim();
  if (EMPTY_TITLE_RE.test(title)) return '';
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS).trimEnd()}…` : title;
}

// ---------------------------------------------------------------------------
// Lecture summary (course context for later lectures)
// ---------------------------------------------------------------------------

export const LECTURE_SUMMARY_SYSTEM_PROMPT = `You write the summary of one lecture of a university course, based on a per-slide digest of the lecture deck. The summary is shown to the student and is given to a tutor model as context when the student studies LATER lectures of the course, so it must be precise and self-contained.

Write in Korean, at most about 1500 characters, as compact Markdown (bold labels and bullet lists; no # headings), covering:
- **주제**: what the lecture is about, in 1–2 sentences.
- **핵심 개념·정의**: the key definitions and notation, with formal notation in LaTeX ($...$) exactly as the lecture uses it (keep technical terms in the original language, e.g. "FIRST 집합 (FIRST set)").
- **알고리즘·절차**: the algorithms, constructions or procedures taught, with their essential steps or conditions.
- **연결**: how the lecture connects to the rest of the course — what it builds on and what it prepares, as far as the slides say (e.g. a "next lecture" slide).

Refer to slides as "slide N" only when it helps locate a definition. Use only what the digest contains: do not add outside material. Output only the summary.`;

export function lectureSummarySystemPrompt(): string {
  return LECTURE_SUMMARY_SYSTEM_PROMPT;
}

export interface LectureSummaryInput {
  deckTitle: string;
  courseTitle?: string | null;
  /** The digest entries of the lecture (failed entries are skipped). */
  digest: DigestSlide[];
}

/** The (text-only) user turn asking for the lecture summary. */
export function buildLectureSummaryParts(input: LectureSummaryInput): Part[] {
  const entries = (Array.isArray(input.digest) ? input.digest : [])
    .filter((e) => e && !e.failed && typeof e.markdown === 'string' && e.markdown.trim())
    .sort((a, b) => a.slide - b.slide);
  const course = input.courseTitle?.trim() ? ` of the course "${input.courseTitle.trim()}"` : '';

  const sections: string[] = [];
  let used = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const title = cleanTitle(String(e.title ?? ''));
    const section = `### Slide ${e.slide}${title ? ` · ${title}` : ''}\n${truncateText(prepareMarkdown(e.markdown), MAX_SUMMARY_SLIDE_CHARS)}`;
    if (used + section.length + 2 > MAX_SUMMARY_INPUT_CHARS) {
      sections.push(`(digest of slides ${e.slide}–${entries[entries.length - 1].slide} omitted for length)`);
      break;
    }
    sections.push(section);
    used += section.length + 2;
  }
  if (sections.length === 0) sections.push('(the digest is empty)');

  const text = [
    `# Lecture "${input.deckTitle}"${course}`,
    'Per-slide digest of the lecture (transcriptions made from the slide images):',
    ...sections,
    'Now write the lecture summary as instructed: Korean, at most about 1500 characters, covering 주제, 핵심 개념·정의, 알고리즘·절차 and 연결.',
  ].join('\n\n');
  return [{ type: 'text', text }];
}
