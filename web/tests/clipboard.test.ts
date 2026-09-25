// The 복사 buttons (web/src/lib/clipboard.ts): the Clipboard API where the page may use it, and the
// hidden-<textarea> fallback over plain HTTP from another computer (remote mode, DESIGN §16), where
// navigator.clipboard is undefined. Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { copyText } from '../src/lib/clipboard.ts';
import type { ClipboardEnv } from '../src/lib/clipboard.ts';

interface FakePage {
  document: NonNullable<ClipboardEnv['document']>;
  /** What execCommand('copy') copied, per call. */
  copied: string[];
  commands: string[];
  /** Text areas still in the page. */
  attached: number;
  focusRestored: number;
}

/** A page whose execCommand('copy') answers `result` (or throws). */
function fakePage(result: boolean | 'throw'): FakePage {
  const page: FakePage = { document: null as never, copied: [], commands: [], attached: 0, focusRestored: 0 };
  let selected = '';
  const makeArea = () => {
    const area = {
      value: '',
      style: {} as Record<string, string>,
      attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) {
        area.attributes[name] = value;
      },
      select() {
        selected = area.value;
      },
      setSelectionRange(start: number, end: number) {
        selected = area.value.slice(start, end);
      },
      remove() {
        page.attached--;
      },
    };
    return area;
  };
  page.document = {
    body: {
      appendChild(node: unknown) {
        page.attached++;
        return node;
      },
    },
    activeElement: {
      focus() {
        page.focusRestored++;
      },
    },
    createElement(tag: string) {
      assert.equal(tag, 'textarea');
      return makeArea();
    },
    execCommand(command: string) {
      page.commands.push(command);
      if (result === 'throw') throw new Error('SecurityError');
      if (result) page.copied.push(selected);
      return result;
    },
  } as unknown as FakePage['document'];
  return page;
}

function fakeClipboard(fails = false) {
  const written: string[] = [];
  return {
    written,
    clipboard: {
      writeText: async (text: string) => {
        if (fails) throw new Error('NotAllowedError');
        written.push(text);
      },
    },
  };
}

describe('copyText', () => {
  const text = '## 답변\n\n$E = mc^2$ — 한글과 수식';

  test('secure context (HTTPS, localhost): the Clipboard API, no fallback', async () => {
    const page = fakePage(true);
    const { clipboard, written } = fakeClipboard();
    await copyText(text, { clipboard, secure: true, document: page.document });
    assert.deepEqual(written, [text]);
    assert.deepEqual(page.commands, []);
  });

  test('plain HTTP from another computer (no navigator.clipboard): copied through a hidden text area', async () => {
    const page = fakePage(true);
    await copyText(text, { clipboard: undefined, secure: false, document: page.document });
    assert.deepEqual(page.commands, ['copy']);
    assert.deepEqual(page.copied, [text], 'the whole text was selected and copied');
    assert.equal(page.attached, 0, 'the text area is removed again');
    assert.equal(page.focusRestored, 1, 'focus goes back to the button');
  });

  test('not a secure context: the API is not used even if present', async () => {
    const page = fakePage(true);
    const { clipboard, written } = fakeClipboard();
    await copyText(text, { clipboard, secure: false, document: page.document });
    assert.deepEqual(written, []);
    assert.deepEqual(page.copied, [text]);
  });

  test('the Clipboard API refuses (permission, focus): the fallback still copies', async () => {
    const page = fakePage(true);
    const { clipboard } = fakeClipboard(true);
    await copyText(text, { clipboard, secure: true, document: page.document });
    assert.deepEqual(page.copied, [text]);
  });

  test('nothing could be copied: rejects, so the caller shows its failure message', async () => {
    for (const result of [false, 'throw'] as const) {
      const page = fakePage(result);
      await assert.rejects(copyText(text, { clipboard: undefined, secure: false, document: page.document }), String(result));
      assert.equal(page.attached, 0, `${result}: the text area is removed`);
    }
    await assert.rejects(copyText(text, { clipboard: undefined, secure: false, document: null }));
    const { clipboard } = fakeClipboard(true);
    await assert.rejects(copyText(text, { clipboard, secure: true, document: null }));
  });

  test('outside a browser (no window, no document): rejects instead of throwing synchronously', async () => {
    await assert.rejects(copyText(text));
  });
});
