// Small pieces that show a live recording elsewhere (DESIGN §22): the composer chip "최근 N분 포함" (questions
// during a live recording of the lecture carry the recent speech) and the 녹음 tab badge. Each subscribes to the
// recorder itself, so the timer ticking does not re-render the chat.
import { CircleSmall, Mic, Pause } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { LIVE_SPEECH_IDLE_MS } from '../../../../shared/types.ts';
import { useRecordingFeed } from '../../hooks/useRecordingFeed.ts';
import { msg } from '../../i18n/index.ts';
import { recorder } from '../../lib/recording/recorder.ts';
import { recentMinutes } from '../../lib/recording/timeline.ts';

/**
 * Minutes of recent speech the next question of `docId` includes, or null: not recording this lecture, live
 * transcription off, nothing transcribed yet (the server adds the recent speech only once there is some), or paused
 * for longer than the server counts a recording as live (LIVE_SPEECH_IDLE_MS).
 */
function useSpeechMinutes(docId: string): { minutes: number; paused: boolean } | null {
  const key = useSyncExternalStore(recorder.subscribe, () => {
    const s = recorder.getSnapshot();
    if (s.docId !== docId || (s.phase !== 'recording' && s.phase !== 'paused') || !s.liveTranscribe || !s.recordingId) {
      return '';
    }
    return `${s.recordingId}|${recentMinutes(s.seconds)}|${s.phase === 'paused' ? (s.pausedAt ?? 0) : 0}`;
  });
  const [rid, minutes, pausedAt] = key ? key.split('|') : [null, '0', '0'];
  const pausedSince = Number(pausedAt);
  // Re-render when a long pause makes the recent speech stale.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pausedSince) return;
    const left = pausedSince + LIVE_SPEECH_IDLE_MS - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => window.clearTimeout(timer);
  }, [pausedSince]);
  // The same feed as the live transcript strip (one stream per recording).
  const feed = useRecordingFeed(rid ? docId : null, rid);
  if (!rid || !feed || feed.segments.length === 0) return null;
  if (pausedSince && Date.now() - pausedSince >= LIVE_SPEECH_IDLE_MS) return null;
  return { minutes: Number(minutes), paused: pausedSince > 0 };
}

export function LectureSpeechChip({ docId }: { docId: string }) {
  const speech = useSpeechMinutes(docId);
  if (!speech) return null;
  const m = msg().recording.speech;
  return (
    <div className="composer-context">
      <span className="speech-chip" title={m.chipTitle}>
        <Mic /> {m.recentMinutes(Math.max(1, speech.minutes))}
        {speech.paused ? ` · ${m.recordingPaused}` : ''}
      </span>
    </div>
  );
}

/** "녹음" tab badge: a red dot and REC while this lecture is being recorded, else the number of recordings. */
export function RecordingTabBadge({ docId, count }: { docId: string; count: number | null }) {
  const live = useSyncExternalStore(recorder.subscribe, () => {
    const s = recorder.getSnapshot();
    return s.docId === docId && s.phase !== 'idle' ? s.phase : null;
  });
  const m = msg().recording.status;
  if (live === 'recording' || live === 'starting') {
    return (
      <span className="tab-count is-live" title={m.recording}>
        <CircleSmall fill="currentColor" /> REC
      </span>
    );
  }
  if (live === 'paused') {
    return (
      <span className="tab-count is-warn" role="img" aria-label={m.paused} title={m.paused}>
        <Pause fill="currentColor" />
      </span>
    );
  }
  if (count && count > 0) return <span className="tab-count">{count}</span>;
  return null;
}
