// The 녹음 tab (DESIGN §22): record or upload, the recordings of this lecture (status / progress), speech
// recognition settings with the model download, and for the selected recording a player (speed, "슬라이드
// 따라가기"), its transcript (focused slide or all, click → play from there), "여기부터 p.N" markers, "AI 정밀
// 정렬", rename and delete.
import {
  Bot,
  Check,
  CircleSmall,
  Files,
  Hourglass,
  Lock,
  MapPin,
  MessageCircle,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Settings,
  TriangleAlert,
  Upload,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocMeta, ProviderId, ProviderInfo, RecordingInfo } from '../../../../shared/types.ts';
import * as api from '../../api.ts';
import { useAsrStatus } from '../../hooks/useAsrStatus.ts';
import { useMarkers } from '../../hooks/useMarkers.ts';
import type { ProviderChoice } from '../../hooks/useProviderChoice.ts';
import { useRecorder, useRecordingUploads } from '../../hooks/useRecorder.ts';
import { useRecordingFeed } from '../../hooks/useRecordingFeed.ts';
import type { RecordingsState } from '../../hooks/useRecordings.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { formatDate, formatTime } from '../../lib/format.ts';
import { finishRecordingElsewhere, recordedHere, startRecording } from '../../lib/recording/actions.ts';
import { recordingFeed, updateFeedInfo } from '../../lib/recording/feeds.ts';
import {
  RECORDING_ACCEPT,
  aiAlignModelLabel,
  alignmentLabel,
  durationLine,
  isLive,
  recordingLanguageLabel,
  recordingStatus,
  transcriptFraction,
  type RecordingStatus,
  type StatusIcon,
} from '../../lib/recording/labels.ts';
import type { MarkerAction } from '../../lib/recording/markers.ts';
import { markerShortLabel } from '../../lib/recording/markers.ts';
import { useReplayAnnotations } from '../../lib/annotations/settings.ts';
import { clearPlayhead, setPlayhead } from '../../lib/recording/playhead.ts';
import { recorder } from '../../lib/recording/recorder.ts';
import { isPlaybackRate } from '../../lib/recording/rate.ts';
import { formatClock, pastLoadedEnd, segmentIndexAt, slideAtTime } from '../../lib/recording/timeline.ts';
import { cancelRecordingUpload, uploadRecordingFiles } from '../../lib/recording/uploads.ts';
import { isBoolean, readStorage, storageKeys, writeStorage } from '../../lib/storage.ts';
import { toast } from '../../lib/toast.ts';
import { PopoverMenu } from '../organize/PopoverMenu.tsx';
import { ProgressBar } from '../organize/parts.tsx';
import { AsrNotice, AsrSettings } from './AsrSettings.tsx';
import { PlaybackRate } from './PlaybackRate.tsx';
import { Transcript, type TranscriptMode } from './Transcript.tsx';

const isMode = (v: unknown): v is TranscriptMode => v === 'current' || v === 'all';

/** Why the player could not play (kept as a key, so the text follows a language change). */
type AudioError = 'format' | 'play' | 'pressPlay' | 'load';

/**
 * "Play this moment" (a memo's recording chip, DESIGN §25): the recording and the time; `seq` makes repeats distinct.
 */
export interface PlayRequest {
  rid: string;
  t: number;
  seq: number;
}

interface RecordingsPanelProps {
  doc: DocMeta;
  focusedSlide: number;
  /** The tab is shown (the ASR status loads, the list polls while something is in progress). */
  active: boolean;
  providers: ProviderInfo[] | undefined;
  /** Provider chosen for new sessions: the default of "AI 정밀 정렬". */
  choice: ProviderChoice | null;
  recordings: RecordingsState;
  onGoToSlide: (slide: number) => void;
  /** Play a moment of a recording of this lecture (selects it; the live recording still wins). */
  playRequest?: PlayRequest | null;
}

export function RecordingsPanel({ doc, focusedSlide, active, providers, choice, recordings, onGoToSlide, playRequest = null }: RecordingsPanelProps) {
  const rec = useRecorder();
  const asr = useAsrStatus(active);
  const uploads = useRecordingUploads().filter((u) => u.docId === doc.id);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const list = recordings.list;

  // The selected recording: the one being recorded here, else the one picked, else the newest.
  const [picked, setPicked] = useState<string | null>(null);
  const liveHere = rec.docId === doc.id && rec.recordingId ? rec.recordingId : null;
  useEffect(() => {
    if (liveHere) setPicked(liveHere);
  }, [liveHere]);
  useEffect(() => {
    if (playRequest && !liveHere) setPicked(playRequest.rid);
  }, [playRequest, liveHere]);
  const selected = list?.find((r) => r.id === picked) ?? list?.[0] ?? null;

  const recordingHere = rec.phase !== 'idle' && rec.docId === doc.id;
  const recordingElsewhere = rec.phase !== 'idle' && rec.docId !== doc.id;
  const uploadDisabled = asr.status !== null && !asr.status.ffmpegAvailable;

  const pickFiles = () => fileRef.current?.click();
  const m = msg().recording.panel;
  const statusText = msg().recording.status;

  return (
    <div className="rec-panel">
      <div className="notes-toolbar rec-toolbar">
        {recordingHere ? (
          <button
            type="button"
            className="ghost-btn small rec-live-chip"
            onClick={() => rec.recordingId && setPicked(rec.recordingId)}
            title={m.liveChipTitle}
          >
            <span className={rec.phase === 'paused' ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden />
            {rec.phase === 'stopping' ? m.saving : rec.phase === 'paused' ? statusText.paused : statusText.recording} {formatClock(rec.seconds)}
          </button>
        ) : (
          <button
            type="button"
            className="ghost-btn small accent"
            disabled={recordingElsewhere || rec.phase === 'starting'}
            onClick={() => void startRecording(doc.id, focusedSlide)}
            title={recordingElsewhere ? m.recordingElsewhere : (recorder.unavailableReason() ?? m.startTitle)}
          >
            <Mic /> {m.start}
          </button>
        )}
        <button
          type="button"
          className="ghost-btn small"
          onClick={pickFiles}
          disabled={uploadDisabled}
          title={uploadDisabled ? m.uploadNoFfmpeg : m.uploadTitle}
        >
          <Upload /> {m.upload}
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={settingsOpen ? 'ghost-btn small is-active' : 'ghost-btn small'}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}
          title={m.settingsTitle}
        >
          <Settings /> {msg().common.settings}
        </button>
        <button
          type="button"
          className="ghost-btn small"
          onClick={() => void recordings.refresh()}
          title={m.refresh}
          aria-label={m.refresh}
        >
          <RefreshCw />
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={RECORDING_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) void uploadRecordingFiles(doc.id, doc.title, files);
        }}
      />

      <div className="rec-top">
        {settingsOpen && <AsrSettings asr={asr} />}
        <AsrNotice asr={asr} />
        {uploads.map((u) => (
          <div key={u.id} className="rec-upload">
            <div className="rec-upload-line">
              <span className="rec-upload-name">
                <Upload /> {u.name}
              </span>
              <span className="muted small">{Math.round(u.fraction * 100)}%</span>
              <button type="button" className="ghost-btn tiny" onClick={() => cancelRecordingUpload(u.id)}>
                {msg().common.cancel}
              </button>
            </div>
            <ProgressBar fraction={u.fraction} />
          </div>
        ))}
        {recordings.error && (
          <div className="inline-error">
            <TriangleAlert /> {m.listFailed(recordings.error)}{' '}
            <button type="button" className="ghost-btn small" onClick={() => void recordings.refresh()}>
              {msg().common.retry}
            </button>
          </div>
        )}
        {list === null && !recordings.error && <div className="notes-empty muted">{msg().common.loading}</div>}
        {list !== null && list.length === 0 && uploads.length === 0 && (
          <div className="rec-empty">
            <div className="chat-empty-icon" aria-hidden>
              <Mic />
            </div>
            <h3>{m.emptyTitle}</h3>
            <p>
              {m.emptyBody(
                <b>
                  <Mic /> {m.start}
                </b>,
                <b>
                  <Upload /> {m.upload}
                </b>,
              )}
            </p>
            <ul className="tips">
              <li><MessageCircle /> {m.tipAsk}</li>
              <li><Files /> {m.tipSlides}</li>
              <li><Play /> {m.tipReplay}</li>
              <li><Lock /> {m.tipLocal}</li>
            </ul>
          </div>
        )}
        {list !== null && list.length > 0 && (
          <ul className="rec-list" aria-label={m.list}>
            {list.map((r) => (
              <RecordingRow key={r.id} info={r} selected={r.id === selected?.id} onSelect={() => setPicked(r.id)} />
            ))}
          </ul>
        )}
      </div>

      {selected && (
        <RecordingDetail
          key={selected.id}
          doc={doc}
          info={selected}
          focusedSlide={focusedSlide}
          providers={providers}
          choice={choice}
          recordings={recordings}
          onGoToSlide={onGoToSlide}
          playRequest={playRequest}
        />
      )}
    </div>
  );
}

const STATUS_ICONS: Record<StatusIcon, LucideIcon> = {
  live: CircleSmall,
  paused: Pause,
  waiting: Hourglass,
  warning: TriangleAlert,
  done: Check,
};

/** The status icons drawn solid, like the media glyphs they replace (● ⏸). */
const SOLID_STATUS: ReadonlySet<StatusIcon> = new Set(['live', 'paused']);

/** A recording's status badge: its icon and text. */
function StatusBadge({ status }: { status: RecordingStatus }) {
  const Icon = status.icon ? STATUS_ICONS[status.icon] : null;
  return (
    <span className={`rec-badge tone-${status.tone}`} title={status.title}>
      {Icon && (
        <>
          <Icon fill={status.icon && SOLID_STATUS.has(status.icon) ? 'currentColor' : 'none'} />{' '}
        </>
      )}
      {status.text}
    </span>
  );
}

function RecordingRow({ info, selected, onSelect }: { info: RecordingInfo; selected: boolean; onSelect: () => void }) {
  // The feed (when open) has the freshest status of the selected / live recording.
  const feed = useRecordingFeed(selected ? info.docId : null, selected ? info.id : null, info);
  const r = feed?.info ?? info;
  const status = recordingStatus(r);
  const f = r.status === 'ready' && r.transcriptStatus === 'running' ? transcriptFraction(r) : null;
  return (
    <li className={selected ? 'rec-row is-selected' : 'rec-row'}>
      <button type="button" className="rec-row-main" onClick={onSelect} aria-current={selected ? 'true' : undefined}>
        <span className="rec-row-title">
          {r.source === 'live' ? <Mic /> : <Upload />} {r.title}
        </span>
        <span className="rec-row-sub">
          <StatusBadge status={status} />
          <span className="muted small">
            {formatDate(r.createdAt)} {formatTime(r.createdAt)} · {durationLine(r)}
            {r.language === 'auto' && r.detectedLanguage ? ` · ${recordingLanguageLabel(r)}` : ''}
          </span>
        </span>
        {f !== null && <ProgressBar fraction={f} />}
      </button>
    </li>
  );
}

interface DetailProps {
  doc: DocMeta;
  info: RecordingInfo;
  focusedSlide: number;
  providers: ProviderInfo[] | undefined;
  choice: ProviderChoice | null;
  recordings: RecordingsState;
  onGoToSlide: (slide: number) => void;
  playRequest: PlayRequest | null;
}

function RecordingDetail({ doc, info: listInfo, focusedSlide, providers, choice, recordings, onGoToSlide, playRequest }: DetailProps) {
  const feed = useRecordingFeed(doc.id, listInfo.id, listInfo);
  const info = feed?.info ?? listInfo;
  const segments = feed?.segments ?? [];
  const live = isLive(info);
  const refreshList = recordings.refresh;
  const onMarkersSaved = useCallback(() => void refreshList(), [refreshList]);
  const { markers, pending: markersPending, apply: applyMarker } = useMarkers(
    doc.id,
    info.id,
    doc.pageCount,
    onMarkersSaved,
    feed?.markers ?? null,
  );
  const aligning = feed?.aligning ?? false;

  const [mode, setModeState] = useState<TranscriptMode>(() => readStorage(storageKeys.transcriptMode, 'all', isMode));
  const setMode = (m: TranscriptMode) => {
    setModeState(m);
    writeStorage(storageKeys.transcriptMode, m);
  };
  const [follow, setFollowState] = useState(() => readStorage(storageKeys.followSlides, true, isBoolean));
  const setFollow = (on: boolean) => {
    setFollowState(on);
    writeStorage(storageKeys.followSlides, on);
  };

  // ---- player -------------------------------------------------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(() => readStorage(storageKeys.playbackRate, 1, isPlaybackRate));
  const [audioError, setAudioError] = useState<AudioError | null>(null);
  /**
   * Reload the audio of a live recording to reach its newest part: the live WAV has the length it had when it was
   * loaded, so a player opened during the recording is reloaded when the recording ends, and a seek past the loaded
   * end reloads it first (the seek is applied once the new length is known).
   */
  const [audioEpoch, setAudioEpoch] = useState(0);
  const pendingSeek = useRef<{ t: number; play: boolean } | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const playback = info.playback;
  const src = playback ? (audioEpoch > 0 ? `${playback.url}${playback.url.includes('?') ? '&' : '?'}v=${audioEpoch}` : playback.url) : null;

  const reloadAudio = useCallback((keep: { t: number; play: boolean } | null) => {
    pendingSeek.current = keep;
    setAudioEpoch((n) => n + 1);
  }, []);

  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) {
      const audio = audioRef.current;
      // Keep the place (and keep playing) across the reload.
      reloadAudio(audio && audio.currentTime > 0 ? { t: audio.currentTime, play: !audio.paused } : null);
    }
    wasLive.current = live;
  }, [live, reloadAudio]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // The default too: a (re)load resets the rate to it.
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
  }, [rate, src]);

  const setRate = (r: number) => {
    if (r === rate) return;
    setRateState(r);
    writeStorage(storageKeys.playbackRate, r);
  };

  const playFrom = useCallback((t: number) => {
    const audio = audioRef.current;
    if (!audio) {
      toast(msg().recording.detail.noPlayableFile, 'info');
      return;
    }
    if (liveRef.current && pastLoadedEnd(audio.duration, t)) {
      setTime(Math.max(0, t));
      reloadAudio({ t: Math.max(0, t), play: true });
      return;
    }
    audio.currentTime = Math.max(0, t);
    setTime(Math.max(0, t));
    // From inside the click: allowed to start playback. Not awaited (DESIGN: do not await play() for UI state).
    void audio.play().catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setAudioError('format');
    });
  }, [reloadAudio]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setAudioError('play'));
    else audio.pause();
  };

  // A memo's recording chip asked for a moment of this recording: play from there (the audio may still be loading:
  // then the seek is applied once its metadata is known).
  const playedSeq = useRef(0);
  useEffect(() => {
    if (!playRequest || playRequest.rid !== info.id || playedSeq.current === playRequest.seq) return;
    playedSeq.current = playRequest.seq;
    if (audioRef.current) playFrom(playRequest.t);
    else pendingSeek.current = { t: Math.max(0, playRequest.t), play: true };
  }, [playRequest, info.id, playFrom]);

  // 그때 필기 재생 (DESIGN §25): the viewer follows this player's position while the toggle is on; otherwise it only
  // knows which recording is selected (so it can offer the toggle).
  const [replayOn, setReplayOn] = useReplayAnnotations();
  const liftT = replayOn ? time : 0;
  const liftPlaying = replayOn && playing;
  useEffect(() => {
    setPlayhead({ docId: doc.id, rid: info.id, t: liftT, playing: liftPlaying });
  }, [doc.id, info.id, liftT, liftPlaying]);
  useEffect(() => () => clearPlayhead(info.id), [info.id]);

  const total = Math.max(Number.isFinite(duration) ? duration : 0, info.durationSec);
  const activeIndex = segmentIndexAt(segments, time);
  const activeId = activeIndex >= 0 && time <= (segments[activeIndex]?.end ?? 0) + 2 ? segments[activeIndex].id : null;

  // "슬라이드 따라가기": while playing, the viewer shows the slide being discussed.
  const followed = useRef<number | null>(null);
  useEffect(() => {
    if (!follow || !playing) {
      followed.current = null;
      return;
    }
    const slide = slideAtTime(segments, time);
    if (slide !== null && slide !== followed.current) {
      followed.current = slide;
      if (slide !== focusedSlide) onGoToSlide(slide);
    }
  }, [follow, playing, segments, time, focusedSlide, onGoToSlide]);

  // ---- actions --------------------------------------------------------------------------------------------------
  const [renaming, setRenaming] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const rename = async (title: string) => {
    const t = title.trim();
    setRenaming(false);
    if (!t || t === info.title) return;
    try {
      const next = await api.renameRecording(doc.id, info.id, t);
      recordings.patch(next);
      updateFeedInfo(next);
    } catch (e) {
      toast(msg().recording.detail.renameFailed(api.recordingErrorMessage(e)), 'error');
    }
  };

  const remove = async () => {
    const d = msg().recording.detail;
    const ok = await confirmDialog({
      title: d.deleteConfirm.title(info.title),
      message: live ? d.deleteConfirm.messageLive : d.deleteConfirm.message,
      confirmLabel: d.deleteConfirm.confirmLabel,
      danger: true,
    });
    if (!ok) return;
    audioRef.current?.pause();
    try {
      await recorder.discard(info.id);
      await api.deleteRecording(doc.id, info.id);
      writeStorage(storageKeys.recordingMarkers(info.id), null);
      recordings.removeLocally(info.id);
      toast(d.deleted(info.title), 'success');
    } catch (e) {
      toast(d.deleteFailed(api.recordingErrorMessage(e)), 'error');
    }
    void recordings.refresh();
  };

  const onMarker = useCallback(
    (action: MarkerAction) => {
      void applyMarker(action).then((ok) => {
        if (ok && action.type === 'add') {
          const d = msg().recording.detail;
          toast(action.slide === null ? d.markedOff : d.markedSlide(action.slide), 'success', 2500);
        }
      });
    },
    [applyMarker],
  );

  const canMark = segments.length > 0 && !aligning && info.status !== 'error';
  const status = recordingStatus(info);
  const align = alignmentLabel(info.alignment);
  // A live recording this page is not making (another device or browser): it can be ended from here when that
  // device is gone — otherwise it would keep every new recording from starting.
  const recordingElsewhere = live && !recordedHere(info.id);
  const finishElsewhere = async () => {
    const next = await finishRecordingElsewhere(info);
    if (next) recordings.patch(next);
  };
  const m = msg().recording.detail;
  const menuSections = [
    {
      items: [
        ...(recordingElsewhere ? [{ key: 'finish', label: m.finish, hint: m.finishHint, onSelect: () => void finishElsewhere() }] : []),
        { key: 'rename', label: msg().common.rename, onSelect: () => setRenaming(true) },
        ...(markers.length > 0 ? [{ key: 'clear', label: m.clearMarkers, onSelect: () => onMarker({ type: 'clear' }) }] : []),
        { key: 'delete', label: m.delete, danger: true, onSelect: () => void remove() },
      ],
    },
  ];

  const scrollRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(() => setScroller(scrollRef.current), []);

  return (
    <div className="rec-detail">
      <div className="rec-detail-head">
        {renaming ? (
          <form
            className="rec-rename"
            onSubmit={(e) => {
              e.preventDefault();
              const input = e.currentTarget.elements.namedItem('title') as HTMLInputElement | null;
              void rename(input?.value ?? '');
            }}
          >
            <input
              name="title"
              className="model-input"
              defaultValue={info.title}
              maxLength={120}
              autoFocus
              aria-label={m.nameLabel}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setRenaming(false);
                }
              }}
              onBlur={(e) => void rename(e.currentTarget.value)}
            />
          </form>
        ) : (
          <h3 className="rec-detail-title" title={info.title}>
            {info.title}
          </h3>
        )}
        <span className="spacer" />
        <button
          type="button"
          className={aiOpen ? 'ghost-btn small is-active' : 'ghost-btn small'}
          onClick={() => setAiOpen((o) => !o)}
          disabled={info.transcriptStatus !== 'ready' || live || aligning}
          title={aligning ? m.aligningTitle : info.transcriptStatus !== 'ready' || live ? m.alignAfterTranscript : m.alignTitle}
        >
          {aligning ? (
            <>
              <Hourglass /> {m.aligning}
            </>
          ) : (
            <>
              <Bot /> {m.align}
            </>
          )}
        </button>
        <PopoverMenu label={m.menu(info.title)} sections={menuSections} />
      </div>
      <div className="rec-detail-meta">
        <StatusBadge status={status} />
        {align && (
          <span className="rec-badge tone-muted" title={align.title}>
            {align.text}
          </span>
        )}
        {info.hasManualMarkers && (
          <span className="rec-badge tone-muted">
            <MapPin /> {m.manualMarkers}
          </span>
        )}
        <span className="muted small">
          {recordingLanguageLabel(info)} · {info.model}
        </span>
      </div>
      {info.error && <div className="msg-error">{info.error}</div>}

      {aiOpen && !aligning && (
        <AiAlignForm
          doc={doc}
          info={info}
          providers={providers}
          choice={choice}
          onStarted={() => {
            setAiOpen(false);
            recordingFeed(doc.id, info.id, { info }).startAligning();
          }}
        />
      )}

      {info.hasManualMarkers && markers.length === 0 && (
        <p className="msg-note">
          <MapPin /> {m.markersElsewhere}
        </p>
      )}
      {markers.length > 0 && (
        <div className="rec-markers">
          <span className="muted small">{markersPending ? m.markersRealigning : m.markers}</span>
          {markers.map((mk) => (
            <span key={mk.t} className="rec-marker-chip">
              <button
                type="button"
                className="rec-marker-go"
                onClick={() => playFrom(mk.t)}
                title={msg().recording.transcript.playFromHere}
              >
                {formatClock(mk.t)} {markerShortLabel(mk)}
              </button>
              <button
                type="button"
                className="rec-marker-x"
                onClick={() => onMarker({ type: 'remove', t: mk.t })}
                aria-label={m.removeMarkerAt(formatClock(mk.t))}
                title={msg().recording.transcript.removeMarker}
              >
                <X size="1em" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="rec-transcript-bar">
        <div className="segmented" role="group" aria-label={m.viewMode}>
          <button type="button" aria-pressed={mode === 'current'} onClick={() => setMode('current')}>
            {m.currentSlide(focusedSlide)}
          </button>
          <button type="button" aria-pressed={mode === 'all'} onClick={() => setMode('all')}>
            {m.all}
          </button>
        </div>
        {segments.length > 0 && <span className="muted small">{m.sentences(segments.length)}</span>}
      </div>

      <div className="rec-transcript" ref={scrollRef}>
        {feed?.error && (
          <div className="inline-error">
            <TriangleAlert /> {m.transcriptFailed(feed.error)}{' '}
            <button type="button" className="ghost-btn small" onClick={() => recordingFeed(doc.id, info.id).reload()}>
              {msg().common.retry}
            </button>
          </div>
        )}
        {feed && !feed.loaded ? (
          <div className="notes-empty muted">{msg().common.loading}</div>
        ) : (
          <Transcript
            segments={segments}
            mode={mode}
            focusedSlide={focusedSlide}
            pageCount={doc.pageCount}
            activeId={activeId}
            playing={playing}
            live={live}
            markers={markers}
            canMark={canMark}
            onPlayFrom={playFrom}
            onGoToSlide={onGoToSlide}
            onMarker={onMarker}
            scroller={scroller}
          />
        )}
      </div>

      <div className="rec-player">
        {src ? (
          <>
            <audio
              ref={audioRef}
              src={src}
              preload="metadata"
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onDurationChange={(e) => setDuration(e.currentTarget.duration)}
              onLoadedMetadata={(e) => {
                const audio = e.currentTarget;
                audio.playbackRate = rate;
                setDuration(audio.duration);
                const seek = pendingSeek.current;
                pendingSeek.current = null;
                if (seek) {
                  const t = Number.isFinite(audio.duration) ? Math.min(seek.t, audio.duration) : seek.t;
                  audio.currentTime = t;
                  setTime(t);
                  if (seek.play) {
                    void audio.play().catch((err: unknown) => {
                      if (!(err instanceof DOMException && err.name === 'AbortError')) setAudioError('pressPlay');
                    });
                  }
                }
              }}
              onPlay={() => {
                setPlaying(true);
                setAudioError(null);
              }}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onError={() => setAudioError('load')}
            />
            <button type="button" className="rec-play" onClick={togglePlay} aria-label={playing ? m.pause : m.play}>
              {playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
            </button>
            <span className="rec-player-time">
              {formatClock(time)} / {formatClock(total)}
            </span>
            <input
              className="rec-seek"
              type="range"
              min={0}
              max={Math.max(1, total)}
              step={0.5}
              value={Math.min(time, Math.max(1, total))}
              onChange={(e) => {
                const t = Number(e.target.value);
                setTime(t);
                const audio = audioRef.current;
                if (!audio) return;
                if (live && pastLoadedEnd(audio.duration, t)) reloadAudio({ t, play: !audio.paused });
                else audio.currentTime = t;
              }}
              aria-label={m.position}
            />
            <PlaybackRate rate={rate} onChange={setRate} />
            <label className="rec-follow" title={m.followTitle}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              <span>{m.follow}</span>
            </label>
            <label className="rec-follow" title={m.replayTitle}>
              <input type="checkbox" checked={replayOn} onChange={(e) => setReplayOn(e.target.checked)} />
              <span>{m.replay}</span>
            </label>
            {live && (
              <button
                type="button"
                className="ghost-btn tiny"
                onClick={() => setAudioEpoch((n) => n + 1)}
                title={m.latestTitle}
              >
                <RefreshCw /> {m.latest}
              </button>
            )}
            {audioError && <span className="rec-player-error">{m.audioErrors[audioError]}</span>}
          </>
        ) : (
          <span className="muted small">
            {info.status === 'converting' ? m.preparing : m.noPlayableFile}
          </span>
        )}
      </div>
    </div>
  );
}

function AiAlignForm({
  doc,
  info,
  providers,
  choice,
  onStarted,
}: {
  doc: DocMeta;
  info: RecordingInfo;
  providers: ProviderInfo[] | undefined;
  choice: ProviderChoice | null;
  onStarted: () => void;
}) {
  const available = useMemo(() => (providers ?? []).filter((p) => p.available), [providers]);
  const [provider, setProvider] = useState<ProviderId | ''>(() => {
    if (choice && available.some((p) => p.id === choice.provider)) return choice.provider;
    return available[0]?.id ?? '';
  });
  const [busy, setBusy] = useState(false);
  const selectedProvider = available.find((p) => p.id === provider) ?? null;

  const start = async () => {
    if (!provider) return;
    setBusy(true);
    try {
      // No model: the server runs the alignment on a small, fast one (Haiku), not the chat's model.
      await api.alignRecordingWithAi(doc.id, info.id, { provider });
      toast(msg().recording.aiAlign.started, 'success');
      onStarted();
    } catch (e) {
      toast(msg().recording.aiAlign.failed(api.recordingErrorMessage(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const m = msg().recording.aiAlign;
  return (
    <div className="rec-ai">
      <p className="small">{m.intro(<MapPin />)}</p>
      {available.length === 0 ? (
        <p className="warn-text">
          <TriangleAlert /> {m.noLlm}
        </p>
      ) : (
        <div className="rec-ai-actions">
          <select
            className="picker small"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            aria-label={m.llmLabel}
          >
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button type="button" className="primary-btn small" disabled={busy || !provider} onClick={() => void start()}>
            {busy ? m.starting : m.start}
          </button>
          {selectedProvider && <span className="muted small">{m.model(aiAlignModelLabel(selectedProvider))}</span>}
        </div>
      )}
    </div>
  );
}
