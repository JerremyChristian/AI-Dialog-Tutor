"use client";

import { useState, type ChangeEvent } from "react";
import {
  MAX_CLOUD_SOURCE_BUNDLE_BYTES,
  MAX_LESSON_SOURCES,
  MAX_SOURCE_BUNDLE_BYTES,
  MAX_SOURCE_BYTES,
  SUPPORTED_SOURCE_TYPES,
  type LessonSource,
  type LessonSourceRole,
  type SupportedSourceType,
} from "../lib/learning-source";

type Props = {
  disabled: boolean;
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
function aggregateName(sources: LessonSource[]) {
  if (sources.length === 1) return sources[0].name;
  return sources[0]?.name.replace(/\.(pdf|txt)$/i, "").replace(/\b(slides?|transcript|notes?|summary)\b/ig, "").trim() || `${sources.length} source lesson`;
}

export function LearningSourceUpload({ disabled, cloudUserId, onQueueBundle, onDebug }: Props) {
  const [selected, setSelected] = useState<SelectedSource[]>([]);
  const [lessonName, setLessonName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []); event.target.value = "";
    const invalid = files.find((file) => !SUPPORTED_SOURCE_TYPES.includes(file.type as SupportedSourceType) || !file.size || file.size > MAX_SOURCE_BYTES);
    if (invalid) {
      setFailure(!SUPPORTED_SOURCE_TYPES.includes(invalid.type as SupportedSourceType) ? `${invalid.name} is not a PDF or TXT file.` : !invalid.size ? `${invalid.name} is empty.` : `${invalid.name} exceeds the 20 MB per-source limit.`);
      return;
    }
    const accepted = files.slice(0, MAX_LESSON_SOURCES - selected.length).map((file): SelectedSource => ({
      file,
      metadata: { id: crypto.randomUUID(), name: file.name, mimeType: file.type as SupportedSourceType, sizeBytes: file.size, role: inferRole(file.name), storageStatus: "local" },
    }));
    const next = [...selected, ...accepted]; if (!next.length) return;
    setSelected(next);
    const total = next.reduce((sum, item) => sum + item.file.size, 0);
    const limit = cloudUserId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
    setFailure(total > limit ? `This bundle exceeds the ${cloudUserId ? "40 MB cloud" : "4 MB signed-out"} limit.` : null);
    onDebug(`Source bundle selected: sources=${next.length}, pdfs=${next.filter((item) => item.file.type === "application/pdf").length}, txt=${next.filter((item) => item.file.type === "text/plain").length}, totalBytes=${total}`);
  };
  const updateRole = (id: string, role: LessonSourceRole) => setSelected((current) => current.map((item) => item.metadata.id === id ? { ...item, metadata: { ...item.metadata, role } } : item));
  const processBundle = async () => {
    const sources = selected.map((item) => item.metadata); if (!sources.length) return;
    try {
      await onQueueBundle(sources, new Map(selected.map((item) => [item.metadata.id, item.file])), lessonName.trim() || aggregateName(sources));
      setSelected([]); setLessonName(""); setFailure(null);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The lesson could not be queued.");
    }
  };
  const totalBytes = selected.reduce((sum, item) => sum + item.file.size, 0);
  const bundleLimit = cloudUserId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
  return <section className="source-upload" aria-labelledby="source-upload-title">
    <div className="source-upload-heading"><div><p className="step-label">1 · Name your lesson</p><h2 id="source-upload-title">Create a new lesson</h2><p>Add a name now, or we will suggest one from your learning materials.</p></div></div>
    <label className="lesson-name-field"><span>Lesson name</span><input type="text" maxLength={120} value={lessonName} onChange={(event) => setLessonName(event.target.value)} placeholder="e.g. Week 3: Photosynthesis" disabled={disabled} /></label>
    <div className="upload-step-heading"><p className="step-label">2 · Add learning materials</p><p>Choose up to {MAX_LESSON_SOURCES} PDF or TXT files. 20 MB each, {formatBytes(bundleLimit)} total. {!cloudUserId && "Sign in for a larger upload limit."}</p></div>
    {selected.map(({ metadata }) => <div className="source-details" key={metadata.id}><div><strong>{metadata.name}</strong><small>{metadata.mimeType === "application/pdf" ? "PDF" : "TXT"} · {formatBytes(metadata.sizeBytes)}</small><small>Ready to queue</small></div><div className="source-actions"><label><span>Role</span><select aria-label={`Role for ${metadata.name}`} value={metadata.role} onChange={(event) => updateRole(metadata.id, event.target.value as LessonSourceRole)} disabled={disabled}><option value="slides">Slides</option><option value="transcript">Transcript</option><option value="notes">Notes</option><option value="other">Other</option></select></label><button type="button" className="source-remove" onClick={() => setSelected((current) => current.filter((item) => item.metadata.id !== metadata.id))} disabled={disabled}>Remove</button></div></div>)}
    <input className="source-file-input" type="file" multiple accept="application/pdf,text/plain,.pdf,.txt" onChange={selectFiles} disabled={disabled || selected.length >= MAX_LESSON_SOURCES} />
    {selected.length > 0 && <p className="source-bundle-total">{selected.length} source{selected.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} total</p>}
    {failure && <p className="source-error" role="alert">{failure}</p>}
    {selected.length > 0 && <div className="create-lesson-action"><button type="button" className="button-primary" onClick={() => void processBundle()} disabled={disabled || totalBytes > bundleLimit}>Create Lesson</button></div>}
  </section>;
}
