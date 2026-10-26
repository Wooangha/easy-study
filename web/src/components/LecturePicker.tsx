// The top bar's lecture picker (DESIGN §13, 0.6.14; the user picked this from three mock-ups): a button with the open
// lecture — its course, its place there and its title — between ‹ › to the course's previous / next lecture, opening
// a panel with a search field (⌘K / Ctrl+K from anywhere), the lectures opened last on this device, and the courses in
// library order (the open lecture's course unfolded, the others folded) with 미분류 last. Each row: the first slide,
// the title (the search's matches marked), the slide count, where it was left on this device, the digest. ↑↓ move,
// → / ← unfold / fold a course, Enter opens, Esc closes. The model and the search are lib/lecturePicker.ts.
import { ChevronDown, ChevronLeft, ChevronRight, Clock, Folder, Hourglass, Plus, Search, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Course, DocMeta, LibraryLayout } from '../../../shared/types.ts';
import { thumbUrl } from '../api.ts';
import { msg } from '../i18n/index.ts';
import { highlightParts, neighbours, pickerModel, recentLectures, searchLectures, titleHasNumber, type PickerCourse } from '../lib/lecturePicker.ts';
import { isStringArray } from '../lib/libraryLayout.ts';
import { readRememberedSlide, readStorage, storageKeys } from '../lib/storage.ts';
import { Floating } from './annotations/Floating.tsx';
import { SlideImage } from './SlideImage.tsx';

interface LecturePickerProps {
  docs: DocMeta[] | null;
  doc: DocMeta | null;
  courses: Course[] | null;
  layout: LibraryLayout;
  onSelectDoc: (docId: string) => void;
  onUploadClick: () => void;
  /** Course that "＋ PDF 추가" uploads into (null = uncategorized). */
  uploadCourse: Course | null;
}

/** ⌘ on Apple devices, Ctrl elsewhere (Ctrl+K stays the Mac's "delete to the end of the line" in a text field). */
const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
const SHORTCUT = apple ? '⌘K' : 'Ctrl K';
const isShortcut = (e: globalThis.KeyboardEvent) =>
  e.key?.toLowerCase() === 'k' && !e.shiftKey && !e.altKey && (apple ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 560;
const UNCATEGORIZED = '__uncategorized__';

/** One row of the panel's list, in the order ↑↓ walk it. */
type Row =
  | { kind: 'lecture'; key: string; doc: DocMeta; course: PickerCourse | null; index: number | null; ranges?: Array<[number, number]>; showCourse: boolean }
  | { kind: 'course'; key: string; id: string; label: string; count: number; open: boolean };

export function LecturePicker({ docs, doc, courses, layout, onSelectDoc, onUploadClick, uploadCourse }: LecturePickerProps) {
  const m = msg().shell.topBar;
  const p = m.picker;
  const model = useMemo(() => pickerModel(docs ?? [], courses ?? [], layout), [docs, courses, layout]);
  const around = doc ? neighbours(model, doc.id) : null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** The folded / unfolded courses while the panel is open (the open lecture's course starts unfolded). */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  /** What had the focus before ⌘K opened the picker (Esc gives it back: the chat composer, say). */
  const before = useRef<HTMLElement | null>(null);
  /** Opened by a finger or a pen: no focus in the search field (the on-screen keyboard would cover the list). */
  const byTouch = useRef(false);
  /** The active row moved with the keyboard (only then is it scrolled into view: a pointer is already on it). */
  const keyMove = useRef(false);

  const show = useCallback(() => {
    setQuery('');
    setActive(0);
    const own = doc ? (model.place.get(doc.id)?.course.id ?? UNCATEGORIZED) : undefined;
    setUnfolded(new Set(own ? [own] : model.courses.length === 0 ? [UNCATEGORIZED] : []));
    setOpen(true);
  }, [doc, model]);
  /** `refocus`: back to what had the focus before ⌘K, else the button. */
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    const back = before.current;
    before.current = null;
    if (!refocus) return;
    if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
    else button?.focus();
  }, [button]);

  // ⌘K / Ctrl+K from anywhere: open (or close) the picker — not over a dialog (settings, a confirmation) nor while the
  // app is covered (the login screen makes it inert).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isShortcut(e) || e.defaultPrevented) return;
      if (!button?.isConnected || button.closest('[inert]') || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      if (open) {
        close(true);
        return;
      }
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      byTouch.current = false;
      show();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, show, close, button]);

  // A press outside the panel and its button closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || button?.contains(t)) return;
      close(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, button, close]);

  // Into the search field once the panel is placed (Floating shows it hidden until it has measured where it goes).
  useEffect(() => {
    if (!open || byTouch.current) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // The lectures opened last, but not the open one (the button shows it).
  const recent = useMemo(() => {
    if (!open) return [];
    const ids = readStorage(storageKeys.recentDocs, [], isStringArray).filter((id) => id !== doc?.id);
    return recentLectures(ids, docs ?? [], 3);
    // Read when the panel opens.
  }, [open, docs, doc?.id]);

  const rows: Row[] = useMemo(() => {
    if (!open) return [];
    const lecture = (d: DocMeta, course: PickerCourse | null, showCourse: boolean, prefix: string, ranges?: Array<[number, number]>): Row => ({
      kind: 'lecture',
      key: `${prefix}:${d.id}`,
      doc: d,
      course,
      index: course ? (model.place.get(d.id)?.index ?? null) : null,
      ranges,
      showCourse,
    });
    if (query.trim()) return searchLectures(model, query).map((hit) => lecture(hit.doc, hit.course, true, 'hit', hit.ranges));
    const out: Row[] = recent.map((d) => lecture(d, model.place.get(d.id)?.course ?? null, true, 'recent'));
    const noCourses = model.courses.length === 0;
    for (const course of model.courses) {
      const isOpen = unfolded.has(course.id);
      out.push({ kind: 'course', key: `course:${course.id}`, id: course.id, label: course.label, count: course.lectures.length, open: isOpen });
      if (isOpen) for (const d of course.lectures) out.push(lecture(d, course, false, course.id));
    }
    if (model.uncategorized.length > 0) {
      if (noCourses) {
        for (const d of model.uncategorized) out.push(lecture(d, null, false, UNCATEGORIZED));
      } else {
        const isOpen = unfolded.has(UNCATEGORIZED);
        out.push({ kind: 'course', key: `course:${UNCATEGORIZED}`, id: UNCATEGORIZED, label: m.uncategorized, count: model.uncategorized.length, open: isOpen });
        if (isOpen) for (const d of model.uncategorized) out.push(lecture(d, null, false, UNCATEGORIZED));
      }
    }
    return out;
  }, [open, query, model, recent, unfolded, m.uncategorized]);

  // The active row stays in the list and in view.
  const current = Math.min(active, Math.max(0, rows.length - 1));
  useEffect(() => {
    if (!open || !keyMove.current) return;
    keyMove.current = false;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${current}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, current]);

  const pick = (d: DocMeta) => {
    close(true);
    if (d.id !== doc?.id) onSelectDoc(d.id);
  };
  const toggle = (id: string, to?: boolean) =>
    setUnfolded((cur) => {
      const next = new Set(cur);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // A Korean syllable still being composed: its Enter / arrows belong to the input method (the next Enter would
    // otherwise reach the button the first one gave the focus to, and open the picker again).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const row = rows[current];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      keyMove.current = true;
      if (rows.length > 0) setActive((current + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (row?.kind === 'lecture') pick(row.doc);
      else if (row?.kind === 'course') toggle(row.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && row?.kind === 'course' && !query) {
      e.preventDefault();
      toggle(row.id, e.key === 'ArrowRight');
    }
    // Tab moves on to ＋ PDF 추가; leaving the panel closes it (onBlur below).
  };

  // Section headings before the first row of each part: 최근, then 과목 (or every lecture when there are no courses).
  const headingBefore = (i: number): ReactNode => {
    if (query.trim())
      return i === 0 ? (
        <div className="lp-sec" role="presentation">
          {p.results(rows.length)}
        </div>
      ) : null;
    if (recent.length === 0) return null;
    if (i === 0)
      return (
        <div className="lp-sec" role="presentation">
          <Clock /> {p.recent}
        </div>
      );
    return i === recent.length ? (
      <div className="lp-sec" role="presentation">
        {model.courses.length > 0 ? p.courses : p.allLectures}
      </div>
    ) : null;
  };

  const label = doc ? (
    <>
      {around && (
        <>
          <span className="lp-btn-course">{around.course.label}</span>
          <span className="lp-btn-place">{`${around.index}/${around.total}`}</span>
        </>
      )}
      <span className="lp-btn-title">{doc.title}</span>
    </>
  ) : (
    <span className="lp-btn-title muted">{docs && docs.length > 0 ? m.docPlaceholder : m.noDocs}</span>
  );

  return (
    <div className="lecture-picker">
      {around && (
        <button
          type="button"
          className="lp-step"
          disabled={!around.prev}
          onClick={() => around.prev && onSelectDoc(around.prev.id)}
          title={around.prev ? p.prevTitle(around.prev.title) : p.noPrev}
          aria-label={around.prev ? p.prevTitle(around.prev.title) : p.noPrev}
        >
          <ChevronLeft />
        </button>
      )}
      <button
        ref={setButton}
        type="button"
        className={`lp-btn${open ? ' is-open' : ''}${around ? ' has-steps' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={doc ? p.buttonLabel(doc.title) : m.docPicker}
        title={p.buttonTitle(SHORTCUT)}
        onPointerDown={(e) => {
          byTouch.current = e.pointerType === 'touch' || e.pointerType === 'pen';
        }}
        onClick={() => {
          before.current = null;
          if (open) close(true);
          else show();
        }}
      >
        {label}
        <ChevronDown className="lp-btn-chevron" />
      </button>
      {around && (
        <button
          type="button"
          className="lp-step"
          disabled={!around.next}
          onClick={() => around.next && onSelectDoc(around.next.id)}
          title={around.next ? p.nextTitle(around.next.title) : p.noNext}
          aria-label={around.next ? p.nextTitle(around.next.title) : p.noNext}
        >
          <ChevronRight />
        </button>
      )}
      {open && (
        <Floating
          ref={panelRef}
          anchor={button}
          width={Math.min(PANEL_WIDTH, window.innerWidth - 16)}
          height={PANEL_HEIGHT}
          className="lp-panel"
          role="dialog"
          label={m.docPicker}
          onKeyDown={(e) => {
            // Tab past ＋ PDF 추가 (the panel's last stop, at the end of the page): back to where the picker opened from.
            if (e.key === 'Tab' && !e.shiftKey && e.target instanceof HTMLElement && e.target.classList.contains('lp-add')) {
              e.preventDefault();
              close(true);
            }
          }}
          onBlur={(e) => {
            // The focus went somewhere else (Tab out of it). Nowhere (a press on a button WebKit does not focus, the
            // window left) is not leaving: a press outside closes it by itself.
            const to = e.relatedTarget;
            if (to instanceof Node && !panelRef.current?.contains(to) && !button?.contains(to)) close(false);
          }}
        >
          <div className="lp-search">
            <Search />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={rows.length > 0 ? `${listId}-${current}` : undefined}
              aria-autocomplete="list"
              aria-label={p.searchLabel}
              placeholder={p.searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="lp-kbd">{query ? 'Esc' : SHORTCUT}</kbd>
          </div>
          {rows.length === 0 && <div className="lp-empty">{query.trim() ? p.noResults : m.noDocs}</div>}
          <div
            ref={listRef}
            id={listId}
            className="lp-list"
            role="listbox"
            aria-label={m.docPicker}
            // A press in the list keeps the focus (and the keys) in the search field.
            onMouseDown={(e) => e.preventDefault()}
          >
            {rows.map((row, i) => (
              <PickerRow
                key={row.key}
                row={row}
                index={i}
                id={`${listId}-${i}`}
                heading={headingBefore(i)}
                active={i === current}
                currentDoc={doc?.id ?? null}
                onHover={() => setActive(i)}
                onPick={pick}
                onToggle={toggle}
              />
            ))}
          </div>
          <div className="lp-foot">
            <span>{p.keysHint}</span>
            <button
              type="button"
              className="lp-add"
              onClick={() => {
                close(false);
                onUploadClick();
              }}
            >
              <Plus /> {uploadCourse ? p.addPdfTo(uploadCourse.title) : p.addPdf}
            </button>
          </div>
        </Floating>
      )}
    </div>
  );
}

function PickerRow({
  row,
  index,
  id,
  heading,
  active,
  currentDoc,
  onHover,
  onPick,
  onToggle,
}: {
  row: Row;
  index: number;
  id: string;
  heading: ReactNode;
  active: boolean;
  currentDoc: string | null;
  onHover: () => void;
  onPick: (doc: DocMeta) => void;
  onToggle: (id: string) => void;
}) {
  const p = msg().shell.topBar.picker;
  if (row.kind === 'course') {
    return (
      <>
        {heading}
        <div
          id={id}
          data-row={index}
          role="option"
          aria-selected={active}
          aria-label={p.courseRow(row.label, row.count, row.open)}
          className={`lp-course${active ? ' is-active' : ''}`}
          onPointerMove={onHover}
          onClick={() => onToggle(row.id)}
        >
          {row.open ? <ChevronDown className="lp-fold" /> : <ChevronRight className="lp-fold" />}
          <Folder />
          <span className="lp-course-name">{row.label}</span>
          <span className="lp-count">{p.lectureCount(row.count)}</span>
        </div>
      </>
    );
  }
  const { doc } = row;
  const isCurrent = doc.id === currentDoc;
  const number = row.index !== null && !row.showCourse && !titleHasNumber(doc.title) ? `${row.index} · ` : '';
  return (
    <>
      {heading}
      <div
        id={id}
        data-row={index}
        role="option"
        aria-selected={active}
        aria-current={isCurrent ? 'true' : undefined}
        className={`lp-row${active ? ' is-active' : ''}${isCurrent ? ' is-current' : ''}${row.showCourse ? '' : ' is-nested'}`}
        onPointerMove={onHover}
        onClick={() => onPick(doc)}
      >
        <span className="lp-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
          {doc.status === 'ready' ? (
            <SlideImage docId={doc.id} slide={1} src={thumbUrl(doc.id, 1)} alt="" draggable={false} />
          ) : doc.status === 'error' ? (
            <TriangleAlert />
          ) : (
            <Hourglass />
          )}
        </span>
        <span className="lp-main">
          <span className="lp-title">
            {number && <span className="lp-num">{number}</span>}
            {row.ranges ? highlightParts(doc.title, row.ranges).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>)) : doc.title}
          </span>
          <span className="lp-sub">
            <LectureFacts doc={doc} course={row.showCourse ? row.course : null} />
          </span>
        </span>
        <Where doc={doc} />
      </div>
    </>
  );
}

/** "데이터베이스 · 26장 · 정리본" / "변환 중 40%" / "변환 실패". */
function LectureFacts({ doc, course }: { doc: DocMeta; course: PickerCourse | null }) {
  const m = msg().shell.topBar;
  const p = m.picker;
  const parts: ReactNode[] = [];
  if (course) parts.push(course.label);
  if (doc.status === 'processing') parts.push(p.converting(doc.pageCount > 0 ? Math.round((doc.progress / doc.pageCount) * 100) : 0));
  else if (doc.status === 'error') parts.push(p.failed);
  else parts.push(m.slideCount(doc.pageCount));
  return (
    <>
      {parts.join(' · ')}
      {doc.status === 'ready' && doc.digestStatus === 'ready' && <span className="lp-badge is-ok">✓ {m.digestReady}</span>}
      {doc.status === 'ready' && doc.digestStatus === 'running' && <span className="lp-badge">{m.digestRunning}</span>}
    </>
  );
}

/** Where the lecture was left on this device: "12/26" and a bar (nothing for a lecture never opened here). */
function Where({ doc }: { doc: DocMeta }) {
  const p = msg().shell.topBar.picker;
  if (doc.status !== 'ready' || doc.pageCount <= 0) return null;
  const left = readRememberedSlide(doc.id);
  // A position remembered in an older deck (a new version since) is not shown: its numbers mean other slides.
  if (!left) return <span className="lp-where muted">{p.notOpened}</span>;
  if (left.rev !== (doc.deckRev ?? 0)) return null;
  const slide = Math.min(left.slide, doc.pageCount);
  return (
    <span className="lp-where" title={p.leftAt(slide, doc.pageCount)}>
      <span className="lp-where-num">{p.position(slide, doc.pageCount)}</span>
      <span className="lp-bar" aria-hidden="true">
        <i style={{ width: `${Math.round((slide / doc.pageCount) * 100)}%` }} />
      </span>
    </span>
  );
}
