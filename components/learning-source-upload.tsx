"use client";

import { useEffect, useState, type ChangeEvent } from "react";
import {
  MAX_CLOUD_SOURCE_BUNDLE_BYTES, MAX_LESSON_SOURCES, MAX_SOURCE_BUNDLE_BYTES, MAX_SOURCE_BYTES, SUPPORTED_SOURCE_TYPES,
  type LearningSource, type LessonSource, type LessonSourceRole,
  type PreparedLearningSource, type SupportedSourceType,
} from "../lib/learning-source";

type Props = {
  source: LearningSource | null; sources: LessonSource[]; disabled: boolean;
  onChange: (source: LearningSource | null) => void;
  onSourcesChange: (sources: LessonSource[], files: Map<string, File>) => void;
  onPreparedChange: (source: PreparedLearningSource | null) => void;
  onRetrySourceUpload: () => void;
  cloudUserId: string | null;
  onQueueBundle: (sources: LessonSource[], files: Map<string, File>, title: string) => Promise<void>;
  onDebug: (message: string) => void;
};
type SelectedSource = { metadata: LessonSource; file: File };

function inferRole(name: string): LessonSourceRole {
  const normalized = name.toLowerCase();
  if (/transcript|recording|caption/.test(normalized)) return "transcript";
  if (/notes?|summary/.test(normalized)) return "notes";
  if (/slides?|lecture/.test(normalized)) return "slides";
  return "other";
}
function formatBytes(bytes: number) {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function aggregateName(sources: LessonSource[], title?: string) {
  if (title?.trim()) return title.trim();
  if (sources.length === 1) return sources[0].name;
  return sources[0]?.name.replace(/\.(pdf|txt)$/i, "").replace(/\b(slides?|transcript|notes?|summary)\b/ig, "").trim() || `${sources.length} source lesson`;
}

export function LearningSourceUpload({ source, sources, disabled, onChange, onSourcesChange, onPreparedChange, onRetrySourceUpload, cloudUserId, onQueueBundle, onDebug }: Props) {
  const [selected, setSelected] = useState<SelectedSource[]>([]);
  const [failure, setFailure] = useState<{ message: string; retryable: boolean } | null>(null);
  useEffect(() => {
    if (!sources.length) setSelected([]);
    else setSelected((current) => current.map((item) => ({ ...item, metadata: sources.find((source) => source.id === item.metadata.id) ?? item.metadata })));
  }, [sources]);

  const publish = (next: SelectedSource[]) => {
    setSelected(next);
    onSourcesChange(next.map(i => i.metadata), new Map(next.map(i => [i.metadata.id, i.file])));
  };
  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []); event.target.value = "";
    const invalid = files.find((file) => !SUPPORTED_SOURCE_TYPES.includes(file.type as SupportedSourceType) || !file.size || file.size > MAX_SOURCE_BYTES);
    if (invalid) {
      setFailure({ message: !SUPPORTED_SOURCE_TYPES.includes(invalid.type as SupportedSourceType) ? `${invalid.name} is not a PDF or TXT file.` : !invalid.size ? `${invalid.name} is empty.` : `${invalid.name} exceeds the 20 MB per-source limit.`, retryable: false });
      return;
    }
    const accepted = files.slice(0, MAX_LESSON_SOURCES - selected.length).flatMap((file): SelectedSource[] => {
      if (!SUPPORTED_SOURCE_TYPES.includes(file.type as SupportedSourceType) || !file.size || file.size > MAX_SOURCE_BYTES) return [];
      return [{ file, metadata: { id: crypto.randomUUID(), name: file.name, mimeType: file.type as SupportedSourceType, sizeBytes: file.size, role: inferRole(file.name), storageStatus: "local" } }];
    });
    const next = [...selected, ...accepted]; if (!next.length) return;
    publish(next); onPreparedChange(null);
    const total = next.reduce((n, i) => n + i.file.size, 0);
    const limit = cloudUserId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
    setFailure(total > limit ? { message: `This bundle exceeds the ${cloudUserId ? "40" : "4"} MB ${cloudUserId ? "cloud" : "signed-out"} limit. Remove one or more sources.`, retryable: false } : null);
    onChange({ name: aggregateName(next.map(i => i.metadata)), mimeType: next[0].metadata.mimeType, sizeBytes: total, status: "preparing" });
    onDebug(`Source bundle selected: sources=${next.length}, pdfs=${next.filter(i => i.file.type === "application/pdf").length}, txt=${next.filter(i => i.file.type === "text/plain").length}, totalBytes=${total}`);
  };
  const updateRole = (id: string, role: LessonSourceRole) => {
    const next = selected.map(i => i.metadata.id === id ? { ...i, metadata: { ...i.metadata, role } } : i);
    publish(next); onPreparedChange(null);
  };
  const remove = (id: string) => {
    const next = selected.filter(i => i.metadata.id !== id); publish(next); onPreparedChange(null); setFailure(null);
    const total = next.reduce((n, i) => n + i.file.size, 0);
    onChange(next.length ? { name: aggregateName(next.map(i => i.metadata)), mimeType: next[0].metadata.mimeType, sizeBytes: total, status: "preparing" } : null);
  };
  const processBundle = async () => {
    if (!selected.length) return;
    const total = selected.reduce((n, i) => n + i.file.size, 0);
    const limit = cloudUserId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
    if (total > limit) { const message = `This bundle exceeds the ${cloudUserId ? "40" : "4"} MB limit.`; setFailure({ message, retryable: false }); onChange({ name: aggregateName(sources), mimeType: selected[0].metadata.mimeType, sizeBytes: total, status: "error", error: message }); return; }
    try {
      await onQueueBundle(selected.map((item) => item.metadata), new Map(selected.map((item) => [item.metadata.id, item.file])), aggregateName(selected.map((item) => item.metadata)));
      setSelected([]); setFailure(null); onSourcesChange([], new Map()); onPreparedChange(null); onChange(null);
      return;
    } catch (error) {
      setFailure({ message: error instanceof Error ? error.message : "The lesson could not be queued.", retryable: true });
      return;
    }
  };
  const totalBytes = selected.reduce((n, i) => n + i.file.size, 0);
  return <section className="source-upload" aria-labelledby="source-upload-title">
    <div className="source-upload-heading"><div><h2 id="source-upload-title">Sources</h2><p>Choose up to {MAX_LESSON_SOURCES} PDFs or TXT files. 20 MB per file; {formatBytes(cloudUserId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES)} total. {!cloudUserId && "Sign in for larger durable jobs."}</p></div><span className={`source-status source-status-${source?.status || "none"}`}>{source ? source.status : "No material"}</span></div>
    {selected.map(({ metadata }) => <div className="source-details" key={metadata.id}><div><strong>{metadata.name}</strong><small>{metadata.mimeType === "application/pdf" ? "PDF" : "TXT"} · {formatBytes(metadata.sizeBytes)}</small><small>{metadata.storageStatus === "stored" ? "Stored in cloud" : metadata.storageStatus === "error" ? "Cloud upload failed" : metadata.storageStatus === "uploading" ? "Uploading to cloud…" : "Local original"}</small></div><div className="source-actions"><select aria-label={`Role for ${metadata.name}`} value={metadata.role} onChange={e => updateRole(metadata.id, e.target.value as LessonSourceRole)} disabled={disabled || source?.status === "processing" || source?.status === "ready"}><option value="slides">Slides</option><option value="transcript">Transcript</option><option value="notes">Notes</option><option value="other">Other</option></select><button type="button" className="source-remove" onClick={() => remove(metadata.id)} disabled={disabled || source?.status === "processing" || source?.status === "ready"}>Remove</button></div></div>)}
    <input className="source-file-input" type="file" multiple accept="application/pdf,text/plain,.pdf,.txt" onChange={selectFiles} disabled={disabled || selected.length >= MAX_LESSON_SOURCES || source?.status === "processing" || source?.status === "ready"} />
    {selected.length > 0 && <p className="source-bundle-total">{selected.length} source{selected.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} total</p>}
    {failure && <p className="source-error" role="alert">{failure.message}</p>}
    {sources.some((item) => item.storageStatus === "error") && <button type="button" className="source-retry" onClick={onRetrySourceUpload} disabled={disabled}>Retry source upload</button>}
    {selected.length > 0 && source?.status !== "ready" && <button type="button" className="source-retry" onClick={() => void processBundle()} disabled={disabled || source?.status === "processing" || totalBytes > (cloudUserId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES)}>Add lesson to queue</button>}
  </section>;
}
