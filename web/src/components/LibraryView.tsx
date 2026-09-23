import { useState, type DragEvent } from 'react';
import type { DocMeta } from '../../../shared/types.ts';
import { slideUrl } from '../api.ts';
import type { UploadItem } from '../hooks/useDocs.ts';
import { formatBytes, formatDate } from '../lib/format.ts';

interface LibraryViewProps {
  docs: DocMeta[] | null;
  loadError: string | null;
  uploads: UploadItem[];
  libraryDir: string | null;
  onOpen: (docId: string) => void;
  onPickFiles: () => void;
  onDropFiles: (files: File[]) => void;
  onRetryLoad: () => void;
}

/** Empty state / library: big drop zone + list of documents with processing progress. */
export function LibraryView({
  docs,
  loadError,
  uploads,
  libraryDir,
  onOpen,
  onPickFiles,
  onDropFiles,
  onRetryLoad,
}: LibraryViewProps) {
  const [over, setOver] = useState(false);

  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    // preventDefault marks the drop as handled; the window-level listener then only hides its overlay.
    e.preventDefault();
    setOver(false);
    onDropFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="library">
      <div className="library-inner">
        <button
          type="button"
          className={over ? 'dropzone is-over' : 'dropzone'}
          onClick={onPickFiles}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <span className="dropzone-icon" aria-hidden>
            📄
          </span>
          <span className="dropzone-title">PDF를 끌어다 놓거나 클릭해서 업로드</span>
          <span className="dropzone-sub">
            슬라이드를 이미지로 변환해 두고, 질문할 때 LLM이 그림·도표까지 볼 수 있게 해요
          </span>
        </button>

        {uploads.map((u) => (
          <div key={u.id} className="doc-card is-uploading">
            <div className="doc-card-body">
              <div className="doc-title">{u.name}</div>
              <div className="doc-sub">
                업로드 중 {Math.round(u.fraction * 100)}% · {formatBytes(u.size)}
              </div>
              <ProgressBar fraction={u.fraction} />
            </div>
          </div>
        ))}

        {loadError && (
          <div className="inline-error">
            ⚠️ 문서 목록을 불러오지 못했어요: {loadError}{' '}
            <button type="button" className="ghost-btn small" onClick={onRetryLoad}>
              다시 시도
            </button>
          </div>
        )}

        {docs === null && !loadError && <p className="muted center">불러오는 중…</p>}

        {docs && docs.length > 0 && (
          <>
            <h2 className="library-heading">내 문서</h2>
            <div className="doc-list">
              {docs.map((d) => (
                <DocCard key={d.id} doc={d} onOpen={onOpen} />
              ))}
            </div>
          </>
        )}

        {docs && docs.length === 0 && uploads.length === 0 && !loadError && (
          <p className="muted center">아직 문서가 없어요. 강의 자료 PDF를 올려 보세요.</p>
        )}

        {libraryDir && (
          <p className="library-path muted small">
            저장 위치: <code>{libraryDir}</code>
          </p>
        )}
      </div>
    </div>
  );
}

function DocCard({ doc, onOpen }: { doc: DocMeta; onOpen: (id: string) => void }) {
  const ready = doc.status === 'ready';
  return (
    <button type="button" className={`doc-card status-${doc.status}`} onClick={() => onOpen(doc.id)}>
      <div className="doc-thumb" style={{ aspectRatio: doc.aspectRatio > 0 ? doc.aspectRatio : 16 / 9 }}>
        {ready ? (
          <img src={slideUrl(doc.id, 1)} alt="" loading="lazy" decoding="async" />
        ) : (
          <span aria-hidden>{doc.status === 'error' ? '⚠️' : '⏳'}</span>
        )}
      </div>
      <div className="doc-card-body">
        <div className="doc-title">{doc.title}</div>
        <div className="doc-sub">
          {doc.fileName} · {formatDate(doc.createdAt)}
          {ready && ` · ${doc.pageCount}장`}
        </div>
        {doc.status === 'processing' && <DocProgress doc={doc} compact />}
        {doc.status === 'error' && <div className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</div>}
      </div>
    </button>
  );
}

function ProgressBar({ fraction }: { fraction: number | null }) {
  return (
    <div className={fraction === null ? 'progress is-indeterminate' : 'progress'} role="progressbar">
      <div className="progress-fill" style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
    </div>
  );
}

export function DocProgress({ doc, compact = false }: { doc: DocMeta; compact?: boolean }) {
  const fraction = doc.pageCount > 0 ? Math.min(1, doc.progress / doc.pageCount) : null;
  return (
    <div className={compact ? 'doc-progress compact' : 'doc-progress'}>
      <ProgressBar fraction={fraction} />
      <span className="doc-progress-text">
        {doc.pageCount > 0 ? `슬라이드 변환 중 ${doc.progress} / ${doc.pageCount}` : 'PDF 분석 중…'}
      </span>
    </div>
  );
}

/** Shown in place of the split view while the selected doc is processing or failed. */
export function DocStatusView({ doc, onBack }: { doc: DocMeta; onBack: () => void }) {
  return (
    <div className="library">
      <div className="library-inner status-view">
        <div className="status-card">
          <div className="status-icon" aria-hidden>
            {doc.status === 'error' ? '⚠️' : '⏳'}
          </div>
          <h2>{doc.title}</h2>
          <p className="muted small">{doc.fileName}</p>
          {doc.status === 'processing' ? (
            <>
              <DocProgress doc={doc} />
              <p className="muted small">
                슬라이드 이미지·텍스트·개요 이미지를 만드는 중이에요. 끝나면 자동으로 열려요.
              </p>
            </>
          ) : (
            <div className="doc-error">{doc.error ?? '처리 중 오류가 발생했어요'}</div>
          )}
          <button type="button" className="ghost-btn" onClick={onBack}>
            ← 라이브러리
          </button>
        </div>
      </div>
    </div>
  );
}
