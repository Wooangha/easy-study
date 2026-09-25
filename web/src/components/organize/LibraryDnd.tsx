// Drag & drop of lectures, courses and groups in the library (DESIGN §18) with @dnd-kit/core.
//
// Items do not shift while dragging: a DragOverlay follows the pointer and an insertion line (or a highlighted
// container) shows where the item will land. Where that is comes from lib/libraryDnd.ts: the droppable under
// the pointer (keyboard: under the dragged item's center) and the position in it. Keyboard dragging moves
// between the distinct places the item can go ("stops"). Hovering over a collapsed course/group for 600 ms
// opens it until the drop (and says so to screen readers, with the place the item is at now). While a course
// (group) is dragged, course (group) cards show only their header.
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type ClientRect,
  type CollisionDetection,
  type DroppableContainer,
  type KeyboardCoordinateGetter,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getEventCoordinates } from '@dnd-kit/utilities';
import { createPortal } from 'react-dom';
import type { Course, LibraryLayout } from '../../../../shared/types.ts';
import {
  containerOfKey,
  describePlace,
  describeTarget,
  dndId,
  dragItemOf,
  keyboardStops,
  nextStop,
  pickDroppable,
  resolveDrop,
  type DragItem,
  type DropData,
  type DropTarget,
  type DroppableBox,
  type Indicator,
  type OrgView,
} from '../../lib/libraryDnd.ts';
import { withParticle } from '../../lib/korean.ts';
import type { Move } from '../../lib/libraryLayout.ts';

/** Hovering over a collapsed course/group this long opens it. */
const SPRING_OPEN_MS = 600;
/** After opening, wait this long (its content is measured) before saying where the item is now. */
const OPENED_ANNOUNCE_MS = 200;
/** Keeps the ghost this far from the edges of the window. */
const GHOST_MARGIN = 8;

const visuallyHidden = {
  position: 'fixed',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(100%)',
  whiteSpace: 'nowrap',
} as const;

let lastDragEndAt = 0;
/** A click right after a drop (the mouse was released over a header) must not toggle anything. */
export const wasJustDragging = () => Date.now() - lastDragEndAt < 250;

interface DragState {
  active: DragItem | null;
  indicator: Indicator | null;
  /** Collapsed courses/groups opened by hovering during this drag. */
  springOpen: ReadonlySet<string>;
}

const NOTHING_OPEN: ReadonlySet<string> = new Set();
const DragContext = createContext<DragState>({ active: null, indicator: null, springOpen: NOTHING_OPEN });

export const useDragState = () => useContext(DragContext);

/** How the element with this indicator key should look: insertion line before/after it, or drop into it. */
export function useDropMark(key: string): 'before' | 'after' | 'into' | null {
  const { indicator } = useContext(DragContext);
  if (!indicator || indicator.key !== key) return null;
  return indicator.type === 'into' ? 'into' : indicator.side;
}

export const dropMarkClass = (mark: 'before' | 'after' | 'into' | null): string =>
  mark === 'before' ? ' drop-before' : mark === 'after' ? ' drop-after' : mark === 'into' ? ' drop-into' : '';

const isDropData = (v: unknown): v is DropData => typeof v === 'object' && v !== null && 'role' in v;

function toBoxes(containers: Iterable<DroppableContainer>, rects: Map<UniqueIdentifier, ClientRect>): DroppableBox[] {
  const boxes: DroppableBox[] = [];
  for (const c of containers) {
    const data = c.data.current;
    const rect = rects.get(c.id);
    if (!rect || !isDropData(data) || c.disabled) continue;
    boxes.push({ id: String(c.id), data, rect });
  }
  return boxes;
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a === b || (!!a && !!b && a.key === b.key && JSON.stringify(a.indicator) === JSON.stringify(b.indicator));

/** The collapse key of the container a move puts the item into (to keep it open after the drop). */
function destinationKey(move: Move): string | null {
  if (move.kind === 'lecture') return move.courseId ? dndId.course(move.courseId) : null;
  if (move.kind === 'course') return move.groupId ? dndId.group(move.groupId) : null;
  return null;
}

interface LibraryDndProps {
  courses: readonly Course[];
  layout: LibraryLayout;
  /** Collapsed course/group keys (collapseKey.*, the same strings as the dnd ids of courses and groups). */
  collapsed: ReadonlySet<string>;
  /** "‘L3 Parsing’ 강의" — the item's name in announcements. */
  nameOf: (item: DragItem) => string;
  renderOverlay: (item: DragItem) => ReactNode;
  onMove: (move: Move) => void;
  /** Keep a container that was opened by hovering open (the item was dropped into it). */
  onKeepOpen: (key: string) => void;
  children: ReactNode;
}

export function LibraryDnd({ courses, layout, collapsed, nameOf, renderOverlay, onMove, onKeepOpen, children }: LibraryDndProps) {
  const [active, setActive] = useState<DragItem | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [springOpen, setSpringOpen] = useState<ReadonlySet<string>>(NOTHING_OPEN);
  /** Where the item was grabbed, relative to its top-left corner: the ghost is drawn there. */
  const [grab, setGrab] = useState({ x: 24, y: 24 });

  const isCollapsed = useCallback((key: string) => collapsed.has(key) && !springOpen.has(key), [collapsed, springOpen]);
  const view: OrgView = useMemo(() => ({ courses, layout, isCollapsed }), [courses, layout, isCollapsed]);
  // Read by the collision detection, which @dnd-kit runs while rendering: keep it current during render.
  const viewRef = useRef(view);
  viewRef.current = view;
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  /** Where the item would land now (written by the collision detection on every drag render). */
  const targetRef = useRef<DropTarget | null>(null);
  const announcedKey = useRef<string | null>(null);
  const announcement = useRef<string | undefined>(undefined);
  const finalAnnouncement = useRef('');
  const springTimer = useRef<{ key: string; timer: number } | null>(null);
  /** "‘OS’ 과목을 열었어요." waiting to be said together with the item's new place. */
  const openedNote = useRef<{ text: string; timer: number } | null>(null);
  const activeRef = useRef<DragItem | null>(null);
  /** Announcements that no @dnd-kit event carries (a container opened while the item stood still). */
  const [liveText, setLiveText] = useState('');

  const stopSpringTimer = () => {
    if (springTimer.current) window.clearTimeout(springTimer.current.timer);
    springTimer.current = null;
  };
  const stopOpenedNote = () => {
    if (openedNote.current) window.clearTimeout(openedNote.current.timer);
    openedNote.current = null;
  };
  useEffect(
    () => () => {
      stopSpringTimer();
      stopOpenedNote();
    },
    [],
  );

  /**
   * A container opened by hovering: once its content is measured, say so and where the item is now (keyboard
   * users would otherwise hear the old place, e.g. "the end of the course", while it is now its first place).
   */
  const noteOpened = (key: string) => {
    stopOpenedNote();
    const container = containerOfKey(key);
    const text = container ? `${withParticle(nameRef.current(container), '을', '를')} 열었어요.` : '열었어요.';
    const timer = window.setTimeout(() => {
      openedNote.current = null;
      const item = activeRef.current;
      const now = targetRef.current;
      if (!item) return;
      announcement.current = undefined;
      if (now) announcedKey.current = now.key;
      const said = now ? `${text} ${nameRef.current(item)}: ${describePlace(now, viewRef.current)}` : text;
      setLiveText((prev) => (prev === said ? `${said}\u00a0` : said));
    }, OPENED_ANNOUNCE_MS);
    openedNote.current = { text, timer };
  };

  const collisionDetection: CollisionDetection = useCallback(
    ({ active: dragged, collisionRect, droppableRects, droppableContainers, pointerCoordinates }) => {
      const item = dragItemOf(isDropData(dragged.data.current) ? dragged.data.current : null);
      if (!item) return [];
      const point = pointerCoordinates ?? {
        x: collisionRect.left + collisionRect.width / 2,
        y: collisionRect.top + collisionRect.height / 2,
      };
      const picked = pickDroppable(item, point, toBoxes(droppableContainers, droppableRects), viewRef.current);
      if (!picked) {
        targetRef.current = null;
        return [];
      }
      targetRef.current = resolveDrop(item, picked.box.data, picked.relY, viewRef.current);
      const container = droppableContainers.find((c) => String(c.id) === picked.box.id);
      return [{ id: picked.box.id, data: { droppableContainer: container, value: 0 } }];
    },
    [],
  );

  /** Keyboard: ↑/↓ go to the previous/next distinct place the item can land. */
  const coordinateGetter: KeyboardCoordinateGetter = useCallback((event, { context, currentCoordinates }) => {
    const dir = event.code === 'ArrowDown' ? 1 : event.code === 'ArrowUp' ? -1 : 0;
    if (dir === 0) return undefined;
    event.preventDefault();
    const { active: dragged, collisionRect, droppableRects, droppableContainers } = context;
    const item = dragItemOf(dragged && isDropData(dragged.data.current) ? dragged.data.current : null);
    if (!item || !collisionRect) return undefined;
    const boxes = toBoxes(droppableContainers.getEnabled(), droppableRects);
    const x = collisionRect.left + collisionRect.width / 2;
    const y = collisionRect.top + collisionRect.height / 2;
    const stops = keyboardStops(item, x, boxes, viewRef.current);
    const stop = nextStop(stops, y, targetRef.current?.key ?? 'noop', dir);
    if (!stop) return undefined;
    return { x: currentCoordinates.x, y: currentCoordinates.y + (stop.y - y) };
  }, []);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // Touch: press and hold, so that swiping over a handle still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  /** Show the latest target, open collapsed containers after hovering, queue the announcement. */
  const sync = useCallback(() => {
    const next = targetRef.current;
    setTarget((prev) => (sameTarget(prev, next) ? prev : next));

    const into = next?.indicator?.type === 'into' ? next.indicator.key : null;
    const spring = into && viewRef.current.isCollapsed(into) ? into : null;
    if (spring !== (springTimer.current?.key ?? null)) {
      stopSpringTimer();
      if (spring) {
        const timer = window.setTimeout(() => {
          springTimer.current = null;
          setSpringOpen((prev) => new Set(prev).add(spring));
          noteOpened(spring);
        }, SPRING_OPEN_MS);
        springTimer.current = { key: spring, timer };
      }
    }

    // Right after an opening the place is said by noteOpened().
    if (next && next.key !== announcedKey.current && !openedNote.current) {
      announcedKey.current = next.key;
      const item = activeRef.current;
      if (item) announcement.current = `${nameRef.current(item)}: ${describePlace(next, viewRef.current)}`;
    }
  }, []);

  const reset = () => {
    stopSpringTimer();
    stopOpenedNote();
    setLiveText('');
    activeRef.current = null;
    targetRef.current = null;
    announcedKey.current = null;
    announcement.current = undefined;
    setActive(null);
    setTarget(null);
    setSpringOpen(NOTHING_OPEN);
    lastDragEndAt = Date.now();
  };

  const announcements: Announcements = {
    onDragStart: ({ active: dragged }) => {
      const item = dragItemOf(isDropData(dragged.data.current) ? dragged.data.current : null);
      return item
        ? `${withParticle(nameRef.current(item), '을', '를')} 집었어요. 위아래 화살표로 옮기고 스페이스나 엔터로 놓으세요.`
        : undefined;
    },
    onDragMove: () => takeAnnouncement(),
    onDragOver: () => takeAnnouncement(),
    onDragEnd: () => finalAnnouncement.current,
    onDragCancel: ({ active: dragged }) => {
      const item = dragItemOf(isDropData(dragged.data.current) ? dragged.data.current : null);
      return item
        ? `옮기기를 취소했어요. ${withParticle(nameRef.current(item), '은', '는')} 원래 자리에 있어요.`
        : '옮기기를 취소했어요.';
    },
  };
  function takeAnnouncement(): string | undefined {
    const text = announcement.current;
    announcement.current = undefined;
    return text;
  }

  const dragContext = useMemo<DragState>(
    () => ({ active, indicator: target?.indicator ?? null, springOpen }),
    [active, target, springOpen],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging, frequency: 250 } }}
      autoScroll={{ threshold: { x: 0, y: 0.18 } }}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            '끌어서 옮길 수 있어요. 스페이스나 엔터로 집고, 위아래 화살표로 옮긴 뒤 스페이스나 엔터로 놓으세요. Esc를 누르면 취소돼요. 터치 화면에서는 손잡이를 길게 누른 채 끌어요.',
        },
      }}
      onDragStart={({ active: dragged, activatorEvent }) => {
        const item = dragItemOf(isDropData(dragged.data.current) ? dragged.data.current : null);
        setGrab(grabPoint(activatorEvent));
        activeRef.current = item;
        targetRef.current = null;
        announcedKey.current = 'noop'; // the starting place is not announced as a destination
        setActive(item);
        setTarget(null);
      }}
      onDragEnd={() => {
        const item = activeRef.current;
        const dropped = targetRef.current;
        const opened = springOpen;
        if (item && dropped?.move) {
          const { place, total } = describeTarget(dropped, viewRef.current);
          finalAnnouncement.current =
            `${withParticle(nameRef.current(item), '을', '를')} ${place}로 옮겼어요` + (total === null ? '.' : ` (${total}개 중).`);
          const dest = destinationKey(dropped.move);
          if (dest && opened.has(dest)) onKeepOpen(dest);
          onMove(dropped.move);
        } else {
          finalAnnouncement.current = item ? `${withParticle(nameRef.current(item), '을', '를')} 원래 자리에 놓았어요.` : '';
        }
        reset();
      }}
      onDragCancel={reset}
    >
      <DragContext.Provider value={dragContext}>
        {children}
        <DragSync onRender={sync} />
      </DragContext.Provider>
      <div aria-live="assertive" aria-atomic="true" style={visuallyHidden}>
        {liveText}
      </div>
      {createPortal(
        <DragOverlay className="drag-overlay" dropAnimation={{ duration: 180, easing: 'ease-out' }} zIndex={80}>
          {active ? (
            // @dnd-kit measures a lone child of the overlay as the dragged item's box (keyboard dragging uses its
            // center): that child must be the item's box, not the small ghost drawn beside the pointer.
            <div className="drag-overlay-box">
              <div className="drag-ghost-anchor" style={{ left: grab.x, top: grab.y }}>
                <InViewport>{renderOverlay(active)}</InViewport>
              </div>
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/**
 * Keeps the ghost inside the window: it is drawn just below and right of the pointer (so that what is under
 * the pointer — an insertion line, "놓으면 …" — stays readable) and would otherwise leave the screen when the
 * pointer is near the right edge (phones). Checked every frame while it is shown; the overlay moves with the
 * pointer without re-rendering it.
 */
function InViewport({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let shift = 0;
    let frame = 0;
    const check = () => {
      const el = ref.current;
      if (el) {
        const box = el.getBoundingClientRect();
        const left = box.left - shift;
        const right = box.right - shift;
        const width = document.documentElement.clientWidth;
        let next = 0;
        if (right > width - GHOST_MARGIN) next = width - GHOST_MARGIN - right;
        if (left + next < GHOST_MARGIN) next = GHOST_MARGIN - left;
        if (next !== shift) {
          shift = next;
          el.style.translate = `${next}px 0`;
        }
      }
      frame = window.requestAnimationFrame(check);
    };
    check();
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return (
    <div ref={ref} className="drag-ghost-frame">
      {children}
    </div>
  );
}

/**
 * A lecture, course or group: dragged by its ≡ handle (`setActivatorNodeRef`), and a drop target described by
 * the same `data` (the insertion line is drawn on it).
 */
export function useOrgItem({
  id,
  data,
  roleDescription,
  canDrag = true,
}: {
  id: string;
  data: DropData;
  roleDescription: string;
  canDrag?: boolean;
}) {
  const draggable = useDraggable({ id, data, disabled: !canDrag, attributes: { roleDescription } });
  const { setNodeRef: setDropRef } = useDroppable({ id, data });
  const setDragRef = draggable.setNodeRef;
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDragRef(node);
      setDropRef(node);
    },
    [setDragRef, setDropRef],
  );
  return {
    setNodeRef,
    setActivatorNodeRef: draggable.setActivatorNodeRef,
    listeners: draggable.listeners,
    attributes: draggable.attributes,
    isDragging: draggable.isDragging,
  };
}

/**
 * The point where a drag started (pointer, or the focused handle for the keyboard) relative to the dragged
 * element (marked `data-drag-node`). The overlay has that element's size; the small ghost is drawn at this point.
 */
function grabPoint(activatorEvent: Event | null): { x: number; y: number } {
  const handle = activatorEvent?.target instanceof Element ? activatorEvent.target : null;
  const node = handle?.closest('[data-drag-node]');
  if (!handle || !node) return { x: 24, y: 24 };
  const box = node.getBoundingClientRect();
  let point = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!point) {
    const h = handle.getBoundingClientRect();
    point = { x: h.left + h.width / 2, y: h.top + h.height / 2 };
  }
  return { x: point.x - box.left, y: point.y - box.top };
}

/**
 * Re-renders with every @dnd-kit update during a drag (its context changes) and then syncs the target:
 * child effects run before @dnd-kit's own, so a changed target is announced by the same move/over event.
 */
function DragSync({ onRender }: { onRender: () => void }) {
  const { active } = useDndContext();
  useEffect(() => {
    if (active) onRender();
  });
  return null;
}

/** Drop zone below the last top-level item (only while a course or group is dragged). */
export function TopEndZone() {
  const { active } = useDragState();
  const data: DropData = { role: 'top-end' };
  const { setNodeRef } = useDroppable({ id: dndId.topEnd, data });
  const mark = useDropMark(dndId.topEnd);
  if (!active || active.kind === 'lecture') return null;
  return (
    <div ref={setNodeRef} className={`top-end-zone${mark === 'into' ? ' drop-into' : ''}`} aria-hidden>
      {active.kind === 'group' ? '맨 아래로 옮기기' : '그룹 밖 맨 아래로 옮기기'}
    </div>
  );
}
