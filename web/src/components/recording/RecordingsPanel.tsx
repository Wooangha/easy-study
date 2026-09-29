// The 녹음 tab (DESIGN §22): record or upload, the recordings of this lecture (status / progress), speech
// recognition settings with the model download, and for the selected recording a player (speed, "슬라이드
// 따라가기"), its transcript (focused slide or all, click → play from there), "여기부터 p.N" markers, "AI 정밀
// 정렬", rename and delete.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocMeta, ProviderId, ProviderInfo, RecordingInfo } from '../../../../shared/types.ts';
import * as api from '../../api.ts';
import { useAsrStatus } from '../../hooks/useAsrStatus.ts';
import { useMarkers } from '../../hooks/useMarkers.ts';
import type { ProviderChoice } from '../../hooks/useProviderChoice.ts';
import { useRecorder, useRecordingUploads } from '../../hooks/useRecorder.ts';
import { useRecordingFeed } from '../../hooks/useRecordingFeed.ts';
import type { RecordingsState } from '../../hooks/useRecordings.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { formatDate, formatTime } from '../../lib/format.ts';
import { withParticle } from '../../lib/korean.ts';
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
} from '../../lib/recording/labels.ts';
import type { MarkerAction } from '../../lib/recording/markers.ts';
import { markerLabel } from '../../lib/recording/markers.ts';
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

/** "Play this moment" (a memo's 🎙 chip, DESIGN §25): the recording and the time; `seq` makes repeats distinct. */
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

  return (
    <div className="rec-panel">
      <div className="notes-toolbar rec-toolbar">
        {recordingHere ? (
          <button
            type="button"
            className="ghost-btn small rec-live-chip"
            onClick={() => rec.recordingId && setPicked(rec.recordingId)}
            title="녹음 중인 녹음 보기 (멈추기는 위쪽 녹음 막대에서)"
          >
            <span className={rec.phase === 'paused' ? 'rec-dot is-paused' : 'rec-dot'} aria-hidden />
            {rec.phase === 'stopping' ? '저장 중' : rec.phase === 'paused' ? '일시정지' : '녹음 중'} {formatClock(rec.seconds)}
          </button>
        ) : (
          <button
            type="button"
            className="ghost-btn small accent"
            disabled={recordingElsewhere || rec.phase === 'starting'}
            onClick={() => void startRecording(doc.id, focusedSlide)}
            title={recordingElsewhere ? '다른 강의를 녹음하고 있어요' : (recorder.unavailableReason() ?? '이 강의를 녹음하고 바로 받아쓰기해요')}
          >
            🎙 녹음 시작
          </button>
        )}
        <button
          type="button"
          className="ghost-btn small"
          onClick={pickFiles}
          disabled={uploadDisabled}
          title={
            uploadDisabled
              ? '서버에 파일 변환 도구(ffmpeg)가 없어서 녹음 파일을 올릴 수 없어요'
              : '이미 녹음한 파일(음성·동영상)을 올려서 받아쓰고 슬라이드에 맞춰요'
          }
        >
          ⬆ 녹음 파일 올리기
        </button>
        <span className="spacer" />
        <button
          type="button"
          className={settingsOpen ? 'ghost-btn small is-active' : 'ghost-btn small'}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((o) => !o)}
          title="받아쓰기 설정 (모델·언어·실시간 받아쓰기)"
        >
          ⚙ 설정
        </button>
        <button type="button" className="ghost-btn small" onClick={() => void recordings.refresh()} title="새로고침">
          ↻
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
              <span className="rec-upload-name">⬆ {u.name}</span>
              <span className="muted small">{Math.round(u.fraction * 100)}%</span>
              <button type="button" className="ghost-btn tiny" onClick={() => cancelRecordingUpload(u.id)}>
                취소
              </button>
            </div>
            <ProgressBar fraction={u.fraction} />
          </div>
        ))}
        {recordings.error && (
          <div className="inline-error">
            ⚠️ 녹음 목록을 불러오지 못했어요: {recordings.error}{' '}
            <button type="button" className="ghost-btn small" onClick={() => void recordings.refresh()}>
              다시 시도
            </button>
          </div>
        )}
        {list === null && !recordings.error && <div className="notes-empty muted">불러오는 중…</div>}
        {list !== null && list.length === 0 && uploads.length === 0 && (
          <div className="rec-empty">
            <div className="chat-empty-icon" aria-hidden>
              🎙
            </div>
            <h3>아직 녹음이 없어요</h3>
            <p>
              수업 중에 <b>🎙 녹음 시작</b>을 누르면 강의를 녹음하면서 바로 받아써요. 이미 녹음한 파일은 <b>⬆ 녹음 파일 올리기</b>로
              올리면 돼요.
            </p>
            <ul className="tips">
              <li>💬 녹음하는 동안 질문하면 최근 몇 분 동안 교수님이 한 말도 튜터에게 함께 전달돼요</li>
              <li>📑 받아쓴 문장은 슬라이드별로 나뉘고, 튜터가 그 슬라이드에서 한 말을 알고 설명해요</li>
              <li>▶ 나중에 문장을 누르면 그 부분부터 다시 들을 수 있고, 슬라이드도 따라 넘어가요</li>
              <li>🔒 받아쓰기는 서버 컴퓨터에서 해요 (녹음을 인터넷으로 보내지 않아요)</li>
            </ul>
          </div>
        )}
        {list !== null && list.length > 0 && (
          <ul className="rec-list" aria-label="녹음 목록">
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
          <span aria-hidden>{r.source === 'live' ? '🎙' : '⬆'}</span> {r.title}
        </span>
        <span className="rec-row-sub">
          <span className={`rec-badge tone-${status.tone}`} title={status.title}>
            {status.text}
          </span>
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
  const { markers, pending: markersPending, apply: applyMarker } = useMarkers(doc.id, info.id, doc.pageCount, onMarkersSaved);
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
  const [audioError, setAudioError] = useState<string | null>(null);
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
      toast('아직 재생할 수 있는 파일이 없어요.', 'info');
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
      setAudioError('재생하지 못했어요. 이 브라우저가 이 형식을 재생할 수 없을 수 있어요.');
    });
  }, [reloadAudio]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setAudioError('재생하지 못했어요.'));
    else audio.pause();
  };

  // A memo's 🎙 chip asked for a moment of this recording: play from there (the audio may still be loading: then
  // the seek is applied once its metadata is known).
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
      toast(`이름을 바꾸지 못했어요: ${api.recordingErrorMessage(e)}`, 'error');
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `${withParticle(`‘${info.title}’ 녹음`, '을', '를')} 삭제할까요?`,
      message:
        (live ? '녹음을 멈추고 삭제해요. ' : '') +
        '녹음 파일과 받아쓴 글, 슬라이드 정렬이 모두 지워지고 되돌릴 수 없어요. 튜터도 이 녹음의 내용을 더 이상 쓰지 않아요.',
      confirmLabel: '녹음 삭제',
      danger: true,
    });
    if (!ok) return;
    audioRef.current?.pause();
    try {
      await recorder.discard(info.id);
      await api.deleteRecording(doc.id, info.id);
      writeStorage(storageKeys.recordingMarkers(info.id), null);
      recordings.removeLocally(info.id);
      toast(`‘${info.title}’ 녹음을 삭제했어요.`, 'success');
    } catch (e) {
      toast(`녹음을 삭제하지 못했어요: ${api.recordingErrorMessage(e)}`, 'error');
    }
    void recordings.refresh();
  };

  const onMarker = useCallback(
    (action: MarkerAction) => {
      void applyMarker(action).then((ok) => {
        if (ok && action.type === 'add') {
          toast(
            action.slide === null ? '여기부터 슬라이드 밖으로 표시하고 다시 정렬했어요.' : `여기부터 p.${action.slide}로 표시하고 다시 정렬했어요.`,
            'success',
            2500,
          );
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
  const menuSections = [
    {
      items: [
        ...(recordingElsewhere ? [{ key: 'finish', label: '녹음 끝내기', hint: '다른 기기의 녹음', onSelect: () => void finishElsewhere() }] : []),
        { key: 'rename', label: '이름 바꾸기', onSelect: () => setRenaming(true) },
        ...(markers.length > 0
          ? [{ key: 'clear', label: '직접 표시한 구간 모두 지우기', onSelect: () => onMarker({ type: 'clear' }) }]
          : []),
        { key: 'delete', label: '녹음 삭제', danger: true, onSelect: () => void remove() },
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
              aria-label="녹음 이름"
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
          title={
            aligning
              ? 'AI가 정렬하고 있어요'
              : info.transcriptStatus !== 'ready' || live
                ? '받아쓰기가 끝난 뒤에 할 수 있어요'
                : 'LLM이 받아쓴 글과 슬라이드를 비교해서 더 정확하게 나눠요'
          }
        >
          {aligning ? '⏳ AI 정렬 중…' : '🤖 AI 정밀 정렬'}
        </button>
        <PopoverMenu label={`‘${info.title}’ 녹음 메뉴`} sections={menuSections} />
      </div>
      <div className="rec-detail-meta">
        <span className={`rec-badge tone-${status.tone}`} title={status.title}>
          {status.text}
        </span>
        {align && (
          <span className="rec-badge tone-muted" title={align.title}>
            {align.text}
          </span>
        )}
        {info.hasManualMarkers && <span className="rec-badge tone-muted">📍 직접 표시</span>}
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
        <p className="msg-note">📍 다른 기기(또는 브라우저)에서 직접 표시한 구간이 있어요. 여기서 새로 표시하면 그 표시를 대신해요.</p>
      )}
      {markers.length > 0 && (
        <div className="rec-markers">
          <span className="muted small">직접 표시한 구간{markersPending ? ' (다시 정렬하는 중…)' : ''}:</span>
          {markers.map((m) => (
            <span key={m.t} className="rec-marker-chip">
              <button type="button" className="rec-marker-go" onClick={() => playFrom(m.t)} title="여기부터 재생">
                {formatClock(m.t)} {markerLabel(m).replace('여기부터 ', '→ ')}
              </button>
              <button
                type="button"
                className="rec-marker-x"
                onClick={() => onMarker({ type: 'remove', t: m.t })}
                aria-label={`${formatClock(m.t)} 표시 지우기`}
                title="이 표시 지우기"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="rec-transcript-bar">
        <div className="segmented" role="group" aria-label="받아쓴 글 보기 방식">
          <button type="button" aria-pressed={mode === 'current'} onClick={() => setMode('current')}>
            현재 슬라이드 (p.{focusedSlide})
          </button>
          <button type="button" aria-pressed={mode === 'all'} onClick={() => setMode('all')}>
            전체
          </button>
        </div>
        {segments.length > 0 && <span className="muted small">{segments.length}문장</span>}
      </div>

      <div className="rec-transcript" ref={scrollRef}>
        {feed?.error && (
          <div className="inline-error">
            ⚠️ 받아쓴 글을 불러오지 못했어요: {feed.error}{' '}
            <button type="button" className="ghost-btn small" onClick={() => recordingFeed(doc.id, info.id).reload()}>
              다시 시도
            </button>
          </div>
        )}
        {feed && !feed.loaded ? (
          <div className="notes-empty muted">불러오는 중…</div>
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
                      if (!(err instanceof DOMException && err.name === 'AbortError')) setAudioError('재생하지 못했어요. ▶를 눌러 주세요.');
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
              onError={() => setAudioError('녹음 파일을 불러오지 못했어요.')}
            />
            <button type="button" className="rec-play" onClick={togglePlay} aria-label={playing ? '일시정지' : '재생'}>
              {playing ? '⏸' : '▶'}
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
              aria-label="재생 위치"
            />
            <PlaybackRate rate={rate} onChange={setRate} />
            <label className="rec-follow" title="재생하는 동안 슬라이드 창이 지금 설명 중인 슬라이드로 넘어가요">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              <span>슬라이드 따라가기</span>
            </label>
            <label className="rec-follow" title="재생하는 동안 그때까지 쓴 필기(형광·메모 등)만 슬라이드에 보여요">
              <input type="checkbox" checked={replayOn} onChange={(e) => setReplayOn(e.target.checked)} />
              <span>그때 필기 재생</span>
            </label>
            {live && (
              <button
                type="button"
                className="ghost-btn tiny"
                onClick={() => setAudioEpoch((n) => n + 1)}
                title="녹음 중인 부분까지 다시 불러와요"
              >
                ↻ 최신
              </button>
            )}
            {audioError && <span className="rec-player-error">{audioError}</span>}
          </>
        ) : (
          <span className="muted small">
            {info.status === 'converting' ? '재생할 파일을 만드는 중이에요…' : '아직 재생할 수 있는 파일이 없어요.'}
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
      toast('AI 정밀 정렬을 시작했어요. 끝나면 받아쓴 글의 슬라이드 구분이 바뀌어요.', 'success');
      onStarted();
    } catch (e) {
      toast(`AI 정밀 정렬을 시작하지 못했어요: ${api.recordingErrorMessage(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rec-ai">
      <p className="small">
        LLM이 받아쓴 글과 슬라이드(정리본이 있으면 정리본)를 직접 비교해서, 어느 문장이 어느 슬라이드 설명인지 다시 나눠요. 직접 표시한
        구간(📍)은 그대로 지켜요. 몇 분 걸리고 LLM 사용량이 들어요.
      </p>
      {available.length === 0 ? (
        <p className="warn-text">⚠️ 사용할 수 있는 LLM이 없어요.</p>
      ) : (
        <div className="rec-ai-actions">
          <select
            className="picker small"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            aria-label="정렬에 쓸 LLM"
          >
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button type="button" className="primary-btn small" disabled={busy || !provider} onClick={() => void start()}>
            {busy ? '시작하는 중…' : '정렬 시작'}
          </button>
          {selectedProvider && <span className="muted small">모델: {aiAlignModelLabel(selectedProvider)}</span>}
        </div>
      )}
    </div>
  );
}
