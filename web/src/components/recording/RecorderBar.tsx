// The live recording in the app's chrome (DESIGN §22): the top bar's round microphone button, which becomes the running
// recording (timer, level meter, pause, stop — seen from every page, the library included) in the same place, and the
// strip under the bar (the live transcript, a recording a reload interrupted, microphone problems).
import { ChevronDown, ChevronUp, Mic, NotebookPen, Pause, Play, Save, Smartphone, Square, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { DocMeta } from '../../../../shared/types.ts';
import { useRecorder, useRecorderLevel } from '../../hooks/useRecorder.ts';
import { useRecordingFeed } from '../../hooks/useRecordingFeed.ts';
import { msg } from '../../i18n/index.ts';
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
  const m = msg().recording.bar;
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
        aria-label={m.start}
        title={unavailable ?? m.startTitle}
      >
        <Mic />
      </button>
    );
  }

  if (rec.phase === 'starting') {
    return (
      <span className="rec-bar is-starting" role="status">
        <Mic /> {m.startingMic}
      </span>
    );
  }

  const otherDoc = rec.docId && doc?.id !== rec.docId ? (docs?.find((d) => d.id === rec.docId) ?? null) : null;
  if (rec.phase === 'stopping') {
    return (
      <span className="rec-bar is-stopping" role="status" title={m.savingTitle}>
        <Save /> {rec.unsentSeconds > 0 ? m.savingLeft(formatSpan(rec.unsentSeconds)) : m.saving}
      </span>
    );
  }

  const paused = rec.phase === 'paused';
  const trouble = rec.authRequired ? m.loginToContinue : rec.offline ? m.offline(formatSpan(rec.unsentSeconds)) : null;
  return (
    <div className={paused ? 'rec-bar is-paused' : 'rec-bar is-recording'} role="group" aria-label={m.label}>
      <button
        type="button"
        className="rec-bar-main"
        onClick={() => (otherDoc ? onOpenDoc(otherDoc.id) : onShowRecordings())}
        title={otherDoc ? m.otherDocTitle(otherDoc.title) : m.thisDocTitle(rec.title)}
      >
        <span className={paused ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden />
        <span className="rec-time">{formatClock(rec.seconds)}</span>
        {paused && <span className="rec-state">{m.paused}</span>}
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
        <button type="button" className="icon-btn small" onClick={() => run(resumeRecording)} disabled={busy} title={m.resume} aria-label={m.resume}>
          <Play fill="currentColor" />
        </button>
      ) : (
        <button
          type="button"
          className="icon-btn small"
          onClick={() => run(() => recorder.pause())}
          disabled={busy}
          title={m.pauseTitle}
          aria-label={m.pause}
        >
          <Pause fill="currentColor" />
        </button>
      )}
      <button
        type="button"
        className="icon-btn small rec-stop"
        onClick={() => run(stopRecording)}
        disabled={busy}
        title={m.stopTitle}
        aria-label={m.stop}
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

  const m = msg().recording.strip;
  const segments = feed?.segments ?? [];
  const shown = collapsed ? segments.slice(-1) : segments.slice(-4);
  const transcribed = feed?.info?.transcribedSec ?? 0;
  const lag = transcriptLag(rec.seconds, transcribed);

  return (
    <div className="rec-strip" role="region" aria-label={m.label}>
      {interrupted.map((r) => (
        <div key={r.id} className="rec-strip-row is-interrupted">
          <span>
            <Mic />{' '}
            {r.unsentSeconds > 0
              ? m.interruptedSending(<b>‘{r.title}’</b>, formatClock(r.seconds), formatSpan(r.unsentSeconds))
              : m.interrupted(<b>‘{r.title}’</b>, formatClock(r.seconds))}
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
            <Mic /> {m.continue}
          </button>
          <button
            type="button"
            className="ghost-btn small"
            disabled={busy !== null}
            onClick={() => {
              setBusy(r.id);
              void recorder.finishInterrupted(r.id).finally(() => setBusy(null));
            }}
            title={m.finishHereTitle}
          >
            {m.finishHere}
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
            <TriangleAlert /> {m.notPersistent}
          </span>
        </div>
      )}
      {live && ios && (
        <div className="rec-strip-row is-note">
          <span>
            <Smartphone /> {m.iosKeepOpen}
          </span>
        </div>
      )}

      {live && (
        <div className={collapsed ? 'rec-live is-collapsed' : 'rec-live'}>
          <div className="rec-live-head">
            <span className="rec-live-title">
              <NotebookPen /> {m.liveTitle}
            </span>
            {rec.liveTranscribe ? (
              <span className="muted small">
                {segments.length === 0 ? m.waitingFirst : lag >= 5 ? m.behind(formatSpan(lag)) : m.nearlyLive}
              </span>
            ) : (
              <span className="muted small">{m.afterStop}</span>
            )}
            <span className="spacer" />
            <button type="button" className="ghost-btn tiny" onClick={onShowRecordings}>
              {m.recordingTab}
            </button>
            {rec.liveTranscribe && (
              <button
                type="button"
                className="ghost-btn tiny"
                onClick={toggle}
                aria-expanded={!collapsed}
                title={collapsed ? m.expandTitle : m.collapseTitle}
              >
                {collapsed ? (
                  <>
                    {m.expand} <ChevronDown />
                  </>
                ) : (
                  <>
                    {m.collapse} <ChevronUp />
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
