// The app frame's texts in both languages (DESIGN §27): top bar, library organizing and its screen-reader
// announcements, login, update banner. Korean is the reference (the other tests pin it); here the particles and rich
// texts it builds, and the English texts in use.
// Run: node --test web/tests/*.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Course, LibraryLayout } from '../../shared/types.ts';
import { msg, setLang } from '../src/i18n/index.ts';
import { formatWait } from '../src/lib/auth.ts';
import { describePlace, describeTarget, resolveDrop, type OrgView } from '../src/lib/libraryDnd.ts';
import { createOrganizer, type OrganizerApi } from '../src/lib/organizer.ts';

const html = (node: ReactNode) => renderToStaticMarkup(createElement('p', null, node));
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The login screen's hint, with stand-ins for its elements (the settings icon is an <i>). */
const codeWhere = () => {
  const m = msg().shell.auth;
  return html(
    m.codeWhere(
      createElement('strong', null, m.codeWhereServer),
      createElement('i'),
      createElement('code', null, 'npm run start:remote'),
      createElement('code', null, '…/login?code=…'),
    ),
  );
};

// c1 (a, b, c) at the top level, then the group g1 with c2 (d, e) and c3 (empty).
const course = (id: string, docIds: string[]): Course => ({ id, title: id.toUpperCase(), createdAt: '2026-09-01T00:00:00Z', docIds });
const courses = [course('c1', ['a', 'b', 'c']), course('c2', ['d', 'e']), course('c3', [])];
const layout: LibraryLayout = {
  groups: [{ id: 'g1', title: 'Fall 2026', createdAt: '2026-09-04T00:00:00Z', courseIds: ['c2', 'c3'] }],
  order: [
    { type: 'course', id: 'c1' },
    { type: 'group', id: 'g1' },
  ],
};
const view = (collapsed: string[] = []): OrgView => ({ courses, layout, isCollapsed: (k) => collapsed.includes(k) });

describe('shell texts in Korean (the reference)', () => {
  test('particles follow the title, as before', () => {
    const m = msg().shell;
    assert.equal(m.app.deleteDocConfirm.title('Lecture 3'), '‘Lecture 3’을 삭제할까요?');
    assert.equal(m.course.deleteConfirm.title('OS'), '과목 ‘OS’을(를) 삭제할까요?');
    assert.equal(m.group.deleteConfirm.title('2학기'), '그룹 ‘2학기’를 삭제할까요?');
    assert.equal(m.dnd.pickedUp(m.dnd.lectureName('L3')), '‘L3’ 강의를 집었어요. 위아래 화살표로 옮기고 스페이스나 엔터로 놓으세요.');
    assert.equal(m.dnd.cancelled(m.dnd.courseName('OS')), '옮기기를 취소했어요. ‘OS’ 과목은 원래 자리에 있어요.');
    assert.equal(m.dnd.moved(m.dnd.lectureName('L3'), '‘C2’ 과목의 3번째 자리', 3), '‘L3’ 강의를 ‘C2’ 과목의 3번째 자리로 옮겼어요 (3개 중).');
    assert.equal(m.dnd.moved(m.dnd.groupName('2학기'), '미분류', null), '‘2학기’ 그룹을 미분류로 옮겼어요.');
    assert.equal(
      m.app.addedKeptOpen(2, 'x', 'OS'),
      '강의 2개를 OS 과목에 추가했어요. 입력창의 첨부를 지키려고 지금 강의에 그대로 있어요 — 상단 문서 목록에서 열 수 있어요.',
    );
    assert.equal(
      m.app.addedKeptOpen(1, 'L3', null),
      '‘L3’ 강의를 추가했어요. 입력창의 첨부를 지키려고 지금 강의에 그대로 있어요 — 상단 문서 목록에서 열 수 있어요.',
    );
  });

  test('rich texts render the elements where the sentence has them', () => {
    assert.equal(
      codeWhere(),
      '<p>접속 코드는 <strong>easy-study 서버를 실행한 컴퓨터</strong>에 표시돼요 — easy-study 앱이면 <i></i> 설정 › 데스크톱 앱 › 다른 기기에서 접속, 터미널이면 <code>npm run start:remote</code>의 출력. 터미널에 함께 나온 로그인 링크(<code>…/login?code=…</code>)를 열어도 바로 들어올 수 있어요.</p>',
    );
    const c = msg().shell.course;
    assert.equal(
      html(c.makeDigests(createElement('span', { className: 'hide-narrow' }, c.makeDigestsWide), 3)),
      '<p>정리본 <span class="hide-narrow">없는 강의 </span>3개 만들기</p>',
    );
  });
});

describe('shell texts in English', () => {
  afterEach(() => setLang('system'));

  test('counts with plurals', () => {
    setLang('en');
    const m = msg().shell;
    assert.equal(m.course.lectureCount(1), '1 lecture');
    assert.equal(m.course.lectureCount(3), '3 lectures');
    assert.equal(m.group.courseCount(0), '0 courses');
    assert.equal(m.library.slideCount(1), '1 slide');
    assert.equal(m.library.summary.digestsTitle(1, 1), '1 of 1 lecture has a digest');
    assert.equal(m.library.summary.digestsTitle(2, 5), '2 of 5 lectures have a digest');
    assert.equal(m.app.addedToCourse('OS', 1), 'Added 1 lecture to OS');
    assert.equal(m.app.digestConfirm.title(3, 'Codex'), 'Make the digests of 3 lectures with Codex?');
    assert.equal(m.llm.effortOption('high'), 'High reasoning');
    assert.equal(
      html(m.course.makeDigests(createElement('span', { className: 'hide-narrow' }, m.course.makeDigestsWide), 1)),
      '<p>Make 1 <span class="hide-narrow">missing </span>digest</p>',
    );
  });

  test('the login wait (formatWait)', () => {
    setLang('en');
    assert.equal(formatWait(1), '1 sec');
    assert.equal(formatWait(45), '45 sec');
    assert.equal(formatWait(60), '1 min');
    assert.equal(formatWait(552), '9 min 12 sec');
    assert.equal(formatWait(3900), '1 hr 5 min');
    assert.equal(formatWait(7200), '2 hr');
    assert.equal(msg().shell.auth.tooManyAttemptsWait(formatWait(552)), 'Too many login attempts. Try again in 9 min 12 sec.');
  });

  test('drag & drop announcements say where the item lands', () => {
    setLang('en');
    const d = msg().shell.dnd;
    const lecture = { kind: 'lecture' as const, docId: 'a' };
    const t = resolveDrop(lecture, { role: 'course-body', courseId: 'c2' }, 0.9, view());
    assert.deepEqual(describeTarget(t!, view()), { place: 'position 3 in the course ‘C2’', total: 3 });
    assert.equal(describePlace(t!, view()), 'position 3 in the course ‘C2’ (of 3)');
    const { place, total } = describeTarget(t!, view());
    assert.equal(d.moved(d.lectureName('L3'), place, total), 'Moved the lecture ‘L3’ to position 3 in the course ‘C2’ (of 3).');

    const out = resolveDrop(lecture, { role: 'uncategorized' }, 0.5, view());
    assert.equal(describePlace(out!, view()), 'Uncategorized');
    assert.equal(describePlace({ key: 'noop', move: null, indicator: null }, view()), 'its original place');
    const head = resolveDrop(lecture, { role: 'group-head', groupId: 'g1' }, 0.5, view(['group:g1']));
    assert.equal(describePlace(head!, view(['group:g1'])), 'over the collapsed group ‘Fall 2026’ — it opens in a moment');
    const c3 = resolveDrop({ kind: 'course', courseId: 'c3' }, { role: 'group-head', groupId: 'g1' }, 0.1, view());
    assert.equal(describePlace(c3!, view()), 'position 2 outside the groups (of 3)');
    const g1 = resolveDrop({ kind: 'group', groupId: 'g1' }, { role: 'course', courseId: 'c1', groupId: null }, 0.2, view());
    assert.equal(describePlace(g1!, view()), 'position 1 in the whole list (of 2)');
    assert.equal(d.cancelled(d.groupName('Fall 2026')), 'Cancelled the move; the group ‘Fall 2026’ is back in its place.');
  });

  test('saving the library: what failed and why', async () => {
    setLang('en');
    const refuse = async (): Promise<never> => {
      throw new Error('refused');
    };
    const conflict = async (): Promise<never> => {
      throw Object.assign(new Error('changed elsewhere'), { status: 409 });
    };
    /** Another device deleted the group (this tab learns it when it loads the lists again). */
    let groupGone = false;
    const api: OrganizerApi = {
      listCourses: async () => structuredClone(courses),
      getLayout: async () => (groupGone ? { groups: [], order: courses.map((c) => ({ type: 'course' as const, id: c.id })) } : structuredClone(layout)),
      updateCourse: conflict,
      createCourse: refuse,
      deleteCourse: refuse,
      putLayout: conflict,
      createGroup: refuse,
      updateGroup: refuse,
      deleteGroup: refuse,
    };
    const errors: string[] = [];
    const org = createOrganizer({
      api,
      notifyError: (m) => errors.push(m),
      errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
      isConflict: (e) => (e as { status?: unknown }).status === 409,
    });
    await org.refresh();
    assert.equal(await org.moveLecture('a', 'c3', null), false);
    await settle();
    assert.equal(await org.renameGroup('g1', 'x'), false);
    await settle();
    groupGone = true;
    assert.equal(await org.moveCourse('c1', 'g1', null), false);
    await settle();
    await settle();
    assert.deepEqual(errors, [
      "Couldn't move the lecture, so it was put back: Another tab or device changed this first. The lists are reloaded, so try again",
      "Couldn't rename the group: refused",
      "Couldn't move the course, so it was put back: The group to move it to was deleted elsewhere",
    ]);
  });

  test('rich texts keep their elements, with no Korean left', () => {
    setLang('en');
    assert.equal(
      codeWhere(),
      '<p>The access code is shown on <strong>the computer running the easy-study server</strong> — in the easy-study app under <i></i> Settings › Desktop app › Access from other devices; in a terminal, in the output of <code>npm run start:remote</code>. You can also open the login link printed with it (<code>…/login?code=…</code>) to log in right away.</p>',
    );
    const app = msg().shell.app;
    assert.equal(
      html(app.dropPdfToCourse(createElement('b'), createElement('i'), 'Compiler')),
      '<p><b></b> Drop PDFs to add them as lectures to <i></i> Compiler</p>',
    );
  });
});
