import { useState, useRef } from 'react';
import { X, Plus, Upload } from 'lucide-react';
import { useSwipeToClose } from '../hooks/useSwipeToClose';
import { useEscapeClose } from '../hooks/useEscapeClose';

interface Props {
  title: string;
  urlPlaceholder?: string;
  onAddUrl: (url: string) => Promise<unknown> | void;
  onUpload?: (files: FileList) => Promise<unknown> | void;
  uploadMultiple?: boolean;
  onClose: () => void;
}

// Small shared popup for "paste a URL or upload a file" — used by the trip
// cover photo and the place photo gallery, so the pattern (a lone +
// affordance that opens this) stays consistent across both.
export function QuickAddSheet({ title, urlPlaceholder = 'https://…', onAddUrl, onUpload, uploadMultiple, onClose }: Props) {
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { sheetRef, handleProps } = useSwipeToClose(onClose);
  useEscapeClose(onClose);

  // Guard inside the handler, not just on the button: Enter in the input
  // calls this directly, and repeated presses during the await would add
  // the same URL several times.
  const handleAddUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    await onAddUrl(trimmed);
    setSubmitting(false);
    onClose();
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !onUpload) return;
    setUploading(true);
    await onUpload(files);
    setUploading(false);
    onClose();
  };

  return (
    // Always rendered nested inside another sheet (trip settings, place
    // detail) — stop propagation so a backdrop tap here doesn't also
    // close the sheet this popup is opened from
    <div className="bottom-sheet-overlay" onClick={e => { e.stopPropagation(); onClose(); }}>
      <div
        className="bottom-sheet quick-add-sheet"
        ref={sheetRef}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="bottom-sheet-handle" {...handleProps} />
        <div className="sheet-header-row">
          <h2 className="bottom-sheet-title">{title}</h2>
          <button className="sheet-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>

        <div className="add-image-row">
          <input
            type="url"
            className="input"
            placeholder={urlPlaceholder}
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.nativeEvent.isComposing && handleAddUrl()}
            autoFocus
          />
          <button className="btn-icon" onClick={handleAddUrl} disabled={!url.trim() || submitting} aria-label="Add">
            <Plus size={20} />
          </button>
        </div>

        {onUpload && (
          <>
            <button
              className="btn-secondary upload-photos-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <Upload size={16} />
              {uploading ? 'Uploading…' : 'Upload from device'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple={uploadMultiple}
              className="visually-hidden"
              onChange={handleFilesSelected}
            />
          </>
        )}
      </div>
    </div>
  );
}
