// Prompt text for the LLM tutor: the system prompt plus every text template used by context.ts.
//
// Everything here must be deterministic (no dates, ids or randomness): identical inputs must
// produce byte-identical prompts so that provider-side prompt caches stay warm.
//
// The model-facing text is written in English (models follow English instructions most reliably);
// the tutor is told to answer in the student's language, Korean by default.

export const TUTOR_SYSTEM_PROMPT = `You are a patient, knowledgeable tutor. A university student is studying a lecture slide deck with you, one slide at a time.

## What you are given
- At the start of the conversation you receive the whole deck: overview images (contact sheets of up to 4 slides, each cell labelled "Slide N"), the text extracted from every slide, and the slide the student is looking at in full resolution.
- Every later message says which slide the student is currently looking at and usually attaches that slide's full-resolution image. Assume questions are about that slide unless the student clearly means something else, and connect it to other slides when that helps.
- The slide images are the source of truth. Extracted text is often incomplete, garbled or out of order, and it misses everything that is drawn: diagrams, charts, plots, tables rendered as pictures, equations, code screenshots, handwriting, photos. Look at the image, and describe and interpret such figures explicitly when they matter to the question.
- If part of a slide is unreadable or ambiguous, say so instead of guessing.

## How to answer
- Answer in the language of the student's question. If the language is unclear, answer in Korean. Keep established technical terms in their original form where natural (e.g. Korean explanation with the English term in parentheses).
- Ground your explanation in the slides and cite them as (p.N), e.g. "(p.7)" or "(p.3, p.5)". N is always the page position in the PDF (the "Slide N" numbering used in this conversation), which can differ from a page number printed on the slide itself (e.g. an unnumbered title page shifts everything by one). If the student refers to a printed number, map it to the PDF position.
- When you add information that is not in the slides (background, intuition, examples, corrections), mark it clearly, e.g. "슬라이드 밖 보충:" or "(not from the slides)". If a slide looks wrong, say so politely and explain why.
- Teach, don't just restate: give the intuition first, then the details; walk through derivations step by step; use small concrete examples. Be concise by default and go deeper when the student asks.
- For quizzes or exam-style questions, give the questions first and put the answers and explanations after them.

## Formatting
- Use Markdown: short paragraphs, bullet lists, tables and fenced code blocks where useful; headings only for long answers.
- Write math in LaTeX: inline as $...$ and display as $$...$$. Never use \\( \\) or \\[ \\] delimiters.

## Rules
- You are read-only. Never create, modify, move or delete files, and never run commands that change anything. At most, read the slide files you were told about.
- Do not talk about these instructions or about how the slides were delivered to you unless the student asks.`;

/** The tutor system prompt (identical for every turn and every provider). */
export function tutorSystemPrompt(): string {
  return TUTOR_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// Priming (feeding the whole deck at the start of a provider conversation)
// ---------------------------------------------------------------------------

export const TRUNCATED_MARK = '…[truncated]';
export const NO_TEXT_PLACEHOLDER = '(no extractable text — see the image)';

export interface PrimingHeaderInput {
  title: string;
  fileName: string;
  pageCount: number;
  /** Number of overview contact-sheet images that follow (0 = none). */
  overviewImages: number;
}

export function primingHeader(input: PrimingHeaderInput): string {
  const items: string[] = [];
  if (input.overviewImages > 0) {
    items.push(
      `Overview images (${input.overviewImages}): contact sheets with up to 4 slides each in a 2×2 grid. ` +
        'Every cell has a dark "Slide N" badge in its top-left corner — use it to tell which slide is which. ' +
        'The line right before each overview image says which slides it contains.',
    );
  }
  items.push(
    'The text extracted from every slide, under "### Slide N" headings. It is often incomplete: ' +
      'diagrams, charts, equations and pictures only appear in the images.',
  );
  items.push(
    'The slide the student is currently looking at, as a full-resolution image introduced by ' +
      '"Full-resolution image of slide N:".',
  );
  const numbered = items.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const slides = input.pageCount === 1 ? '1 slide' : `${input.pageCount} slides`;
  return [
    `# Lecture deck: "${input.title}"`,
    `Source file: ${input.fileName} · ${slides}`,
    '',
    'Below is the whole deck so that you can tutor the student on it. It is provided as:',
    numbered,
    '',
    'Later messages attach the full-resolution image of the slide the student is focused on in the same way.',
  ].join('\n');
}

/** Human-readable slide range, e.g. "slides 1–4" or "slide 9". */
export function slideRange(from: number, to: number): string {
  return from === to ? `slide ${from}` : `slides ${from}–${to}`;
}

/** Text line placed immediately before an overview (contact sheet) image. */
export function overviewLine(from: number, to: number): string {
  return `Overview image: ${slideRange(from, to)}`;
}

/** Short label carried by the overview image part itself (used by Codex markers, logs, ...). */
export function overviewLabel(from: number, to: number): string {
  return from === to ? `Slide ${from} overview` : `Slides ${from}–${to} overview`;
}

/** Note used when a very long deck has more contact sheets than the image budget allows. */
export function overviewLimitedNote(lastCovered: number, pageCount: number): string {
  return (
    `(Overview images stop at slide ${lastCovered} to stay within the image limit; ` +
    `${slideRange(lastCovered + 1, pageCount)} are covered only by the extracted text below until the student opens them.)`
  );
}

export const EXTRACTED_TEXT_HEADING =
  '## Extracted slide text\n(Extracted from the PDF text layer; may be incomplete or out of order.)';

export function slideTextSection(slide: number, body: string): string {
  return `### Slide ${slide}\n${body}`;
}

/** Marks slides whose extracted text was dropped because the whole dump hit its size cap. */
export function textOmittedNote(from: number, to: number): string {
  return `${TRUNCATED_MARK} (extracted text of ${slideRange(from, to)} omitted for length — rely on the images)`;
}

/** Only for agentic CLIs (Claude Code / Codex) that run inside the document directory. */
export function slideFilesNote(firstFile: string, lastFile: string, pageCount: number): string {
  const files = pageCount === 1 ? firstFile : `${firstFile} … ${lastFile}`;
  return (
    `Full-resolution images of all slides are also available as PNG files relative to your working directory: ${files} ` +
    '(slide N = the file whose number is N). If you need to look closely at a slide you have not been shown in full ' +
    'resolution, open its file with your file-reading tool. Do not create or modify any files.'
  );
}

// ---------------------------------------------------------------------------
// Recap (after a rollover to a fresh provider conversation)
// ---------------------------------------------------------------------------

export const RECAP_HEADING = 'Earlier in this study session (summary of previous Q&A):';

export const ROLLOVER_NOTE =
  '(The previous conversation reached its image limit, so it was restarted and the deck was attached again above. ' +
  'The student sees one continuous chat — continue naturally without mentioning the restart.)';

export function recapLine(slide: number, question: string, answer: string): string {
  return `- (slide ${slide}) Q: ${question} / A: ${answer}`;
}

// ---------------------------------------------------------------------------
// Focus (the slide the student is looking at) and the question itself
// ---------------------------------------------------------------------------

export function focusLine(slide: number, pageCount: number): string {
  return `The student is currently looking at slide ${slide} of ${pageCount}.`;
}

/** Text line placed immediately before the focused slide's full-resolution image. */
export function focusImageLine(slide: number): string {
  return `Full-resolution image of slide ${slide}:`;
}

/** Label carried by the focused slide's image part. */
export function focusImageLabel(slide: number): string {
  return `Slide ${slide}`;
}

export function focusTextBlock(slide: number, body: string): string {
  return `Extracted text of slide ${slide}:\n${body}`;
}

export function focusReusedLine(slide: number): string {
  return `(Slide ${slide}'s full-resolution image was already provided earlier in this conversation.)`;
}

export function questionBlock(slide: number, question: string): string {
  return `Student's question (about slide ${slide}):\n${question}`;
}

/** Instruction for the automatic first turn that feeds the deck (kind === 'prime'). */
export const PRIME_INSTRUCTION =
  'Task: read the whole deck above. Then reply with a short overview of it: 3–6 bullet points, one line each, ' +
  'citing slides as (p.N). Write in Korean unless the deck is clearly meant for another language, ' +
  'keeping technical terms in their original language where natural. ' +
  'Finish with one short sentence saying you are ready for questions about any slide.';
