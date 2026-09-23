import { useState } from 'react';
import type { Course, DocMeta, ProviderId, ProviderInfo, SessionSummary } from '../../../shared/types.ts';
import { notesMarkdownUrl } from '../api.ts';
import type { ProviderChoice } from '../hooks/useProviderChoice.ts';
import { formatTime, providerWithModel } from '../lib/format.ts';

const UPLOAD = '__upload__';
const NEW_SESSION = '__new__';
const CUSTOM_MODEL = '__custom__';

interface TopBarProps {
  docs: DocMeta[] | null;
  doc: DocMeta | null;
  /** Courses in creation order (null while loading / unavailable). */
  courses: Course[] | null;
  onSelectDoc: (docId: string | null) => void;
  onUploadClick: () => void;
  /** Course that "＋ PDF 추가" uploads into (null = uncategorized). */
  uploadCourse: Course | null;

  /** Session controls are shown only for a ready doc. */
  sessions: SessionSummary[] | null;
  sessionId: string | null;
  sessionBusy: boolean;
  onSelectSession: (sid: string) => void;
  onNewSession: () => void;
  onDeleteSession: (sid: string) => void;

  providers: ProviderInfo[] | undefined;
  providersLoading: boolean;
  choice: ProviderChoice | null;
  onChoiceChange: (choice: ProviderChoice) => void;
  hasNotes: boolean;
}

function docOptionLabel(d: DocMeta, index?: number): string {
  const name = index === undefined ? d.title : `${index}. ${d.title}`;
  if (d.status === 'processing') {
    const pct = d.pageCount > 0 ? Math.round((d.progress / d.pageCount) * 100) : 0;
    return `${name} (처리 중 ${pct}%)`;
  }
  if (d.status === 'error') return `${name} (오류)`;
  const badge = d.digestStatus === 'ready' ? ' · ✓ 정리본' : d.digestStatus === 'running' ? ' · ⏳ 정리 중' : '';
  return `${name} · ${d.pageCount}장${badge}`;
}

/** Document picker options: one <optgroup> per course (lectures in order) + "미분류" (only when courses exist). */
function DocOptions({ docs, courses }: { docs: DocMeta[]; courses: Course[] }) {
  if (courses.length === 0) {
    return docs.map((d) => (
      <option key={d.id} value={d.id}>
        {docOptionLabel(d)}
      </option>
    ));
  }
  const byId = new Map(docs.map((d) => [d.id, d]));
  const placed = new Set<string>();
  const groups = courses.map((c) => {
    const lectures = c.docIds
      .filter((id) => !placed.has(id))
      .map((id) => byId.get(id))
      .filter((d): d is DocMeta => d !== undefined);
    for (const d of lectures) placed.add(d.id);
    return (
      <optgroup key={c.id} label={`📁 ${c.title}`}>
        {lectures.length === 0 ? (
          <option disabled value={`__empty:${c.id}`}>
            (강의 없음)
          </option>
        ) : (
          lectures.map((d, i) => (
            <option key={d.id} value={d.id}>
              {docOptionLabel(d, i + 1)}
            </option>
          ))
        )}
      </optgroup>
    );
  });
  const rest = docs.filter((d) => !placed.has(d.id));
  return (
    <>
      {groups}
      {rest.length > 0 && (
        <optgroup label="미분류">
          {rest.map((d) => (
            <option key={d.id} value={d.id}>
              {docOptionLabel(d)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export function TopBar(props: TopBarProps) {
  const { docs, doc, sessions, sessionId, providers } = props;
  const ready = doc?.status === 'ready';

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => props.onSelectDoc(null)} title="라이브러리로">
        <span aria-hidden>📖</span> easy-study
      </button>

      <select
        className="picker doc-picker"
        aria-label="문서 선택"
        value={doc?.id ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === UPLOAD) props.onUploadClick();
          else props.onSelectDoc(v || null);
        }}
      >
        <option value="">{docs && docs.length > 0 ? '📚 문서 선택…' : '📚 문서 없음'}</option>
        <DocOptions docs={docs ?? []} courses={props.courses ?? []} />
        <option value={UPLOAD}>{props.uploadCourse ? `＋ PDF 추가 (📁 ${props.uploadCourse.title})` : '＋ PDF 추가'}</option>
      </select>

      {ready && (
        <div className="session-controls">
          <select
            className="picker session-picker"
            aria-label="세션 선택"
            value={sessionId ?? ''}
            disabled={sessions === null}
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_SESSION) props.onNewSession();
              else if (v) props.onSelectSession(v);
            }}
          >
            {!sessionId && <option value="">{sessions === null ? '세션 불러오는 중…' : '💬 세션 없음'}</option>}
            {(sessions ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.title} · {providerWithModel(providers, s.provider, s.model)} · 메시지 {s.messageCount}개 ·{' '}
                {formatTime(s.updatedAt)}
              </option>
            ))}
            <option value={NEW_SESSION} disabled={props.sessionBusy || !props.choice}>
              ＋ 새 세션
            </option>
          </select>
          {sessionId && (
            <button
              type="button"
              className="icon-btn"
              title="이 세션 삭제"
              disabled={props.sessionBusy}
              onClick={() => {
                if (window.confirm('이 세션과 대화 기록(노트 포함)을 삭제할까요? 되돌릴 수 없어요.')) {
                  props.onDeleteSession(sessionId);
                }
              }}
            >
              🗑
            </button>
          )}
        </div>
      )}

      <span className="spacer" />

      <ProviderPicker
        providers={providers}
        loading={props.providersLoading}
        choice={props.choice}
        onChange={props.onChoiceChange}
      />

      {ready && doc && (
        <a
          className={props.hasNotes ? 'ghost-btn' : 'ghost-btn is-disabled'}
          href={notesMarkdownUrl(doc.id)}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!props.hasNotes}
          onClick={(e) => {
            if (!props.hasNotes) e.preventDefault();
          }}
          title={props.hasNotes ? 'STUDY_NOTES.md 열기' : '아직 저장된 Q&A가 없어요'}
        >
          📝 노트 파일
        </a>
      )}
    </header>
  );
}

function ProviderPicker({
  providers,
  loading,
  choice,
  onChange,
}: {
  providers: ProviderInfo[] | undefined;
  loading: boolean;
  choice: ProviderChoice | null;
  onChange: (choice: ProviderChoice) => void;
}) {
  const current = providers?.find((p) => p.id === choice?.provider);
  const knownModel = !!current && current.models.some((m) => m.id === (choice?.model ?? ''));
  const [customMode, setCustomMode] = useState(false);
  const showCustom = !!choice && (customMode || !knownModel);
  const unavailable = (providers ?? []).filter((p) => !p.available);
  const unavailableTitle = unavailable.map((p) => `${p.label}: ${p.reason ?? '사용 불가'}`).join('\n');

  if (!providers) {
    return <span className="provider-picker muted small">{loading ? 'LLM 확인 중…' : 'LLM 정보 없음'}</span>;
  }

  return (
    <div className="provider-picker" title="새 세션에 사용할 LLM">
      <span className="provider-picker-label">새 세션</span>
      <select
        className="picker"
        aria-label="LLM 선택"
        value={choice?.provider ?? ''}
        onChange={(e) => {
          const p = providers.find((x) => x.id === (e.target.value as ProviderId));
          if (!p) return;
          setCustomMode(false);
          onChange({ provider: p.id, model: p.defaultModel });
        }}
      >
        {!choice && <option value="">사용 가능한 LLM 없음</option>}
        {providers.map((p) => (
          <option
            key={p.id}
            value={p.id}
            disabled={!p.available}
            title={p.available ? (p.version ? `버전 ${p.version}` : undefined) : p.reason}
          >
            {p.label}
            {p.available ? '' : ' — 사용 불가'}
          </option>
        ))}
      </select>
      {current && (
        <>
          <select
            className="picker model-picker"
            aria-label="모델 선택"
            value={showCustom ? CUSTOM_MODEL : (choice?.model ?? '')}
            onChange={(e) => {
              if (e.target.value === CUSTOM_MODEL) {
                setCustomMode(true);
                return;
              }
              setCustomMode(false);
              onChange({ provider: current.id, model: e.target.value });
            }}
          >
            {current.models.map((m) => (
              <option key={m.id || '__default'} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value={CUSTOM_MODEL}>직접 입력…</option>
          </select>
          {showCustom && (
            <>
              <input
                className="model-input"
                list={`models-${current.id}`}
                placeholder="모델 이름"
                aria-label="모델 이름 직접 입력"
                value={choice?.model ?? ''}
                onChange={(e) => onChange({ provider: current.id, model: e.target.value.trim() })}
              />
              <datalist id={`models-${current.id}`}>
                {current.models
                  .filter((m) => m.id)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
              </datalist>
            </>
          )}
        </>
      )}
      {unavailable.length > 0 && (
        <span className="provider-warn" title={unavailableTitle} aria-label={`사용 불가 LLM: ${unavailableTitle}`}>
          ⓘ
        </span>
      )}
    </div>
  );
}
