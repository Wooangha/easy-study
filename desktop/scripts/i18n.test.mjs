// The desktop app's languages (DESIGN §27): the shell's texts (src-tauri/src/i18n/*.rs) and the chooser's (ui/texts.js)
// in Korean (the reference) and English, and the chooser's use of them. The Rust side is checked by cargo test too
// (a text missing in a language does not compile).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(DESKTOP_DIR, 'ui');
const SRC = path.join(DESKTOP_DIR, 'src-tauri', 'src');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/;

/** texts.js's CHOOSER_TEXTS, evaluated like the page does (a classic script). */
function chooserTexts() {
  return vm.runInNewContext(`${read(UI, 'texts.js')}\n;CHOOSER_TEXTS`, {});
}

/** Every leaf of a texts object: [dotted key, value]. Rich texts (arrays) and functions are leaves. */
function leaves(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) => {
    const at = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value) ? leaves(value, at) : [[at, value]];
  });
}

const kind = (value) => (Array.isArray(value) ? 'rich' : typeof value);
const slotsOf = (rich) => rich.filter((part) => part && typeof part === 'object' && part.slot).map((part) => part.slot).sort();

/** Sample values for a text function (versions, counts, addresses). */
const sampleArgs = (fn) => Array.from({ length: fn.length }, (_, i) => ['0.7.0', '42%', 'http://192.168.0.10:5180'][i] ?? 'x');

/** What a text shows (functions called with samples, rich text flattened). */
function shown(value) {
  if (typeof value === 'function') return String(value(...sampleArgs(value)));
  if (Array.isArray(value)) return value.map((part) => (typeof part === 'string' ? part : part.b ?? part.code ?? '')).join('');
  return String(value);
}

/** Source without comments (line comments, block comments, HTML comments): what the user can see. */
const withoutComments = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');

test('chooser texts: English has exactly the Korean keys, kinds and element slots', () => {
  const { ko, en, ...others } = chooserTexts();
  assert.deepEqual(Object.keys(others), [], 'only ko and en (add a language here and in i18n.rs together)');
  const koLeaves = new Map(leaves(ko));
  const enLeaves = new Map(leaves(en));
  assert.deepEqual([...enLeaves.keys()].sort(), [...koLeaves.keys()].sort());
  for (const [key, value] of koLeaves) {
    const other = enLeaves.get(key);
    assert.equal(kind(other), kind(value), key);
    if (typeof value === 'function') assert.equal(other.length, value.length, `${key}: the same values`);
    // Rich text: every element of the page it holds (a slot) exactly once in every language, or it would vanish.
    if (Array.isArray(value)) assert.deepEqual(slotsOf(other), slotsOf(value), key);
    assert.ok(shown(value).trim() !== '' && shown(other).trim() !== '', key);
  }
});

test('chooser texts: no Korean in the English ones', () => {
  for (const [key, value] of leaves(chooserTexts().en)) assert.doesNotMatch(shown(value), HANGUL, key);
});

test('the chooser page: every text is looked up, none is written in index.html or chooser.js', () => {
  const html = read(UI, 'index.html');
  const js = read(UI, 'chooser.js');
  const { ko } = chooserTexts();
  const koLeaves = new Map(leaves(ko));
  const htmlKeys = [...withoutComments(html).matchAll(/data-t(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(htmlKeys.length >= 40, `${htmlKeys.length} keys`);
  for (const key of htmlKeys) {
    assert.ok(koLeaves.has(key), `index.html names ${key}`);
    assert.notEqual(typeof koLeaves.get(key), 'function', `${key} needs values: set it from chooser.js`);
  }
  // The slots a rich text moves into place are elements of the page (inside the element it fills).
  for (const [key, value] of koLeaves) {
    for (const id of Array.isArray(value) ? slotsOf(value) : []) {
      const holder = new RegExp(`data-t="${key.replace('.', '\\.')}"[^>]*>(?:(?!</p>|</footer>)[\\s\\S])*id="${id}"`);
      assert.match(html, holder, `${key}: #${id}`);
    }
  }
  const jsKeys = [...js.matchAll(/\bT\.([a-zA-Z]+(?:\.[a-zA-Z]+)+)/g)].map((m) => m[1]);
  assert.ok(jsKeys.length >= 25, `${jsKeys.length} keys`);
  for (const key of jsKeys) assert.ok(koLeaves.has(key), `chooser.js reads ${key}`);
  // Korean only in comments; in chooser.js also the shell's own failure prefixes (SAYS_FAILED, below).
  assert.doesNotMatch(withoutComments(html), HANGUL);
  const code = withoutComments(js)
    .split('\n')
    .filter((line) => !line.startsWith('const SAYS_FAILED ='));
  assert.doesNotMatch(code.join('\n'), HANGUL);
  // It speaks the shell's language: the marker first, then get_state.
  assert.match(js, /let lang = langOf\(window\.__EASY_STUDY_DESKTOP__\?\.lang\);/);
  assert.match(js, /if \(st\.lang\) followLang\(st\.lang\);/);
  assert.match(html, /<script src="texts\.js"><\/script>\s*<script src="chooser\.js"><\/script>/);
});

/** failed_prefixes of a language file (i18n/<lang>.rs). */
function failedPrefixes(lang) {
  const list = /failed_prefixes: &\[([^\]]*)\]/.exec(read(SRC, 'i18n', `${lang}.rs`))?.[1];
  assert.ok(list, `${lang}.rs failed_prefixes`);
  return [...list.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
}

test("the chooser knows every language's texts that say the update failed themselves (i18n.rs failed_prefixes)", () => {
  const js = read(UI, 'chooser.js');
  const source = /const SAYS_FAILED = (\/.*\/);/.exec(js)?.[1];
  assert.ok(source, 'SAYS_FAILED');
  const saysFailed = vm.runInNewContext(source);
  const prefixes = [...failedPrefixes('ko'), ...failedPrefixes('en')];
  assert.equal(prefixes.length, 4);
  for (const prefix of prefixes) assert.match(`${prefix}…`, saysFailed, prefix);
  // A text that needs the prefix gets it (update.rs MSG_NETWORK's texts).
  assert.doesNotMatch("Couldn't connect to the update server.", saysFailed);
  assert.doesNotMatch('업데이트 서버에 연결하지 못했어요.', saysFailed);
});

test("the shell's texts: English without Korean, the same fields as Korean", () => {
  const strip = (src) => src.replace(/^\s*\/\/.*$/gm, '');
  const ko = strip(read(SRC, 'i18n', 'ko.rs'));
  const en = strip(read(SRC, 'i18n', 'en.rs'));
  assert.doesNotMatch(en, HANGUL);
  const fields = (src) => [...src.matchAll(/^\s+([a-z_]+): /gm)].map((m) => m[1]);
  assert.deepEqual(fields(en), fields(ko));
  assert.ok(fields(ko).length > 150, `${fields(ko).length} fields`);
});

test("the shell tells the pages its language, and only the smoke run's own lines stay Korean", () => {
  const bridge = read(SRC, 'bridge.rs');
  const main = read(SRC, 'main.rs');
  assert.match(bridge, /pub const INIT_SCRIPT: &str =\s*"window\.__EASY_STUDY_DESKTOP__ = Object\.freeze\(\{ v: 1, version: __VERSION__, os: __OS__, lang: __LANG__ \}\);";/);
  assert.match(main, /\.initialization_script\(bridge::init_script\(&version, std::env::consts::OS, i18n::lang\(\)\.id\(\)\)\)/);
  assert.match(main, /lang: i18n::lang\(\)\.id\(\),/);
  // User-facing Korean lives in i18n/ko.rs. What remains in the other files: comments, tests, the server output the
  // shell matches (server.rs, proxy.rs) and the smoke run's output line.
  const allowed = [/PORT_TAKEN_MARK: &str = "다른 프로그램이 이미 쓰고 있어서"/, /l\.contains\("다른 프로그램이"\) && l\.contains\("쓰고 있"\)/, /smoke_say\(app, &format!\("chooser: /];
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.rs'))) {
    const src = read(SRC, file);
    const tests = src.search(/#\[cfg\(test\)\]\s*mod tests \{/);
    const code = tests === -1 ? src : src.slice(0, tests);
    for (const line of code.split('\n')) {
      // Comments (`//`, `///`, `//!`; not the `//` of "http://" in a string).
      if (!HANGUL.test(line.replace(/(^|\s)\/\/.*$/, ''))) continue;
      assert.ok(allowed.some((re) => re.test(line)), `${file}: ${line.trim()}`);
    }
  }
});

test('the Linux package description (the launcher’s Comment=, deb/rpm summary) is short and in both languages', () => {
  const { shortDescription } = JSON.parse(read(DESKTOP_DIR, 'src-tauri', 'tauri.conf.json')).bundle;
  const [korean, english] = shortDescription.split(' · ');
  assert.match(korean, HANGUL);
  assert.ok(english && /^[\x20-\x7e]+$/.test(english), shortDescription);
  assert.ok(shortDescription.length <= 80, `${shortDescription.length} characters`);
});
