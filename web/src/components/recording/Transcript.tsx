// The transcript of a recording in the 녹음 tab (DESIGN §22): for the focused slide or all of it under slide
// headers; a click plays from there; "여기부터 p.N" sets a marker (the slide the viewer shows).
import { ChevronLeft, ChevronRight, MapPin, Play } from 'lucide-react';
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import type { AlignmentMarker, TranscriptSegment } from '../../../../shared/types.ts';
import { msg, useLang } from '../../i18n/index.ts';
import { markerAtSegment, markerLabel, type MarkerAction } from '../../lib/recording/markers.ts';
import { formatClock, groupBySlide, groupsOfSlide, type TranscriptGroup } from '../../lib/recording/timeline.ts';
import { PopoverMenu } from '../organize/PopoverMenu.tsx';

export type TranscriptMode = 'current' | 'all';

/** The slide the viewer shows: only the "여기부터 p.N" buttons read it, so scrolling does not re-render every line. */
const FocusedSlide = createContext(1);

interface TranscriptProps {
  segments: TranscriptSegment[];
  mode: TranscriptMode;
  focusedSlide: number;
  pageCount: number;
  /** Id of the segment playing (highlighted, kept in view while playing). */
  activeId: number | null;
  playing: boolean;
  /** A live recording: new lines arrive at the end (the list sticks to the bottom when it was there). */
  live: boolean;
  markers: AlignmentMarker[];
  /** Markers can be edited (the recording has a transcript and is not being aligned by the AI). */
  canMark: boolean;
  onPlayFrom: (t: number) => void;
  onGoToSlide: (slide: number) => void;
  onMarker: (action: MarkerAction) => void;
  /** The scroll container (the panel's), for keeping the active line in view. */
  scroller: HTMLElement | null;
}

export function Transcript({
  segments,
  mode,
  focusedSlide,
  pageCount,
  activeId,
  playing,
  live,
  markers,
  canMark,
  onPlayFrom,
  onGoToSlide,
  onMarker,
  scroller,
}: TranscriptProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups: TranscriptGroup[] = mode === 'all' ? groupBySlide(segments) : groupsOfSlide(segments, focusedSlide);

  // Keep the line being played in view.
  useEffect(() => {
    if (!playing || activeId === null || !scroller) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-seg="${activeId}"]`);
    if (!el) return;
    const s = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < s.top + 40 || r.bottom > s.bottom - 40) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeId, playing, scroller]);

  // Live, "전체": new lines keep the list at its end when the reader was there.
  const atEnd = useRef(true);
  useEffect(() => {
    if (!scroller) return;
    const onScroll = () => {
      atEnd.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [scroller]);
  const count = segments.length;
  useLayoutEffect(() => {
    if (!live || mode !== 'all' || playing || !scroller || !atEnd.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [count, live, mode, playing, scroller]);

  const m = msg().recording.transcript;
  if (segments.length === 0) {
    return <div className="tr-empty muted">{live ? m.emptyLive : m.empty}</div>;
  }

  if (groups.length === 0) {
    return (
      <div className="tr-empty">
        <span className="slide-chip">p.{focusedSlide}</span>
        <span className="muted"> {live ? m.nothingOnSlideYet : m.nothingOnSlide}</span>
        <div className="digest-nav">
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => onGoToSlide(focusedSlide - 1)}
            disabled={focusedSlide <= 1}
          >
            <ChevronLeft /> p.{Math.max(1, focusedSlide - 1)}
          </button>
          <button
            type="button"
            className="ghost-btn small"
            onClick={() => onGoToSlide(focusedSlide + 1)}
            disabled={focusedSlide >= pageCount}
          >
            p.{Math.min(pageCount, focusedSlide + 1)} <ChevronRight />
          </button>
        </div>
      </div>
    );
  }

  return (
    <FocusedSlide.Provider value={focusedSlide}>
    <div className="tr-list" ref={listRef}>
      {groups.map((g) => (
        <section key={`${g.segments[0].id}`} className={g.slide === focusedSlide ? 'tr-group is-focused' : 'tr-group'}>
          <header className="tr-group-head">
            {g.slide === null ? (
              <span className="tr-offslide" title={m.offSlideTitle}>
                {m.offSlide}
              </span>
            ) : (
              <button type="button" className="slide-chip" onClick={() => onGoToSlide(g.slide!)} title={m.goToSlide}>
                p.{g.slide}
              </button>
            )}
            <button type="button" className="tr-group-time" onClick={() => onPlayFrom(g.start)} title={m.playFromHere}>
              <Play fill="currentColor" /> {formatClock(g.start)}
            </button>
          </header>
          <ol className="tr-segs">
            {g.segments.map((s) => (
              <Segment
                key={s.id}
                segment={s}
                active={s.id === activeId}
                marker={markerAtSegment(markers, s)}
                canMark={canMark}
                onPlayFrom={onPlayFrom}
                onMarker={onMarker}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
    </FocusedSlide.Provider>
  );
}

/** "여기부터 p.N" with the slide the viewer shows (hidden when this line already starts that slide). */
function MarkButton({
  segment,
  marker,
  onMarker,
}: {
  segment: TranscriptSegment;
  marker: AlignmentMarker | null;
  onMarker: (action: MarkerAction) => void;
}) {
  const focusedSlide = useContext(FocusedSlide);
  if (marker !== null && marker.slide === focusedSlide) return null;
  return (
    <button
      type="button"
      className="tr-mark-btn"
      onClick={() => onMarker({ type: 'add', t: segment.start, slide: focusedSlide })}
      title={msg().recording.transcript.markTitle(focusedSlide)}
    >
      {msg().recording.markers.fromSlide(focusedSlide)}
    </button>
  );
}

const Segment = memo(function Segment({
  segment,
  active,
  marker,
  canMark,
  onPlayFrom,
  onMarker,
}: {
  segment: TranscriptSegment;
  active: boolean;
  marker: AlignmentMarker | null;
  canMark: boolean;
  onPlayFrom: (t: number) => void;
  onMarker: (action: MarkerAction) => void;
}) {
  useLang(); // memo(): the texts below follow a language change
  const m = msg().recording.transcript;
  return (
    <li className={active ? 'tr-seg is-active' : 'tr-seg'} data-seg={segment.id}>
      <button
        type="button"
        className="tr-seg-main"
        onClick={() => onPlayFrom(segment.start)}
        title={m.playFrom(formatClock(segment.start))}
      >
        <span className="tr-time">{formatClock(segment.start)}</span>
        <span className="tr-text">
          {marker && (
            <span className="tr-marker" title={m.markerTitle(markerLabel(marker))}>
              <MapPin />
              {marker.slide === null ? m.markerOff : `p.${marker.slide}`}
            </span>
          )}
          {segment.text}
        </span>
      </button>
      {canMark && (
        <span className="tr-seg-actions">
          <MarkButton segment={segment} marker={marker} onMarker={onMarker} />
          <PopoverMenu
            label={m.sentenceMenu(formatClock(segment.start))}
            sections={[
              {
                items: [
                  { key: 'play', label: m.playFromHere, onSelect: () => onPlayFrom(segment.start) },
                  {
                    key: 'off',
                    label: msg().recording.markers.fromHereOff,
                    hint: m.offSlideHint,
                    onSelect: () => onMarker({ type: 'add', t: segment.start, slide: null }),
                  },
                  ...(marker
                    ? [
                        {
                          key: 'remove',
                          label: m.removeMarker,
                          hint: markerLabel(marker),
                          onSelect: () => onMarker({ type: 'remove', t: marker.t }),
                        },
                      ]
                    : []),
                ],
              },
            ]}
          />
        </span>
      )}
    </li>
  );
});
