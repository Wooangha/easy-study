// The settings area in English (DESIGN §27): the desktop bridge's wording (web/src/lib/desktop.ts), the settings and
// common texts against the Korean reference, and no Korean text left in the settings area's code.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hangulIn, shapeProblems } from '../../tests/i18nParity.ts';
import { en } from '../src/i18n/en/index.ts';
import { getLang, msg, setLang } from '../src/i18n/index.ts';
import { ko } from '../src/i18n/ko/index.ts';
import {
  NOT_BUSY,
  downloadHint,
  installBlockReason,
  installWarning,
  leaveConfirm,
  macMicHint,
  resetCodeConfirm,
  shareBlockReason,
  shareWarning,
  updateErrorText,
  updateStatusLine,
  updatedToast,
  type PageBusy,
  type UpdateState,
} from '../src/lib/desktop.ts';

const busy = (patch: Partial<PageBusy>): PageBusy => ({ ...NOT_BUSY, ...patch });
const update = (patch: Partial<UpdateState>): UpdateState => ({
  phase: 'idle',
  current: '0.5.0',
  received: 0,
  install: 'inApp',
  dismissed: false,
  ...patch,
});
const HANGUL = /[가-힯]/;

describe('the desktop bridge in English', () => {
  afterEach(() => setLang('system'));

  test('before changing the connection: the same cases as in Korean, in English', () => {
    setLang('en');
    assert.equal(leaveConfirm(NOT_BUSY), null);
    const recording = leaveConfirm(busy({ recording: true, answering: true }))!;
    assert.equal(recording.title, 'Change the connection?');
    assert.equal(recording.confirmLabel, 'Change');
    assert.match(recording.message!, /^A lecture is being recorded\./);
    assert.match(leaveConfirm(busy({ finishing: 1 }))!.message!, /^Recorded audio is still being sent/);
    assert.match(leaveConfirm(busy({ uploads: 1 }))!.message!, /^An answer is being written or a file is uploading\./);
  });

  test('updates and sharing: blocked while audio could be cut off, asked for answers and uploads', () => {
    setLang('en');
    assert.equal(installBlockReason(busy({ recording: true })), "Can't install while recording — finish the recording first.");
    assert.match(installBlockReason(busy({ unsentSeconds: 1 }))!, /you can install once it's sent/);
    assert.match(installBlockReason(busy({ recordingUploads: 1 }))!, /^A recording file is uploading/);
    assert.equal(installWarning(busy({ answering: true })), 'An answer is being written or a file is uploading. Restarting stops it. Install anyway?');
    assert.equal(shareBlockReason(busy({ recording: true })), "Can't change this while recording — finish the recording first.");
    assert.match(shareWarning(busy({ uploads: 1 }))!, /Change anyway\?$/);
    assert.equal(shareWarning(NOT_BUSY), null);
  });

  test('a new access code: what would stop is added, without the question', () => {
    setLang('en');
    const calm = resetCodeConfirm(NOT_BUSY);
    assert.equal(calm.title, 'Make a new access code?');
    assert.equal(calm.confirmLabel, 'Make new code');
    assert.doesNotMatch(calm.message!, /answer/);
    const busyReset = resetCodeConfirm(busy({ answering: true }));
    assert.match(busyReset.message!, /to make the new code\. An answer is being written or a file is uploading\. Restarting the server stops it\.$/);
    assert.doesNotMatch(busyReset.message!, /anyway/);
  });

  test('Korean is unchanged: the reset message with what would stop, as before', () => {
    assert.equal(getLang(), 'ko');
    assert.equal(
      resetCodeConfirm(busy({ answering: true })).message,
      '지금 코드로 로그인한 다른 기기는 모두 로그아웃돼요. 새 코드를 만들려고 이 컴퓨터의 서버를 한 번 다시 시작해요. 답변을 만들거나 파일을 올리는 중이에요. 서버를 다시 시작하면 멈춰요.',
    );
    assert.equal(
      macMicHint(),
      'macOS에서는 업데이트 뒤 처음 녹음할 때 마이크 권한을 다시 물을 수 있어요. 녹음이 안 되면 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 easy-study를 껐다 켜 주세요.',
    );
    assert.equal(updatedToast('0.5.1', 'macos'), `easy-study 0.5.1 버전으로 업데이트했어요. ${msg().settings.bridge.macMicFix}`);
  });

  test('the status line of each phase', () => {
    setLang('en');
    assert.equal(updateStatusLine(update({ phase: 'latest' })), "You're up to date");
    assert.equal(updateStatusLine(update({ phase: 'checking' })), 'Checking…');
    assert.equal(updateStatusLine(update({ phase: 'available', version: '0.5.1' })), 'easy-study 0.5.1 is available');
    assert.equal(updateStatusLine(update({ phase: 'downloading', received: 50, total: 200 })), 'Downloading… 25%');
    assert.equal(updateStatusLine(update({ phase: 'downloading', received: 50 })), 'Downloading…');
    assert.equal(updateStatusLine(update({ phase: 'downloaded', version: '0.5.1' })), 'easy-study 0.5.1 is downloaded');
    assert.equal(updateStatusLine(update({ phase: 'installing', version: '0.5.1' })), 'Installing easy-study 0.5.1…');
    assert.equal(updateStatusLine(update({ lastError: 'timed out' })), 'Last check failed: timed out');
    assert.equal(updateStatusLine(update({ checkedAt: '2026-09-30T00:00:00Z' })), "You're up to date");
    assert.equal(updateStatusLine(update({})), 'Not checked yet');
  });

  test("the shell's errors: prefixed unless they say so themselves, in either language (the shell speaks the computer's)", () => {
    setLang('en');
    assert.equal(updateErrorText(update({ phase: 'error', error: 'timed out' })), "Couldn't update: timed out");
    assert.equal(updateErrorText(update({ phase: 'error' })), "Couldn't update: Unknown error");
    for (const itself of [
      "The update didn't finish (still 0.5.0). Install it from the download page.",
      "Couldn't update. Try again in a moment.",
      '업데이트가 끝나지 않았어요 (지금 0.5.0). 다운로드 페이지에서 직접 설치해 주세요.',
      '업데이트하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
    ]) {
      assert.equal(updateErrorText(update({ phase: 'error', error: itself })), itself);
    }
    setLang('system');
    assert.equal(updateErrorText(update({ phase: 'error', error: "Couldn't update. Try again in a moment." })), "Couldn't update. Try again in a moment.");
    assert.equal(updateErrorText(update({ phase: 'error', error: 'timed out' })), '업데이트하지 못했어요: timed out');
  });

  test('the download-page hint and the toast after an update', () => {
    setLang('en');
    assert.equal(downloadHint(update({ install: 'download', kind: 'deb' })), 'With this install type (deb), download and install the new package.');
    assert.match(downloadHint(update({ install: 'download', kind: 'arch' })), /\(Arch\).*makepkg -si with the release's PKGBUILD/);
    assert.equal(downloadHint(update({ install: 'download', kind: 'app' })), 'Download and install the new version from the download page.');
    assert.equal(downloadHint(update({ install: 'download', reason: 'Move the app first.' })), 'Move the app first.', "the shell's reason as it is");
    assert.equal(updatedToast('0.5.1', 'windows'), 'Updated to easy-study 0.5.1.');
    assert.match(updatedToast('0.5.1', 'macos'), /^Updated to easy-study 0\.5\.1\. If recording doesn't work, .* Microphone\.$/);
    assert.match(macMicHint(), /^macOS may ask for microphone permission again/);
  });
});

describe('settings and common texts', () => {
  afterEach(() => setLang('system'));

  test('English has the same keys and no Korean', () => {
    assert.deepEqual(shapeProblems(ko.settings, en.settings), []);
    assert.deepEqual(shapeProblems(ko.common, en.common), []);
    assert.deepEqual(hangulIn(en.settings), []);
    assert.deepEqual(hangulIn(en.common), []);
  });

  test('plurals and the section names', () => {
    setLang('en');
    const m = msg().settings;
    assert.equal(m.study.neighborsCount(1), '1 slide on each side');
    assert.equal(m.study.neighborsCount(3), '3 slides on each side');
    assert.deepEqual(Object.values(m.dialog.sections), ['Display', 'Study', 'Recording', 'Desktop app', 'About']);
    setLang('system');
    assert.equal(msg().settings.study.neighborsCount(2), '앞뒤 2장');
    assert.deepEqual(Object.values(msg().settings.dialog.sections), ['화면', '공부', '녹음', '데스크톱 앱', '정보']);
  });
});

describe('the settings area keeps its texts in the messages', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  /** The code of a file without its comments (block, line and JSX comments). */
  const code = (file: string) =>
    readFileSync(path.join(src, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  for (const file of ['components/SettingsDialog.tsx', 'components/ConfirmDialog.tsx', 'lib/desktop.ts', 'lib/theme.ts', 'main.tsx']) {
    test(`${file}: no Korean outside comments`, () => {
      const lines = code(file)
        .split('\n')
        // Recognizing the shell's own Korean wording is logic, not a text shown.
        .filter((line) => HANGUL.test(line) && !line.includes('SAYS_UPDATE_FAILED'));
      assert.deepEqual(lines, []);
    });
  }
});
