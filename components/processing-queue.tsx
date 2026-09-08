"use client";

import { useRef } from "react";
import type { LessonProcessingJob } from "../lib/lesson-processing-job";

type Props = {
  jobs: LessonProcessingJob[];
  lessonActive: boolean;
  onOpen: (lessonId: string) => void;
  onRetry: (job: LessonProcessingJob) => void;
  onReselect: (job: LessonProcessingJob, files: File[]) => void;
  onDiscard: (job: LessonProcessingJob) => void;
};

export function ProcessingQueue({ jobs, lessonActive, onOpen, onRetry, onReselect, onDiscard }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const reselectJobRef = useRef<LessonProcessingJob | null>(null);
  if (!jobs.length) return null;

  return <section className="processing-queue" aria-labelledby="processing-queue-title">
    <div className="processing-queue-heading">
      <div>
        <h2 id="processing-queue-title">Preparing lessons</h2>
        <p>You can keep using the app while your materials are prepared.</p>
      </div>
      <span>{jobs.filter((job) => !["ready", "error", "needs-source"].includes(job.status)).length} active</span>
    </div>
    <ol>{jobs.map((job) => <li key={job.id} className={`processing-job processing-job-${job.status}`}>
      <div>
        <strong>{job.title}</strong>
        <span>{friendlyStatus(job.status)}</span>
        {job.error && <small>We couldn't prepare this lesson.</small>}
      </div>
      <div className="processing-job-actions">
        {job.status === "ready" && <button
          type="button"
          disabled={lessonActive}
          title={lessonActive ? "End the active lesson before opening another lesson." : undefined}
          onClick={() => onOpen(job.lessonId)}
        >Open lesson</button>}
        {job.status === "error" && job.error?.retryable && <button type="button" onClick={() => onRetry(job)}>Retry</button>}
        {job.status === "needs-source" && <button type="button" onClick={() => {
          reselectJobRef.current = job;
          inputRef.current?.click();
        }}>Reselect Sources</button>}
        <button
          type="button"
          disabled={job.status === "saving"}
          onClick={() => onDiscard(job)}
        >{job.status === "ready" ? "Dismiss" : job.status === "saving" ? "Finishing" : "Discard"}</button>
      </div>
    </li>)}</ol>
    <input
      ref={inputRef}
      className="processing-reselect-input"
      type="file"
      multiple
      accept="application/pdf,text/plain,.pdf,.txt"
      onChange={(event) => {
        const job = reselectJobRef.current;
        const files = Array.from(event.target.files ?? []);
        event.target.value = "";
        if (job && files.length) onReselect(job, files);
        reselectJobRef.current = null;
      }}
    />
  </section>;
}

function friendlyStatus(status: LessonProcessingJob["status"]) {
  return { queued: "Queued", uploading: "Uploading", processing: "Preparing lesson", saving: "Saving", ready: "Ready", error: "Couldn't prepare lesson", "needs-source": "Needs files" }[status];
}
