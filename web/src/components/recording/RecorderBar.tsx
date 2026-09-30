// The live recording in the app's chrome (DESIGN §22): the top bar's round microphone button, which becomes the running
// recording (timer, level meter, pause, stop — seen from every page, the library included) in the same place, and the
// strip under the bar (the live transcript, a recording a reload interrupted, microphone problems).
import { ChevronDown, ChevronUp, Mic, NotebookPen, Pause, Play, Save, Smartphone, Square, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { DocMeta } from '../../../../shared/types.ts';
import { useRecorder, useRecorderLevel } from '../../hooks/useRecorder.ts';
import { useRecordingFeed } from '../../hooks/useRecordingFeed.ts';
import { continueRecording, resumeRecording, startRecording, stopRecording } from '../../lib/recording/actions.ts';
import { detectPlatform } from '../../lib/recording/labels.ts';
import { recorder } from '../../lib/recording/recorder.ts';
import { formatClock, formatSpan, transcriptLag } from '../../lib/recording/timeline.ts';
import { isBoolean, readStorage, storageKeys, writeStorage } from '../../lib/storage.ts';

function LevelMeter() {
  const level = useRecorderLevel();
  return (
    <span className="rec-meter" aria-hidden>
      <span className="rec-meter-fill" style={{ transform: `scaleX(${level.toFixed(3)})` }} />
    </span>
  );
}

interface RecordControlProps {
  /** The lecture open in the viewer (ready), or null. */
  doc: DocMeta | null;
  focusedSlide: number;
  docs: DocMeta[] | null;
  onOpenDoc: (docId: string) => void;
  /** Show the 녹음 tab of the open lecture. */
  onShowRecordings: () => void;
}

/**
 * In the top bar: the record button — a round microphone, no text (0.6.4: the bar had grown too long) — or, in its
 * place, the running recording's timer and controls.
 */
export function RecordControl({ doc, focusedSlide, docs, onOpenDoc, onShowRecordings }: RecordControlProps) {
  const rec = useRecorder();
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void fn().finally(() => setBusy(false));
  };

  if (rec.phase === 'idle') {
    if (!doc) return null;
    const unavailable = recorder.unavailableReason();
    return (
      <button
        type="button"
        className={unavailable ? 'rec-start is-unavailable' : 'rec-start'}
        onClick={() => run(() => startRecording(doc.id, focusedSlide))}
        disabled={busy}
        aria-label="녹음 시작"
        title={unavailable ?? '녹음 시작 — 이 강의를 녹음하고 바로 받아써요 (교수님이 한 말을 튜터가 함께 알게 돼요)'}
      >
        <Mic />
      </button>
    );
  }

  if (rec.phase === 'starting') {
    return (
      <span className="rec-bar is-starting" role="status">
        <Mic /> 마이크 준비 중…
      </span>
    );
  }

  const otherDoc = rec.docId && doc?.id !== rec.docId ? (docs?.find((d) => d.id === rec.docId) ?? null) : null;
  if (rec.phase === 'stopping') {
    return (
      <span className="rec-bar is-stopping" role="status" title="남은 녹음을 서버로 보내고 있어요">
        <Save /> 녹음 저장 중{rec.unsentSeconds > 0 ? ` · ${formatSpan(rec.unsentSeconds)} 남음` : '…'}
      </span>
    );
  }

  const paused = rec.phase === 'paused';
  const trouble = rec.authRequired
    ? '로그인하면 이어서 보내요'
    : rec.offline
      ? `서버에 연결되지 않아 이 기기에 보관 중 (${formatSpan(rec.unsentSeconds)})`
      : null;
  return (
    <div className={paused ? 'rec-bar is-paused' : 'rec-bar is-recording'} role="group" aria-label="녹음 중">
      <button
        type="button"
        className="rec-bar-main"
        onClick={() => (otherDoc ? onOpenDoc(otherDoc.id) : onShowRecordings())}
        title={
          otherDoc
            ? `‘${otherDoc.title}’ 강의를 녹음하고 있어요 — 클릭하면 그 강의로 가요`
            : `‘${rec.title}’ 녹음 — 클릭하면 녹음 탭을 열어요`
        }
      >
        <span className={paused ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden />
        <span className="rec-time">{formatClock(rec.seconds)}</span>
        {paused && <span className="rec-state">일시정지</span>}
        {otherDoc && <span className="rec-doc">· {otherDoc.title}</span>}
      </button>
      {!paused && <LevelMeter />}
      {trouble && (
        <span className="rec-trouble" title={rec.uploadError ?? trouble}>
          <TriangleAlert />
          <span className="rec-trouble-text"> {trouble}</span>
        </span>
      )}
      {paused ? (
        <button type="button" className="icon-btn small" onClick={() => run(resumeRecording)} disabled={busy} title="녹음 계속" aria-label="녹음 계속">
          <Play fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn small"
          onClick={() => run(() => recorder.pause())}
          disabled={busy}
          title="일시정지 (쉬는 시간 등)"
          aria-label="녹음 일시정지"
        >
          <Pause fill="currentColor" />
        </button>
      )}
      <button
        type="button"
        className="icon-btn small rec-stop"
        onClick={() => run(stopRecording)}
        disabled={busy}
        title="녹음 끝내기 — 남은 받아쓰기와 슬라이드 정렬이 이어서 진행돼요"
        aria-label="녹음 끝내기"
      >
        <Square fill="currentColor" />
      </button>
    </div>
  );
}

/** Under the top bar: the live transcript, an interrupted recording to continue, recording problems. */
export function RecordingStrip({ onShowRecordings }: { onShowRecordings: () => void }) {
  const rec = useRecorder();
  const [collapsed, setCollapsed] = useState(() => readStorage(storageKeys.liveStripCollapsed, false, isBoolean));
  const live = rec.phase === 'recording' || rec.phase === 'paused';
  const feed = useRecordingFeed(live ? rec.docId : null, live ? rec.recordingId : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [ios] = useState(() => detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0) === 'ios');

  const interrupted = rec.phase === 'idle' ? rec.interrupted : [];
  if (!live && interrupted.length === 0) return null;

  const toggle = () => {
    setCollapsed((c) => {
      writeStorage(storageKeys.liveStripCollapsed, !c);
      return !c;
    });
  };

  const segments = feed?.segments ?? [];
  const shown = collapsed ? segments.slice(-1) : segments.slice(-4);
  const transcribed = feed?.info?.transcribedSec ?? 0;
  const lag = transcriptLag(rec.seconds, transcribed);

  return (
    <div className="rec-strip" role="region" aria-label="녹음">
      {interrupted.map((r) => (
        <div key={r.id} className="rec-strip-row is-interrupted">
          <span>
            <Mic /> <b>‘{r.title}’</b> 녹음이 중간에 멈췄어요 ({formatClock(r.seconds)}까지 저장됨
            {r.unsentSeconds > 0 ? ` · 서버로 보내는 중 ${formatSpan(r.unsentSeconds)}` : ''}).
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="ghost-btn small accent"
            disabled={busy !== null}
            onClick={() => {
              setBusy(r.id);
              void continueRecording(r.id).finally(() => setBusy(null));
            }}
          >
            <Mic /> 이어서 녹음
          </button>
          <button
            type="button"
            className="ghost-btn small"
            disabled={busy !== null}
            onClick={() => {
              setBusy(r.id);
              void recorder.finishInterrupted(r.id).finally(() => setBusy(null));
            }}
            title="지금까지 녹음한 것만 저장하고 받아쓰기를 끝까지 해요"
          >
            여기서 끝내기
          </button>
        </div>
      ))}

      {live && rec.micProblem && (
        <div className="rec-strip-row is-warn">
          <span>
            <TriangleAlert /> {rec.micProblem}
          </span>
        </div>
      )}
      {live && !rec.persistent && (
        <div className="rec-strip-row is-warn">
          <span>
            <TriangleAlert /> 이 브라우저는 녹음을 기기에 임시 저장하지 못해요. 새로고침하거나 창을 닫으면 아직 서버로 못 보낸 부분을
            잃을 수 있어요.
          </span>
        </div>
      )}
      {live && ios && (
        <div className="rec-strip-row is-note">
          <span>
            <Smartphone /> 녹음하는 동안 이 화면을 켠 채로 열어 두세요 (다른 앱으로 가거나 화면이 꺼지면 녹음이 멈춰요).
          </span>
        </div>
      )}

      {live && (
        <div className={collapsed ? 'rec-live is-collapsed' : 'rec-live'}>
          <div className="rec-live-head">
            <span className="rec-live-title">
              <NotebookPen /> 실시간 받아쓰기
            </span>
            {rec.liveTranscribe ? (
              <span className="muted small">
                {segments.length === 0
                  ? '첫 문장을 기다리는 중…'
                  : lag >= 5
                    ? `${formatSpan(lag)} 늦게 따라가는 중`
                    : '거의 실시간'}
              </span>
            ) : (
              <span className="muted small">녹음을 끝내면 받아써요 (설정에서 바꿀 수 있어요)</span>
            )}
            <span className="spacer" />
            <button type="button" className="ghost-btn tiny" onClick={onShowRecordings}>
              녹음 탭
            </button>
            {rec.liveTranscribe && (
              <button
                type="button"
                className="ghost-btn tiny"
                onClick={toggle}
                aria-expanded={!collapsed}
                title={collapsed ? '최근 문장 몇 줄 더 보기' : '마지막 한 줄만 보기'}
              >
                {collapsed ? (
                  <>
                    펼치기 <ChevronDown />
                  </>
                ) : (
                  <>
                    접기 <ChevronUp />
                  </>
                )}
              </button>
            )}
          </div>
          {rec.liveTranscribe && shown.length > 0 && (
            <ol className="rec-live-lines" aria-live="polite">
              {shown.map((s) => (
                <li key={s.id}>
                  <span className="rec-live-time">{formatClock(s.start)}</span> {s.text}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
