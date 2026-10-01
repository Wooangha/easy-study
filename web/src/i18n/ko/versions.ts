// Korean (the reference language) — namespace `versions`: 새 버전 올리기 (DESIGN §28). The lecture menu entry, the
// 새 버전 확인 dialog, the viewer's banner and badges, the 메모 tab's 빠진 슬라이드, the chips of moved questions.
import { withParticle } from '../../lib/korean.ts';

export const versions = {
  /** The lecture menus (LectureRow, DocCard). */
  menu: '새 버전 올리기',
  menuHint: 'PDF',

  /** NewVersionDialog.tsx */
  dialog: {
    title: '새 버전 확인',
    uploading: (percent: number) => `올리는 중 ${percent}%`,
    analyzing: 'PDF 분석 중…',
    converting: (done: number, total: number) => `슬라이드 변환 중 ${done} / ${total}`,
    /** The summary chips. */
    same: (n: number) => `그대로 ${n}`,
    changed: (n: number) => `수정 ${n}`,
    added: (n: number) => `새로 ${n}`,
    removed: (n: number) => `빠짐 ${n}`,
    unchanged: '바뀐 장이 없어요',
    changedHeading: '수정된 장',
    addedHeading: '새로 생긴 장',
    removedHeading: '빠지는 장',
    /** A changed slide that was elsewhere in the order. */
    moved: '이동',
    page: (n: number) => `p.${n}`,
    oldAlt: (n: number) => `예전 슬라이드 ${n}`,
    newAlt: (n: number) => `새 슬라이드 ${n}`,
    /** What sits on the removed slides (only the non-zero counts are named). */
    keptOnRemoved: (items: number, memos: number) =>
      `빠지는 장의 ${[items > 0 ? `필기 ${items}개` : '', memos > 0 ? `메모 ${memos}개` : ''].filter(Boolean).join('·')}는 메모 탭 › 빠진 슬라이드에 보관돼요`,
    questionsMoved: (n: number) => `질문 ${n}개는 가까운 장으로 옮겨져요`,
    unrelated: '이 강의와 많이 달라요. 다른 강의 PDF가 아닌지 확인해 주세요.',
    apply: '새 버전으로 바꾸기',
    applying: '바꾸는 중…',
    gone: '새 버전을 찾을 수 없어요. 다시 올려 주세요.',
    failed: (message: string) => `새 버전을 준비하지 못했어요: ${message}`,
    applied: (title: string) => `${withParticle(`‘${title}’`, '을', '를')} 새 버전으로 바꿨어요`,
  },

  /** The viewer's banner after a swap (SlideViewer, DeckBanner.tsx) and the badges on the slides. */
  banner: {
    applied: '새 버전으로 바꿨어요',
    undone: '이전 버전으로 되돌렸어요',
    changed: (n: number) => `수정 ${n}`,
    added: (n: number) => `새로 ${n}`,
    removed: (n: number) => `빠짐 ${n}`,
    prev: '이전 바뀐 장',
    next: '다음 바뀐 장',
    undo: '되돌리기',
    dismiss: '닫기',
    undoConfirmTitle: '새 버전을 올리기 전으로 되돌릴까요?',
    undoConfirmMessage: '그 뒤에 한 필기·대화도 함께 옮겨져요.',
    undoneToast: '이전 버전으로 되돌렸어요',
    undoFailed: (message: string) => `되돌리지 못했어요: ${message}`,
    badgeChanged: '수정',
    badgeAdded: '새로',
    badgeChangedTitle: '새 버전에서 바뀐 장',
    badgeAddedTitle: '새 버전에서 새로 생긴 장',
  },

  /** The 메모 tab's 빠진 슬라이드 section (MemoListPanel). */
  removed: {
    heading: '빠진 슬라이드',
    title: '새 버전에서 빠진 장에 있던 필기와 메모 (읽기 전용)',
    oldPage: (n: number) => `예전 p.${n}`,
    thumbAlt: (n: number) => `예전 슬라이드 ${n}`,
    loadFailed: (error: string) => `빠진 슬라이드를 불러오지 못했어요: ${error}`,
  },

  /** A question whose slide a new version dropped (ChatMessage.removedFrom): its p.N chip. */
  messageChip: (slide: number, old: number) => `p.${slide} (빠진 장 p.${old})`,
  messageChipTitle: (old: number) => `새 버전에서 빠진 장(예전 p.${old})에 있던 질문이에요`,
};
