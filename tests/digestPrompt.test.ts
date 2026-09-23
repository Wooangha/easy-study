// Tests for server/digestPrompt.ts (digest prompts and lenient output parsing).
// Run: node --test tests/digestPrompt.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DigestSlide } from '../shared/types.ts';
import type { Part } from '../server/providers/types.ts';
import {
  DIGEST_BATCH_SIZE,
  DIGEST_FAILED_PLACEHOLDER,
  buildDigestBatchParts,
  buildLectureSummaryParts,
  digestSystemPrompt,
  lectureSummarySystemPrompt,
  parseDigestOutput,
} from '../server/digestPrompt.ts';
import { TRUNCATED_MARK } from '../server/prompts.ts';

const DIR = '/library/l7-parsing-abc123';
const img = (n: number) => `${DIR}/slides/${String(n).padStart(3, '0')}.png`;

function texts(parts: Part[]): string[] {
  return parts.filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text').map((p) => p.text);
}

const ok = (slide: number, title: string, markdown: string): DigestSlide => ({ slide, title, markdown });
const failed = (slide: number, title = ''): DigestSlide => ({ slide, title, markdown: DIGEST_FAILED_PLACEHOLDER, failed: true });

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('digest prompts', () => {
  test('batch size', () => {
    assert.equal(DIGEST_BATCH_SIZE, 4);
  });

  test('the system prompt demands a faithful transcription in the exact output format', () => {
    const p = digestSystemPrompt();
    assert.equal(p, digestSystemPrompt(), 'deterministic');
    assert.match(p, /<<<SLIDE n>>>\nTITLE: /);
    assert.match(p, /ORIGINAL language \(never translate/);
    assert.match(p, /LaTeX: inline \$\.\.\.\$, display \$\$\.\.\.\$\$/);
    assert.match(p, /Markdown tables/);
    assert.match(p, /fenced code blocks/);
    assert.match(p, /every arrow \(from → to/);
    assert.match(p, /"핵심:"/);
    assert.match(p, /in Korean/);
    assert.match(p, /Never invent content/);
    assert.match(p, /\[illegible\]/);
    assert.match(p, /Do not run tools or commands/);
    assert.match(p, /never \\\( \\\) or \\\[ \\\]/);
  });

  test('batch parts: each image right after its label, then its extracted text; closing instruction', () => {
    const parts = buildDigestBatchParts({
      deckTitle: 'L7 Parsing 3',
      pageCount: 49,
      courseTitle: 'Compiler',
      slides: [
        { slide: 6, imagePath: img(6), text: '' },
        { slide: 5, imagePath: img(5), text: 'Predictive   \r\n\r\n\r\nParsing                    x ∈ FIRST(α)' },
      ],
    });
    assert.deepEqual(
      parts.map((p) => p.type),
      ['text', 'image', 'text', 'image', 'text'],
    );
    const images = parts.filter((p): p is Extract<Part, { type: 'image' }> => p.type === 'image');
    assert.deepEqual(
      images.map((i) => [i.path, i.detail, i.label]),
      [
        [img(5), 'high', 'Slide 5'],
        [img(6), 'high', 'Slide 6'],
      ],
    );
    const [first, second, last] = texts(parts);
    assert.ok(first.startsWith('# Lecture deck: "L7 Parsing 3" (course "Compiler") · 49 slides\nThis batch: slides 5–6.'));
    assert.ok(first.endsWith('## Slide 5 of 49\nFull-resolution image of slide 5:'));
    assert.ok(second.startsWith('<extracted_text slide="5">\nPredictive\n\nParsing    x ∈ FIRST(α)\n</extracted_text>'));
    assert.ok(second.endsWith('## Slide 6 of 49\nFull-resolution image of slide 6:'));
    assert.ok(last.startsWith('(slide 6 has no extractable text — read everything from the image)'));
    assert.match(last, /exactly 2 blocks \(<<<SLIDE 5>>>, <<<SLIDE 6>>>\)/);
    assert.match(last, /"핵심:" line in Korean/);
  });

  test('batch parts: no course, one slide, long text capped', () => {
    const parts = buildDigestBatchParts({
      deckTitle: 'Deck',
      pageCount: 1,
      courseTitle: null,
      slides: [{ slide: 1, imagePath: img(1), text: 'z'.repeat(10_000) }],
    });
    const [first, last] = texts(parts);
    assert.ok(first.startsWith('# Lecture deck: "Deck" · 1 slide\nThis batch: slide 1.'));
    assert.ok(last.includes(`${'z'.repeat(6000)}${TRUNCATED_MARK}\n</extracted_text>`));
    assert.match(last, /exactly 1 block \(<<<SLIDE 1>>>\)/);
  });

  test('the lecture summary prompt asks for a short Korean summary with notation and connections', () => {
    const p = lectureSummarySystemPrompt();
    assert.match(p, /Write in Korean, at most about 1500 characters/);
    assert.match(p, /주제/);
    assert.match(p, /LaTeX/);
    assert.match(p, /알고리즘/);
    assert.match(p, /연결/);
    assert.match(p, /LATER lectures/);
    assert.match(p, /do not add outside material/);
  });

  test('lecture summary parts: one text part with every usable digest entry in order', () => {
    const parts = buildLectureSummaryParts({
      deckTitle: 'L7 Parsing 3',
      courseTitle: 'Compiler',
      digest: [
        ok(2, 'FIRST sets', '## Definition\n$\\mathrm{FIRST}(\\alpha)$\n\n핵심: 정의'),
        failed(3),
        ok(1, '', 'Title slide\n\n핵심: 소개'),
      ],
    });
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
    const text = (parts[0] as { text: string }).text;
    assert.ok(text.startsWith('# Lecture "L7 Parsing 3" of the course "Compiler"'));
    assert.ok(text.indexOf('### Slide 1\nTitle slide') < text.indexOf('### Slide 2 · FIRST sets\n##### Definition'));
    assert.doesNotMatch(text, /### Slide 3/);
    assert.doesNotMatch(text, /만들지 못했습니다/);
    assert.match(text, /Now write the lecture summary/);

    const empty = buildLectureSummaryParts({ deckTitle: 'D', digest: [] });
    assert.match((empty[0] as { text: string }).text, /\(the digest is empty\)/);
  });
});

// ---------------------------------------------------------------------------
// parseDigestOutput
// ---------------------------------------------------------------------------

describe('parseDigestOutput', () => {
  test('well-formed output', () => {
    const output = [
      '<<<SLIDE 5>>>',
      'TITLE: Predictive Parsing',
      '- A grammar is $LL(1)$ if …',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '핵심: LL(1) 조건을 설명한다.',
      '<<<SLIDE 6>>>',
      'TITLE: Example',
      '```',
      'Goal -> SheepNoise',
      '```',
      '',
      '핵심: 예시.',
    ].join('\n');
    assert.deepEqual(parseDigestOutput(output, [5, 6]), [
      ok(5, 'Predictive Parsing', '- A grammar is $LL(1)$ if …\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n핵심: LL(1) 조건을 설명한다.'),
      ok(6, 'Example', '```\nGoal -> SheepNoise\n```\n\n핵심: 예시.'),
    ]);
  });

  test('tolerates a preamble, decorated markers, CRLF and "Slide" casing', () => {
    const output = [
      "Sure! Here is the digest you asked for. I'll use <<<SLIDE n>>> markers.",
      '',
      '**<<<SLIDE 1>>>**',
      'TITLE: One',
      'body 1',
      '<<< Slide 2 >>>',
      'TITLE: Two',
      'body 2',
      '`<<<slide #3>>>`',
      'TITLE: Three',
      'body 3',
      '### <<<SLIDE: 4>>>',
      'TITLE: Four',
      'body 4',
    ].join('\r\n');
    assert.deepEqual(parseDigestOutput(output, [1, 2, 3, 4]), [
      ok(1, 'One', 'body 1'),
      ok(2, 'Two', 'body 2'),
      ok(3, 'Three', 'body 3'),
      ok(4, 'Four', 'body 4'),
    ]);
  });

  test('a code fence around the whole output or around one block is removed', () => {
    const wrapped = ['```markdown', '<<<SLIDE 1>>>', 'TITLE: A', 'a', '<<<SLIDE 2>>>', 'TITLE: B', '```c', 'int x;', '```', 'b', '```'].join('\n');
    assert.deepEqual(parseDigestOutput(wrapped, [1, 2]), [ok(1, 'A', 'a'), ok(2, 'B', '```c\nint x;\n```\nb')]);

    const perBlock = ['<<<SLIDE 1>>>', '```', 'TITLE: A', 'a', '```', '<<<SLIDE 2>>>', 'TITLE: B', '```markdown', 'b', '```'].join('\n');
    assert.deepEqual(parseDigestOutput(perBlock, [1, 2]), [ok(1, 'A', 'a'), ok(2, 'B', 'b')]);
  });

  test('TITLE is optional and its value is cleaned', () => {
    const output = [
      '<<<SLIDE 1>>>',
      'no title line here',
      '<<<SLIDE 2>>>',
      '**TITLE:** Bold title',
      'x',
      '<<<SLIDE 3>>>',
      'Title: **Starred**',
      'y',
      '<<<SLIDE 4>>>',
      'TITLE: (none)',
      'z',
      '<<<SLIDE 5>>>',
      'TITLE:',
      'w',
      '<<<SLIDE 6>>> TITLE: Same line',
      'v',
      '<<<SLIDE 7>>>',
      '제목： 예제',
      'u',
    ].join('\n');
    assert.deepEqual(parseDigestOutput(output, [1, 2, 3, 4, 5, 6, 7]), [
      ok(1, '', 'no title line here'),
      ok(2, 'Bold title', 'x'),
      ok(3, 'Starred', 'y'),
      ok(4, '', 'z'),
      ok(5, '', 'w'),
      ok(6, 'Same line', 'v'),
      ok(7, '예제', 'u'),
    ]);
  });

  test('duplicated markers: the last block with content wins', () => {
    const output = ['<<<SLIDE 1>>>', 'TITLE: Old', 'old', '<<<SLIDE 2>>>', 'TITLE: B', 'b', '<<<SLIDE 1>>>', 'TITLE: New', 'new', '<<<SLIDE 2>>>', ''].join('\n');
    assert.deepEqual(parseDigestOutput(output, [1, 2]), [ok(1, 'New', 'new'), ok(2, 'B', 'b')]);
  });

  test('missing slides fail with a placeholder; unexpected numbers are ignored; order is ascending', () => {
    const output = ['<<<SLIDE 9>>>', 'TITLE: Unexpected', 'must not leak', '<<<SLIDE 7>>>', 'TITLE: Seven', 'seven', '<<<SLIDE 99>>>', 'also dropped', '<<<SLIDE 8>>>', 'TITLE: Only a title'].join('\n');
    const parsed = parseDigestOutput(output, [8, 7, 6, 7]);
    assert.deepEqual(parsed, [failed(6), ok(7, 'Seven', 'seven'), failed(8, 'Only a title')]);
    assert.ok(parsed.every((e) => !e.markdown.includes('must not leak') && !e.markdown.includes('also dropped')));
  });

  test('empty or marker-less output', () => {
    assert.deepEqual(parseDigestOutput('', [1, 2]), [failed(1), failed(2)]);
    assert.deepEqual(parseDigestOutput('I cannot see any image.', [3]), [failed(3)]);
    // One expected slide answered without a marker but in the right shape.
    assert.deepEqual(parseDigestOutput('Here you go:\nTITLE: Alone\nbody\n\n핵심: 요점', [4]), [ok(4, 'Alone', 'body\n\n핵심: 요점')]);
    // With several expected slides a marker-less answer cannot be attributed.
    assert.deepEqual(parseDigestOutput('TITLE: X\nbody', [1, 2]), [failed(1), failed(2)]);
  });

  test('separators and whitespace are cleaned; an unclosed code fence is closed; headings are kept', () => {
    const output = [
      '<<<SLIDE 1>>>',
      'TITLE: A',
      '## Sub heading',
      'line   ',
      '',
      '',
      '',
      'more',
      '---',
      '',
      '<<<SLIDE 2>>>',
      'TITLE: B',
      '```python',
      'def f():',
      '    return 1',
    ].join('\n');
    assert.deepEqual(parseDigestOutput(output, [1, 2]), [
      ok(1, 'A', '## Sub heading\nline\n\nmore'),
      ok(2, 'B', '```python\ndef f():\n    return 1\n```'),
    ]);
  });
});
