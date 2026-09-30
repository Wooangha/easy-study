// Speech recognition in the 녹음 tab (DESIGN §22): the model download prompt (size + progress) and the settings
// of this device — model (turbo / small), language, live transcription on/off.
import { Download, TriangleAlert } from 'lucide-react';
import type { AsrModelInfo, AsrStatus, RecordingLanguage } from '../../../../shared/types.ts';
import type { AsrState } from '../../hooks/useAsrStatus.ts';
import { useRecordingSettings } from '../../hooks/useRecorder.ts';
import { msg } from '../../i18n/index.ts';
import { confirmDialog } from '../../lib/confirm.ts';
import {
  RECORDING_LANGUAGES,
  asrProblem,
  downloadFraction,
  effectiveModel,
  formatSize,
  languageLabel,
} from '../../lib/recording/labels.ts';
import { setRecordingSettings } from '../../lib/recording/settings.ts';
import { ProgressBar } from '../organize/parts.tsx';

function modelOptionLabel(m: AsrModelInfo): string {
  const t = msg().recording.asrSettings;
  const state = m.installed ? t.installed : m.downloading ? t.downloading : m.error ? t.downloadFailed : t.needsDownload;
  return [m.label, formatSize(m.sizeBytes), state, ...(m.recommended ? [t.recommended] : [])].join(' · ');
}

/** What the engine runs on, for the engine line (`title`: why the GPU was turned off). */
function accelerationLabel(status: AsrStatus): { text: string; title?: string } {
  const t = msg().recording.asrSettings;
  const accel = status.acceleration;
  switch (accel) {
    case 'metal':
      return { text: t.accelMetal };
    case 'vulkan':
      return { text: status.gpu?.name ? `${t.accelVulkan} · ${status.gpu.name}` : t.accelVulkan };
    case 'cpu':
      return status.gpuError ? { text: t.cpuAfterGpuError, title: status.gpuError } : { text: 'CPU' };
    default: {
      const unknown: never = accel;
      return { text: String(unknown) };
    }
  }
}

/** Engine problems and the "download the model" prompt (shown above the recordings). */
export function AsrNotice({ asr }: { asr: AsrState }) {
  const settings = useRecordingSettings();
  const t = msg().recording.asrSettings;
  const status = asr.status;
  if (!status) {
    return asr.error ? (
      <div className="inline-error">
        <TriangleAlert /> {t.statusFailed(asr.error)}
      </div>
    ) : null;
  }
  const model = effectiveModel(status, settings.model);
  const problem = asrProblem(status, model);
  if (problem) {
    return (
      <div className="rec-notice is-warn">
        <TriangleAlert /> {problem}
        <div className="muted small">{t.problemHint}</div>
      </div>
    );
  }
  if (!model || model.installed) return null;
  const fraction = downloadFraction(model);
  if (fraction !== null && model.downloading) {
    return (
      <div className="rec-notice">
        <div>
          <Download />{' '}
          {t.downloadingModel(
            <b>{model.label}</b>,
            formatSize(model.downloading.receivedBytes),
            formatSize(model.downloading.totalBytes),
          )}
        </div>
        <ProgressBar fraction={fraction} />
        <div className="muted small">{t.downloadingHint}</div>
      </div>
    );
  }
  return (
    <div className={model.error ? 'rec-notice is-warn' : 'rec-notice'}>
      <div>{t.needsModel(<b>{model.label}</b>, formatSize(model.sizeBytes))}</div>
      {model.error && (
        <div className="small" role="alert">
          <TriangleAlert /> {t.lastDownloadFailed(model.error)}
        </div>
      )}
      <div className="rec-notice-actions">
        <button
          type="button"
          className="primary-btn small"
          disabled={asr.pending !== null}
          onClick={() => void asr.download(model.id)}
        >
          <Download /> {model.error ? t.downloadAgain : t.download} ({formatSize(model.sizeBytes)})
        </button>
        <span className="muted small">{t.modelStaysLocal}</span>
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
  const t = msg().recording.asrSettings;

  const removeModel = async (m: AsrModelInfo) => {
    const c = msg().recording.asrSettings.removeConfirm;
    const ok = await confirmDialog({
      title: c.title(m.label),
      message: c.message(formatSize(m.sizeBytes)),
      confirmLabel: c.confirmLabel,
      danger: true,
    });
    if (ok) void asr.remove(m.id);
  };

  return (
    <div className="rec-settings">
      <label className="rec-setting">
        <span className="rec-setting-label">{t.model}</span>
        <select
          className="picker small"
          value={model?.id ?? ''}
          disabled={!status}
          onChange={(e) => setRecordingSettings({ model: e.target.value || null })}
        >
          {!status && <option value="">{msg().common.loading}</option>}
          {status?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {modelOptionLabel(m)}
            </option>
          ))}
        </select>
      </label>
      {cpuOnly && small && model && !model.id.startsWith('small') && (
        <p className="muted small">{t.cpuHint(<b>{small.label}</b>, formatSize(small.sizeBytes))}</p>
      )}
      {builtInGpu && small && model && !model.id.startsWith('small') && (
        <p className="muted small">{t.integratedGpuHint(<b>{small.label}</b>, formatSize(small.sizeBytes))}</p>
      )}
      <label className="rec-setting">
        <span className="rec-setting-label">{t.lectureLanguage}</span>
        <select
          className="picker small"
          value={settings.language}
          onChange={(e) => setRecordingSettings({ language: e.target.value as RecordingLanguage })}
        >
          {RECORDING_LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {languageLabel(language)}
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
          {t.liveTranscribe}
          <span className="muted small"> — {t.liveTranscribeHint}</span>
        </span>
      </label>
      {status && (
        <div className="rec-settings-foot muted small">
          <span>
            {t.engine}: {status.engineAvailable ? `whisper.cpp${status.engineVersion ? ` ${status.engineVersion}` : ''}` : t.none} ·{' '}
            <span title={accel?.title}>{accel?.text}</span> · {t.fileConversion}: {status.ffmpegAvailable ? t.available : t.none}
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
                {t.removeModel(m.label)}
              </button>
            ))}
        </div>
      )}
      <p className="muted small">{t.appliesHere}</p>
    </div>
  );
}
