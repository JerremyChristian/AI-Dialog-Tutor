"use client";

import { useRef } from "react";
import type { LessonProcessingJob } from "../lib/lesson-processing-job";

type Props = {
  jobs: LessonProcessingJob[];
  lessonActive: boolean;
  onStudy: (lessonId: string, job: LessonProcessingJob) => void;
  onRetry: (job: LessonProcessingJob) => void;
  onReselect: (job: LessonProcessingJob, files: File[]) => void;
  onDiscard: (job: LessonProcessingJob) => void;
};

export function ProcessingQueue({ jobs, lessonActive, onStudy, onRetry, onReselect, onDiscard }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reselectJobRef = useRef<LessonProcessingJob | null>(null);
  if (!jobs.length) return null;
  return <section className="processing-queue" aria-labelledby="processing-queue-title">
    <div className="processing-queue-heading"><div><h2 id="processing-queue-title">Processing</h2><p>Lessons run one at a time while this app remains open.</p></div><span>{jobs.filter((job) => job.status !== "ready").length} active</span></div>
    <ol>{jobs.map((job) => <li key={job.id} className={`processing-job processing-job-${job.status}`}>
      <div><strong>{job.title}</strong><span>{job.phase}</span>{job.error && <small>{job.error.message}</small>}</div>
      <div className="processing-job-actions">
        {job.status === "ready" && <button type="button" disabled={lessonActive} onClick={() => onStudy(job.lessonId, job)}>{lessonActive ? "Ready" : "Study"}</button>}
        {job.status === "error" && <button type="button" onClick={() => onRetry(job)}>Retry</button>}
        {job.status === "needs-source" && <button type="button" onClick={() => { reselectJobRef.current = job; inputRef.current?.click(); }}>Reselect</button>}
        <button type="button" disabled={job.status === "saving"} onClick={() => onDiscard(job)}>{job.status === "ready" ? "Dismiss" : job.status === "saving" ? "Finishing" : "Discard"}</button>
      </div>
    </li>)}</ol>
    <input ref={inputRef} className="processing-reselect-input" type="file" multiple accept="application/pdf,text/plain,.pdf,.txt" onChange={(event) => {
      const job = reselectJobRef.current; const files = Array.from(event.target.files ?? []); event.target.value = "";
      if (job && files.length) onReselect(job, files); reselectJobRef.current = null;
    }} />
  </section>;
}
