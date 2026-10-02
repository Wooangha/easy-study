// English — namespace `versions` (the Korean reference: ../ko/versions.ts).
import type { versions as ko } from '../ko/versions.ts';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const versions = {
  menu: 'Upload new version',
  menuHint: 'PDF',

  dialog: {
    title: 'New version',
    uploading: (percent: number) => `Uploading ${percent}%`,
    analyzing: 'Analyzing the PDF…',
    converting: (done: number, total: number) => `Converting slides ${done} / ${total}`,
    same: (n: number) => `Same ${n}`,
    changed: (n: number) => `Changed ${n}`,
    added: (n: number) => `New ${n}`,
    removed: (n: number) => `Removed ${n}`,
    unchanged: 'No slide changed',
    changedHeading: 'Changed slides',
    addedHeading: 'New slides',
    removedHeading: 'Removed slides',
    moved: 'Moved',
    page: (n: number) => `p.${n}`,
    oldAlt: (n: number) => `Old slide ${n}`,
    newAlt: (n: number) => `New slide ${n}`,
    keptOnRemoved: (items: number, memos: number) =>
      `${[items > 0 ? plural(items, 'annotation', 'annotations') : '', memos > 0 ? plural(memos, 'memo', 'memos') : ''].filter(Boolean).join(' and ')} on the removed slides will be kept in Memos › Removed slides`,
    questionsMoved: (n: number) => `${plural(n, 'question moves', 'questions move')} to the nearest slide`,
    unrelated: 'This is very different from the lecture. Make sure it is not another lecture’s PDF.',
    apply: 'Switch to the new version',
    applying: 'Switching…',
    gone: 'The new version is gone. Upload it again.',
    failed: (message: string) => `Could not prepare the new version: ${message}`,
    applied: (title: string) => `‘${title}’ now uses the new version`,
  },

  banner: {
    applied: 'Switched to the new version',
    undone: 'Back to the previous version',
    changed: (n: number) => `${n} changed`,
    added: (n: number) => `${n} new`,
    removed: (n: number) => `${n} removed`,
    prev: 'Previous changed slide',
    next: 'Next changed slide',
    undo: 'Undo',
    dismiss: 'Close',
    undoConfirmTitle: 'Go back to the version before the upload?',
    undoConfirmMessage: 'Annotations and chats made since then move along.',
    undoneToast: 'Back to the previous version',
    undoFailed: (message: string) => `Could not undo: ${message}`,
    badgeChanged: 'Changed',
    badgeAdded: 'New',
    badgeChangedTitle: 'Changed in the new version',
    badgeAddedTitle: 'New in the new version',
  },

  removed: {
    heading: 'Removed slides',
    title: 'Annotations and memos of slides the new version dropped (read-only)',
    oldPage: (n: number) => `Old p.${n}`,
    thumbAlt: (n: number) => `Old slide ${n}`,
    loadFailed: (error: string) => `Could not load the removed slides: ${error}`,
    inkStrokes: (n: number) => `Handwriting, ${plural(n, 'stroke', 'strokes')}`,
  },

  messageChip: (slide: number, old: number) => `p.${slide} (removed p.${old})`,
  messageChipTitle: (old: number) => `Asked on a slide the new version dropped (old p.${old})`,
} satisfies typeof ko;
