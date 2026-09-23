// Prompt text for the LLM tutor: the system prompt plus every text template used by context.ts.
//
// Everything here must be deterministic (no dates, ids or randomness): identical inputs must
// produce byte-identical prompts so that provider-side prompt caches stay warm.
//
// The model-facing text is written in English (models follow English instructions most reliably);
// the tutor is told to answer in the student's language, Korean by default.

export const TUTOR_SYSTEM_PROMPT = `You are a patient, knowledgeable tutor. A university student is studying a lecture slide deck with you, one slide at a time.

## What you are given
- At the start of the conversation you receive the whole deck: per-slide material for every slide, often overview images (contact sheets of up to 4 slides, each cell labelled "Slide N"), and the slide the student is looking at in full resolution.
- Per-slide material is either text extracted from the PDF text layer, or a digest: a transcription of the slide (text, math, tables, code, descriptions of figures, and a "핵심:" takeaway) written earlier by a model that read the slide image. A digest is much more reliable than extracted text, but if it disagrees with a slide image you can see, the image wins.
- Every later message says which slide the student is currently looking at and usually attaches that slide's full-resolution image. Assume questions are about that slide unless the student clearly means something else, and connect it to other slides when that helps.
- Messages often also include the neighbouring slides before and after the current one, because lecture content often continues across pages. They are context: answer about the slide marked CURRENT unless the student asks about another one, and use the neighbours when the current slide continues or depends on them.
- The slide images are the source of truth. Extracted text is often incomplete, garbled or out of order, and it misses everything that is drawn: diagrams, charts, plots, tables rendered as pictures, equations, code screenshots, handwriting, photos. Look at the image, and describe and interpret such figures explicitly when they matter to the question.
- If part of a slide is unreadable or ambiguous, say so instead of guessing.

## Courses
- The deck may be one lecture of a course (for example lecture 7 of a compiler course). You are then told the course's lecture list and given summaries of the earlier lectures.
- The student may refer to earlier material ("저번 강의", "지난 시간", "앞 강의", "Lecture 6", "6강"). Use the summaries to connect the current slide to it. If you have file tools and were given paths to other lectures' files, open the relevant DIGEST.md (per-slide transcriptions) or slide images when you need details a summary does not have — only when it helps the answer.
- When you refer to another lecture, name it, e.g. "Lecture 6의 slide 12" or "(Lecture 6, slide 12)". The (p.N) form is reserved for the current deck.

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
- You are read-only. Never create, modify, move or delete files, and never run commands that change anything. At most, read the files you were told about (this deck's slide images and the other lectures' files).
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

/**
 * Where the per-slide material of the priming dump comes from:
 * 'extracted' = PDF text layer only, 'digest' = digest for every slide, 'mixed' = digest where available.
 */
export type MaterialKind = 'extracted' | 'digest' | 'mixed';

export interface PrimingHeaderInput {
  title: string;
  fileName: string;
  pageCount: number;
  /** Number of overview contact-sheet images that follow (0 = none). */
  overviewImages: number;
  /** Defaults to 'extracted'. */
  material?: MaterialKind;
  /** A "Course context" section follows the header. */
  courseContext?: boolean;
}

export function primingHeader(input: PrimingHeaderInput): string {
  const items: string[] = [];
  if (input.courseContext) {
    items.push(
      'Course context: where this lecture sits in its course, the list of lectures and summaries of the earlier ones.',
    );
  }
  if (input.overviewImages > 0) {
    items.push(
      `Overview images (${input.overviewImages}): contact sheets with up to 4 slides each in a 2×2 grid. ` +
        'Every cell has a dark "Slide N" badge in its top-left corner — use it to tell which slide is which. ' +
        'The line right before each overview image says which slides it contains.',
    );
  }
  switch (input.material ?? 'extracted') {
    case 'digest':
      items.push(
        'A digest of every slide under "### Slide N" headings: a transcription made earlier from each slide image ' +
          '(text, math, tables and code as on the slide, descriptions of figures, and a "핵심:" takeaway).',
      );
      break;
    case 'mixed':
      items.push(
        'The material of every slide under "### Slide N" headings: a digest (a transcription made earlier from the slide image) ' +
          'where one exists, otherwise the text extracted from the PDF, marked "(PDF text)". Extracted text is often ' +
          'incomplete: diagrams, charts, equations and pictures only appear in the images.',
      );
      break;
    default:
      items.push(
        'The text extracted from every slide, under "### Slide N" headings. It is often incomplete: ' +
          'diagrams, charts, equations and pictures only appear in the images.',
      );
      break;
  }
  items.push(
    'The slide the student is currently looking at (with its neighbouring slides, if any), as full-resolution images ' +
      'each introduced by "Full-resolution image of slide N:".',
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
    'Later messages attach the full-resolution images of the slides the student is focused on in the same way.',
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
    `${slideRange(lastCovered + 1, pageCount)} are covered only by the per-slide material below until the student opens them.)`
  );
}

export const EXTRACTED_TEXT_HEADING =
  '## Extracted slide text\n(Extracted from the PDF text layer; may be incomplete or out of order.)';

export const DIGEST_HEADING =
  '## Slide digest\n(Transcribed earlier from the slide images by a model: faithful text, math and tables, figure descriptions, and a "핵심:" takeaway per slide.)';

export const MIXED_MATERIAL_HEADING =
  '## Slide material\n(Digest transcribed from the slide image where available; sections marked "(PDF text)" were extracted from the PDF text layer and may be incomplete or out of order.)';

export function materialHeading(kind: MaterialKind): string {
  if (kind === 'digest') return DIGEST_HEADING;
  if (kind === 'mixed') return MIXED_MATERIAL_HEADING;
  return EXTRACTED_TEXT_HEADING;
}

/** "### Slide N" section of the priming dump (`title` for digest entries, `pdfTextMark` for fallbacks in a mixed dump). */
export function slideTextSection(slide: number, body: string, opts: { title?: string; pdfTextMark?: boolean } = {}): string {
  let heading = `### Slide ${slide}`;
  if (opts.title) heading += ` · ${opts.title}`;
  if (opts.pdfTextMark) heading += ' (PDF text)';
  return `${heading}\n${body}`;
}

/** Marks slides whose material was dropped because the whole dump hit its size cap. */
export function textOmittedNote(from: number, to: number): string {
  return `${TRUNCATED_MARK} (material of ${slideRange(from, to)} omitted for length — rely on the images)`;
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
// Course context (priming only; DESIGN §12)
// ---------------------------------------------------------------------------

export const COURSE_HEADING = '## Course context';
export const NO_SUMMARY_PLACEHOLDER = '(no summary yet)';
export const SUMMARY_OMITTED_NOTE = '(summary omitted for length)';

export function courseIntro(courseTitle: string, index: number, total: number): string {
  return `This lecture is part of the course "${courseTitle}": lecture ${index} of ${total}.`;
}

export const COURSE_LIST_HEADING = 'Lectures of the course, in order:';

export function courseListLine(index: number, title: string, relation: 'earlier' | 'current' | 'later'): string {
  const mark = relation === 'current' ? '  ← this lecture' : relation === 'later' ? '  (later lecture)' : '';
  return `${index}. ${title}${mark}`;
}

export const EARLIER_LECTURES_HEADING = 'Summaries of the earlier lectures (oldest first):';

/** One earlier lecture: "### Lecture i: <title>\n<summary>". */
export function earlierLectureSection(index: number, title: string, body: string): string {
  return `### Lecture ${index}: ${title}\n${body}`;
}

export const LATER_LECTURES_NOTE =
  'Lectures after this one are listed by title only; the student has probably not studied them yet.';

export interface CourseFileRef {
  index: number;
  title: string;
  /** Relative path of DIGEST.md, or null when the lecture has no complete digest. */
  digest: string | null;
  /** Relative paths of the first/last extracted text files (used when there is no digest). */
  firstText: string;
  lastText: string;
  firstSlide: string;
  lastSlide: string;
  pageCount: number;
}

function fileRange(first: string, last: string, count: number): string {
  return count <= 1 ? first : `${first} … ${last}`;
}

/** CLI providers only: where the other lectures' files are, relative to the working directory. */
export function courseFilesNote(files: CourseFileRef[]): string {
  const lines = files.map((f) => {
    const slides = `${fileRange(f.firstSlide, f.lastSlide, f.pageCount)} (slide images)`;
    const material = f.digest
      ? `${f.digest} (per-slide transcription)`
      : `no digest yet — ${fileRange(f.firstText, f.lastText, f.pageCount)} (extracted text)`;
    return `- Lecture ${f.index} "${f.title}": ${material}; ${slides}`;
  });
  return [
    'Files of the other lectures are readable (paths relative to your working directory):',
    ...lines,
    'Open them when the student refers to earlier material and a summary is not enough. Do not create or modify any files.',
  ].join('\n');
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
// Focus (the slide the student is looking at, plus its neighbours) and the question itself
// ---------------------------------------------------------------------------

export function focusLine(slide: number, pageCount: number): string {
  return `The student is currently looking at slide ${slide} of ${pageCount}.`;
}

/** Explains why neighbouring slides are included (only when the window has more than one slide). */
export function neighborsLine(from: number, to: number, slide: number): string {
  return (
    `Slides ${from}–${to} are included for context because lecture slides often continue across pages; ` +
    `answer about slide ${slide} unless asked otherwise.`
  );
}

/** Label line that starts each slide of the focus window. */
export function windowSlideLabel(slide: number, current: boolean): string {
  return current ? `[Slide ${slide} — CURRENT]` : `[Slide ${slide}]`;
}

/** Text line placed immediately before a slide's full-resolution image. */
export function focusImageLine(slide: number): string {
  return `Full-resolution image of slide ${slide}:`;
}

/** Label carried by a full-resolution slide image part. */
export function focusImageLabel(slide: number): string {
  return `Slide ${slide}`;
}

export function focusTextBlock(slide: number, body: string): string {
  return `Extracted text of slide ${slide}:\n${body}`;
}

export function focusDigestBlock(slide: number, title: string, body: string): string {
  const titleLine = title ? `Title: ${title}\n` : '';
  return `Digest of slide ${slide} (transcribed earlier from the slide image):\n${titleLine}${body}`;
}

export function focusReusedLine(slide: number): string {
  return `(Slide ${slide}'s full-resolution image was already provided earlier in this conversation.)`;
}

export function questionBlock(slide: number, question: string): string {
  return `Student's question (about slide ${slide}):\n${question}`;
}

const PRIME_TASK =
  'Task: read the whole deck above. Then reply with a short overview of it: 3–6 bullet points, one line each, ' +
  'citing slides as (p.N). Write in Korean unless the deck is clearly meant for another language, ' +
  'keeping technical terms in their original language where natural. ';

/** Added to the prime instruction when earlier lectures of the course were provided. */
export const PRIME_COURSE_NOTE =
  'Earlier lectures of the course were summarised above: make one of the bullets say how this lecture builds on them (name the lecture). ';

const PRIME_FINISH = 'Finish with one short sentence saying you are ready for questions about any slide.';

/** Instruction for the automatic first turn that feeds the deck (kind === 'prime'). */
export function primeInstruction(hasEarlierLectures: boolean): string {
  return PRIME_TASK + (hasEarlierLectures ? PRIME_COURSE_NOTE : '') + PRIME_FINISH;
}

/** The prime instruction for a document that is not in a course (or is its first lecture). */
export const PRIME_INSTRUCTION = primeInstruction(false);
