// Speech recognition in the 녹음 tab (DESIGN §22): the model download prompt (size + progress) and the settings
// of this device — model (turbo / small), language, live transcription on/off.
import { Download, TriangleAlert } from 'lucide-react';
import type { AsrModelInfo, AsrStatus, RecordingLanguage } from '../../../../shared/types.ts';
import type { AsrState } from '../../hooks/useAsrStatus.ts';
import { useRecordingSettings } from '../../hooks/useRecorder.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import { LANGUAGE_OPTIONS, asrProblem, downloadFraction, effectiveModel, formatSize } from '../../lib/recording/labels.ts';
import { setRecordingSettings } from '../../lib/recording/settings.ts';
import { ProgressBar } from '../organize/parts.tsx';

function modelOptionLabel(m: AsrModelInfo): string {
  const state = m.installed ? '설치됨' : m.downloading ? '내려받는 중' : m.error ? '내려받기 실패' : '내려받기 필요';
  return `${m.label} · ${formatSize(m.sizeBytes)} · ${state}${m.recommended ? ' · 추천' : ''}`;
}

/** What the engine runs on, for the engine line (`title`: why the GPU was turned off). */
function accelerationLabel(status: AsrStatus): { text: string; title?: string } {
  const accel = status.acceleration;
  switch (accel) {
    case 'metal':
      return { text: 'GPU(Metal) 가속' };
    case 'vulkan':
      return { text: `GPU(Vulkan) 가속${status.gpu?.name ? ` · ${status.gpu.name}` : ''}` };
    case 'cpu':
      return status.gpuError ? { text: 'CPU · GPU 오류로 CPU로 받아써요', title: status.gpuError } : { text: 'CPU' };
    default: {
      const unknown: never = accel;
      return { text: String(unknown) };
    }
  }
}

/** Engine problems and the "download the model" prompt (shown above the recordings). */
export function AsrNotice({ asr }: { asr: AsrState }) {
  const settings = useRecordingSettings();
  const status = asr.status;
  if (!status) {
    return asr.error ? (
      <div className="inline-error">
        <TriangleAlert /> 음성 인식 상태를 확인하지 못했어요: {asr.error}
      </div>
    ) : null;
  }
  const model = effectiveModel(status, settings.model);
  const problem = asrProblem(status, model);
  if (problem) {
    return (
      <div className="rec-notice is-warn">
        <TriangleAlert /> {problem}
        <div className="muted small">녹음과 파일 올리기는 되고, 받아쓰기는 엔진이 준비되면 시작돼요.</div>
      </div>
    );
  }
  if (!model || model.installed) return null;
  const fraction = downloadFraction(model);
  if (fraction !== null && model.downloading) {
    return (
      <div className="rec-notice">
        <div>
          <Download /> 음성 인식 모델 <b>{model.label}</b> 내려받는 중 · {formatSize(model.downloading.receivedBytes)} /{' '}
          {formatSize(model.downloading.totalBytes)}
        </div>
        <ProgressBar fraction={fraction} />
        <div className="muted small">내려받는 동안에도 녹음할 수 있어요. 받아쓰기는 모델이 준비되면 시작돼요.</div>
      </div>
    );
  }
  return (
    <div className={model.error ? 'rec-notice is-warn' : 'rec-notice'}>
      <div>
        받아쓰기에는 음성 인식 모델이 필요해요: <b>{model.label}</b> ({formatSize(model.sizeBytes)}). 한 번만 내려받으면 돼요.
      </div>
      {model.error && (
        <div className="small" role="alert">
          <TriangleAlert /> 지난번 내려받기가 실패했어요: {model.error}
        </div>
      )}
      <div className="rec-notice-actions">
        <button
          type="button"
          className="primary-btn small"
          disabled={asr.pending !== null}
          onClick={() => void asr.download(model.id)}
        >
          <Download /> {model.error ? '다시 내려받기' : '내려받기'} ({formatSize(model.sizeBytes)})
        </button>
        <span className="muted small">모델은 서버 컴퓨터에만 저장되고, 받아쓰기도 거기서 해요 (인터넷으로 보내지 않아요).</span>
      </div>
    </div>
  );
}

/** The settings of this device for new recordings. */
export function AsrSettings({ asr }: { asr: AsrState }) {
  const settings = useRecordingSettings();
  const status = asr.status;
  const model = effectiveModel(status, settings.model);
  const cpuOnly = status?.acceleration === 'cpu';
  const builtInGpu = status?.acceleration === 'vulkan' && status.gpu?.integrated === true;
  const small = status?.models.find((m) => m.id !== model?.id && m.sizeBytes < (model?.sizeBytes ?? 0));
  const accel = status ? accelerationLabel(status) : null;

  const removeModel = async (m: AsrModelInfo) => {
    const ok = await confirmDialog({
      title: `${m.label} 모델을 지울까요?`,
      message: `디스크 ${formatSize(m.sizeBytes)}를 비워요. 이 모델로 받아쓰려면 다시 내려받아야 해요. 녹음과 받아쓴 글은 그대로예요.`,
      confirmLabel: '모델 지우기',
      danger: true,
    });
    if (ok) void asr.remove(m.id);
  };

  return (
    <div className="rec-settings">
      <label className="rec-setting">
        <span className="rec-setting-label">음성 인식 모델</span>
        <select
          className="picker small"
          value={model?.id ?? ''}
          disabled={!status}
          onChange={(e) => setRecordingSettings({ model: e.target.value || null })}
        >
          {!status && <option value="">불러오는 중…</option>}
          {status?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {modelOptionLabel(m)}
            </option>
          ))}
        </select>
      </label>
      {cpuOnly && small && model && !model.id.startsWith('small') && (
        <p className="muted small">
          이 컴퓨터는 GPU 가속 없이(CPU로) 받아써요. 느리면 더 작은 <b>{small.label}</b> 모델({formatSize(small.sizeBytes)})이
          몇 배 빨라요.
        </p>
      )}
      {builtInGpu && small && model && !model.id.startsWith('small') && (
        <p className="muted small">
          이 컴퓨터는 내장 그래픽으로 받아써요. 느리면 더 작은 <b>{small.label}</b> 모델({formatSize(small.sizeBytes)})이 더
          빨라요.
        </p>
      )}
      <label className="rec-setting">
        <span className="rec-setting-label">강의 언어</span>
        <select
          className="picker small"
          value={settings.language}
          onChange={(e) => setRecordingSettings({ language: e.target.value as RecordingLanguage })}
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="rec-setting rec-setting-check">
        <input
          type="checkbox"
          checked={settings.liveTranscribe}
          onChange={(e) => setRecordingSettings({ liveTranscribe: e.target.checked })}
        />
        <span>
          녹음하면서 받아쓰기
          <span className="muted small"> — 끄면 녹음을 끝낸 뒤에 받아써요 (느린 컴퓨터에서 수업 중 부담이 줄어요)</span>
        </span>
      </label>
      {status && (
        <div className="rec-settings-foot muted small">
          <span>
            엔진: {status.engineAvailable ? `whisper.cpp${status.engineVersion ? ` ${status.engineVersion}` : ''}` : '없음'} ·{' '}
            <span title={accel?.title}>{accel?.text}</span> · 파일 변환(ffmpeg):{' '}
            {status.ffmpegAvailable ? '있음' : '없음'}
          </span>
          {status.models
            .filter((m) => m.installed)
            .map((m) => (
              <button
                key={m.id}
                type="button"
                className="ghost-btn tiny"
                disabled={asr.pending !== null}
                onClick={() => void removeModel(m)}
              >
                {m.label} 지우기
              </button>
            ))}
        </div>
      )}
      <p className="muted small">이 설정은 이 기기에서 새로 시작하는 녹음에 적용돼요. 올린 파일은 서버가 언어를 자동으로 알아내요.</p>
    </div>
  );
}
