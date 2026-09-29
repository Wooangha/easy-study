// The 메모 tab (DESIGN §25): every memo of the lecture from the annotation summary (no per-slide loads), searched
// over text and tags, filtered by tag or to the focused slide. A row opens the memo on its slide; its ⋯ deletes it.
import { useMemo, useState } from 'react';
import type { MemoSummary } from '../../../shared/types.ts';
import { useAnnotations } from '../hooks/useAnnotations.ts';
import { EMPTY_MEMO_FILTER, filterMemos, memoLines, memoTagCounts } from '../lib/annotations/memoList.ts';
import { confirmDialog } from '../lib/confirm.ts';
import { formatTime } from '../lib/format.ts';
import { formatClock } from '../lib/recording/timeline.ts';
import { toast } from '../lib/toast.ts';
import { PopoverMenu } from './organize/PopoverMenu.tsx';

interface MemoListPanelProps {
  docId: string;
  focusedSlide: number;
  /** A row was clicked: show the memo on its slide (selected and expanded). */
  onOpenMemo: (slide: number, id: string) => void;
  onGoToSlide: (slide: number) => void;
  /** A memo's 🎙 chip: play that moment in the 녹음 tab. */
  onPlayRecording: (rid: string, t: number) => void;
}

export function MemoListPanel({ docId, focusedSlide, onOpenMemo, onGoToSlide, onPlayRecording }: MemoListPanelProps) {
  const { store, snapshot } = useAnnotations(docId);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [currentOnly, setCurrentOnly] = useState(false);
  const summary = snapshot.summary;
  const memos = summary?.memos ?? [];
  const tags = useMemo(() => memoTagCounts(memos), [memos]);
  const shown = useMemo(
    () => filterMemos(memos, { ...EMPTY_MEMO_FILTER, query, tag, slide: currentOnly ? focusedSlide : null }),
    [memos, query, tag, currentOnly, focusedSlide],
  );
  const filtering = query.trim() !== '' || tag !== null || currentOnly;

  const remove = async (m: MemoSummary) => {
    if (!store) return;
    if (m.text.trim() !== '') {
      const ok = await confirmDialog({ title: '메모를 지울까요?', message: memoLines(m.text)[0], confirmLabel: '삭제', danger: true });
      if (!ok) return;
    }
    const doc = await store.ensureSlide(m.slide);
    if (!doc || !doc.items.some((it) => it.id === m.id)) {
      toast('그 메모는 이미 지워졌어요', 'info');
      return;
    }
    store.mutate(m.slide, [{ op: 'remove', id: m.id }]);
  };

  return (
    <div className="notes-panel memo-panel">
      <div className="notes-toolbar">
        <input
          className="memo-search"
          type="search"
          value={query}
          placeholder="메모·태그 검색"
          aria-label="메모·태그 검색"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="checkbox">
          <input type="checkbox" checked={currentOnly} onChange={(e) => setCurrentOnly(e.target.checked)} />
          현재 슬라이드만
        </label>
        <span className="spacer" />
        <button type="button" className="ghost-btn small" onClick={() => void store?.ensureSummary(true)} title="새로고침">
          ↻
        </button>
      </div>
      {tags.length > 0 && (
        <div className="memo-tag-bar" role="group" aria-label="태그로 거르기">
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              className={t.tag === tag ? 'filter-chip is-active' : 'filter-chip is-quiet'}
              aria-pressed={t.tag === tag}
              onClick={() => setTag((current) => (current === t.tag ? null : t.tag))}
              title={t.tag === tag ? '태그 필터 해제' : `#${t.tag} 메모만 보기`}
            >
              #{t.tag} <span className="memo-tag-count">{t.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="notes-scroll">
        {snapshot.summaryError && !summary && <div className="inline-error">⚠️ 메모를 불러오지 못했어요: {snapshot.summaryError}</div>}
        {!summary && !snapshot.summaryError && <div className="notes-empty muted">불러오는 중…</div>}
        {summary && memos.length === 0 && (
          <div className="notes-empty">
            <div className="chat-empty-icon" aria-hidden>
              🗒
            </div>
            <p>아직 메모가 없어요.</p>
            <p className="muted small">슬라이드 위 도구의 🗒 메모로 스티커 메모를 붙일 수 있어요. 태그와 다른 슬라이드·녹음으로의 연결도 돼요.</p>
          </div>
        )}
        {summary && memos.length > 0 && shown.length === 0 && (
          <div className="notes-empty muted">{filtering ? '조건에 맞는 메모가 없어요.' : '메모가 없어요.'}</div>
        )}
        {shown.map((m) => {
          const [first, second] = memoLines(m.text);
          const recording = m.links.find((l) => l.kind === 'recording');
          return (
            <div
              key={m.id}
              className={`memo-row is-${m.color}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpenMemo(m.slide, m.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenMemo(m.slide, m.id);
                }
              }}
              title="슬라이드에서 이 메모 열기"
            >
              <span className="memo-row-bar" aria-hidden />
              <div className="memo-row-main">
                <div className="memo-row-head">
                  <button
                    type="button"
                    className="slide-chip"
                    onClick={(e) => {
                      e.stopPropagation();
                      onGoToSlide(m.slide);
                    }}
                    title={`슬라이드 ${m.slide}로 이동`}
                  >
                    p.{m.slide}
                  </button>
                  <span className="muted small">{formatTime(m.updatedAt)}</span>
                  {!m.tutor && (
                    <span className="muted small" title="튜터에게 보이지 않는 메모">
                      🙈
                    </span>
                  )}
                </div>
                <div className="memo-row-line">{first}</div>
                {second && <div className="memo-row-line is-second">{second}</div>}
                {(m.tags.length > 0 || recording) && (
                  <div className="memo-row-tags">
                    {m.tags.map((t) => (
                      <span key={t} className="memo-tag">
                        #{t}
                      </span>
                    ))}
                    {recording && recording.kind === 'recording' && (
                      <button
                        type="button"
                        className="memo-link-go"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPlayRecording(recording.rid, recording.t);
                        }}
                        title="녹음의 이 순간 듣기 (녹음 탭)"
                      >
                        🎙 {formatClock(recording.t)}
                      </button>
                    )}
                  </div>
                )}
              </div>
              <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                <PopoverMenu
                  label="메모 메뉴"
                  sections={[
                    {
                      items: [
                        { key: 'open', label: '슬라이드에서 열기', onSelect: () => onOpenMemo(m.slide, m.id) },
                        { key: 'delete', label: '메모 삭제', danger: true, onSelect: () => void remove(m) },
                      ],
                    },
                  ]}
                />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
