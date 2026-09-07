"use client";

import { useEffect, useRef, useState } from "react";
import type { LessonSource, LessonTreeItem } from "./learning-source";
import { MAX_CLOUD_SOURCE_BUNDLE_BYTES, MAX_SOURCE_BUNDLE_BYTES } from "./learning-source";
import { createLessonState } from "./lesson-state";
import { DEFAULT_TEACHING_PREFERENCES } from "./teaching-preferences";
import { SAVED_LESSON_SCHEMA_VERSION, deleteSavedLesson, getSavedLesson, saveSavedLesson, type SavedLesson } from "./local-persistence";
import {
  createQueuedSourceUpload, deleteCloudLesson, deletePreLessonSourceObjects, finalizeCloudLesson,
  upsertStoredLessonSources,
} from "./cloud-sync";
import {
  deleteProcessingJob, listProcessingJobs, saveProcessingJob,
  type LessonProcessingJob,
} from "./lesson-processing-job";
import { isSourceProcessingErrorResponse, type SourceProcessingErrorCode } from "./source-processing-error";

type PreparedResponse = { lessonTitle?: string; structuredText?: string; lessonTree?: LessonTreeItem[]; model?: string };
type Options = {
  ownerId: string | null;
  onDebug: (message: string) => void;
  onLessonReady: (lesson: SavedLesson) => void | Promise<void>;
};

export function useLessonProcessingQueue({ ownerId, onDebug, onLessonReady }: Options) {
  const [jobs, setJobs] = useState<LessonProcessingJob[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const filesRef = useRef(new Map<string, Map<string, File>>());
  const runningRef = useRef<string | null>(null);
  const discardedRef = useRef(new Set<string>());
  const abortRef = useRef(new Map<string, () => void>());
  const debugRef = useRef(onDebug);
  const readyRef = useRef(onLessonReady);
  const ownerRef = useRef(ownerId);
  const ownerEpochRef = useRef(0);
  debugRef.current = onDebug; readyRef.current = onLessonReady;

  const publish = async (job: LessonProcessingJob) => {
    if (discardedRef.current.has(job.id)) return;
    await saveProcessingJob(job);
    if (discardedRef.current.has(job.id)) { await deleteProcessingJob(job.id); return; }
    if (ownerRef.current !== job.ownerId) return;
    setJobs((current) => [...current.filter((item) => item.id !== job.id), job].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  };

  useEffect(() => {
    ownerRef.current = ownerId;
    ownerEpochRef.current += 1;
    let active = true; setHydrated(false); setJobs([]); runningRef.current = null;
    void listProcessingJobs(ownerId).then(async (loaded) => {
      const recovered: LessonProcessingJob[] = [];
      for (const job of loaded) {
        let next = job;
        if (job.status === "uploading" || job.status === "processing" || job.status === "saving") {
          const runnable = Boolean(ownerId && job.sources.every((source) => source.storageStatus === "stored" && source.storagePath));
          next = { ...job, status: runnable ? "queued" : "needs-source", phase: runnable ? "Queued" : "Source file required", updatedAt: new Date().toISOString(), generation: job.generation + 1 };
          await saveProcessingJob(next);
          debugRef.current(`Processing job recovered after reload: job=${job.id}, oldStatus=${job.status}, newStatus=${next.status}`);
        } else if (job.status === "queued" && !ownerId) {
          next = { ...job, status: "needs-source", phase: "Source file required", updatedAt: new Date().toISOString() };
          await saveProcessingJob(next);
        } else if (job.status === "error" && (!ownerId || job.sources.some((source) => source.storageStatus !== "stored" || !source.storagePath))) {
          next = { ...job, status: "needs-source", phase: "Source file required", updatedAt: new Date().toISOString(), generation: job.generation + 1 };
          await saveProcessingJob(next);
        } else if (job.status === "ready" && !(await getSavedLesson(job.lessonId))) {
          next = { ...job, status: ownerId ? "queued" : "needs-source", phase: ownerId ? "Queued" : "Source file required", updatedAt: new Date().toISOString(), generation: job.generation + 1 };
          await saveProcessingJob(next);
        }
        recovered.push(next);
      }
      if (active) { setJobs(recovered); setHydrated(true); }
    }).catch(() => { if (active) setHydrated(true); });
    return () => { active = false; for (const abort of abortRef.current.values()) abort(); abortRef.current.clear(); };
  }, [ownerId]);

  const enqueue = async (sources: LessonSource[], files: Map<string, File>, title: string) => {
    const total = sources.reduce((sum, source) => sum + source.sizeBytes, 0);
    const limit = ownerId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
    if (!sources.length || total > limit) throw new Error(`Bundle exceeds the ${ownerId ? "40" : "4"} MB limit.`);
    const now = new Date().toISOString();
    const job: LessonProcessingJob = {
      id: crypto.randomUUID(), lessonId: crypto.randomUUID(), ownerId, title,
      sources: sources.map((source) => ({ ...source, storagePath: null, storageStatus: "local", storageError: undefined })),
      status: "queued", phase: "Queued", createdAt: now, updatedAt: now, generation: 0,
    };
    filesRef.current.set(job.id, files);
    await publish(job);
    debugRef.current(`Processing job created: job=${job.id}, lesson=${job.lessonId}, sources=${job.sources.length}`);
  };

  useEffect(() => {
    if (!hydrated || runningRef.current) return;
    const job = jobs.find((item) => item.status === "queued" && item.ownerId === ownerId);
    if (!job) return;
    runningRef.current = job.id;
    const epoch = ownerEpochRef.current;
    debugRef.current(`Processing queue: started=${job.id}`);
    void runJob(job).finally(() => {
      if (ownerEpochRef.current === epoch && runningRef.current === job.id) {
        runningRef.current = null;
        setJobs((current) => [...current]);
      }
    });

    async function runJob(initial: LessonProcessingJob) {
      let job = initial;
      let processingTimeout: number | undefined;
      try {
        const existingLesson = await getSavedLesson(job.lessonId);
        if (existingLesson && existingLesson.sources.length === job.sources.length &&
            existingLesson.sources.every((source) => job.sources.some((candidate) => candidate.id === source.id))) {
          job = await setPhase(job, "saving", "Saving lesson");
          if (discardedRef.current.has(job.id)) return;
          let recovered = existingLesson;
          if (job.ownerId) {
            recovered = await finalizeCloudLesson(existingLesson, job.ownerId, debugRef.current);
            await upsertStoredLessonSources(recovered, job.ownerId, debugRef.current);
          }
          job = await setPhase(job, "ready", "Ready");
          await readyRef.current(recovered);
          debugRef.current(`Lesson finalized: job=${job.id}, lesson=${job.lessonId}, recovered=yes`);
          return;
        }
        if (job.ownerId) {
          const jobOwnerId = job.ownerId;
          job = await setPhase(job, "uploading", "Uploading sources");
          if (discardedRef.current.has(job.id)) return;
          const files = filesRef.current.get(job.id);
          for (let index = 0; index < job.sources.length; index += 1) {
            const source = job.sources[index];
            if (source.storageStatus === "stored" && source.storagePath) continue;
            const file = files?.get(source.id);
            if (!file) {
              await setPhase(job, "needs-source", "Source file required");
              return;
            }
            debugRef.current(`Source upload: job=${job.id}, source=${source.id}, state=started`);
            const queuedUpload = await createQueuedSourceUpload(file, source, job.lessonId, jobOwnerId);
            abortRef.current.set(job.id, () => void queuedUpload.abort());
            let storagePath: string;
            try {
              storagePath = await queuedUpload.promise;
            } catch (error) {
              const sources = [...job.sources];
              sources[index] = { ...source, storageStatus: "error", storageError: "Source upload failed." };
              job = { ...job, sources, updatedAt: new Date().toISOString() };
              await publish(job);
              debugRef.current(`Source upload: job=${job.id}, source=${source.id}, state=failed`);
              throw error;
            }
            abortRef.current.delete(job.id);
            const sources = [...job.sources];
            sources[index] = { ...source, storagePath, storageStatus: "stored", storageError: undefined };
            job = { ...job, sources, updatedAt: new Date().toISOString() };
            await publish(job);
            debugRef.current(`Source upload: job=${job.id}, source=${source.id}, state=stored`);
          }
        } else if (!filesRef.current.get(job.id)) {
          await setPhase(job, "needs-source", "Source file required");
          return;
        }

        job = await setPhase(job, "processing", "Processing sources");
        if (discardedRef.current.has(job.id)) return;
        const controller = new AbortController();
        abortRef.current.set(job.id, () => controller.abort());
        processingTimeout = window.setTimeout(() => controller.abort(), 315_000);
        const response = await (job.ownerId
          ? fetch("/api/lesson-sources", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
              lessonId: job.lessonId,
              sources: job.sources.map((source) => ({ id: source.id, name: source.name, mimeType: source.mimeType, sizeBytes: source.sizeBytes, role: source.role, storagePath: source.storagePath })),
            }), signal: controller.signal })
          : fetchLocal(job, filesRef.current.get(job.id)!, controller.signal));
        window.clearTimeout(processingTimeout);
        processingTimeout = undefined;
        abortRef.current.delete(job.id);
        const body: unknown = await response.json().catch(() => null);
        if (discardedRef.current.has(job.id)) return;
        if (!response.ok) {
          if (isSourceProcessingErrorResponse(body)) throw body;
          throw { code: "UNKNOWN" as const, retryable: response.status >= 500, message: "The lesson could not be processed." };
        }
        const prepared = body as PreparedResponse;
        if (!prepared.structuredText?.trim() || !prepared.lessonTree?.length) throw { code: "UNKNOWN" as const, retryable: false, message: "The model returned no usable lesson." };
        job = await setPhase(job, "saving", "Saving lesson");
        if (discardedRef.current.has(job.id)) return;
        const lesson = buildLesson(job, prepared);
        await saveSavedLesson(lesson);
        if (discardedRef.current.has(job.id)) return;
        let finalized = lesson;
        if (job.ownerId) {
          finalized = await finalizeCloudLesson(lesson, job.ownerId, debugRef.current);
          await upsertStoredLessonSources(finalized, job.ownerId, debugRef.current);
          await saveSavedLesson(finalized);
        }
        if (discardedRef.current.has(job.id)) return;
        job = await setPhase(job, "ready", "Ready");
        filesRef.current.delete(job.id);
        await readyRef.current(finalized);
        debugRef.current(`Lesson finalized: job=${job.id}, lesson=${job.lessonId}`);
        debugRef.current(`Processing queue: completed=${job.id}`);
      } catch (error) {
        if (discardedRef.current.has(job.id)) return;
        const normalized = normalizeFailure(error, job.status);
        await publish({ ...job, status: "error", phase: "Processing failed", error: normalized, updatedAt: new Date().toISOString() });
        debugRef.current(`Processing queue: failed=${job.id}, category=${normalized.category}`);
      } finally { if (processingTimeout) window.clearTimeout(processingTimeout); abortRef.current.delete(job.id); }
    }

    async function setPhase(job: LessonProcessingJob, status: LessonProcessingJob["status"], phase: string) {
      const next = { ...job, status, phase, error: undefined, updatedAt: new Date().toISOString() };
      await publish(next); return next;
    }
  }, [hydrated, jobs, ownerId]);

  const retry = async (job: LessonProcessingJob) => {
    const missing = job.sources.some((source) => source.storageStatus !== "stored" || !source.storagePath);
    if (missing && !filesRef.current.get(job.id)) {
      await publish({ ...job, status: "needs-source", phase: "Source file required", error: undefined, updatedAt: new Date().toISOString(), generation: job.generation + 1 });
      return;
    }
    debugRef.current(`Processing retry: job=${job.id}, reason=${job.error?.category ?? "manual"}`);
    await publish({ ...job, status: "queued", phase: "Queued", error: undefined, updatedAt: new Date().toISOString(), generation: job.generation + 1 });
  };

  const reselect = async (job: LessonProcessingJob, files: File[]) => {
    const unmatched = [...files]; const mapped = new Map<string, File>();
    for (const source of job.sources.filter((item) => item.storageStatus !== "stored" || !item.storagePath)) {
      const index = unmatched.findIndex((file) => file.name === source.name && file.type === source.mimeType && file.size === source.sizeBytes);
      if (index < 0) throw new Error(`Reselect ${source.name} with the same file.`);
      mapped.set(source.id, unmatched.splice(index, 1)[0]);
    }
    filesRef.current.set(job.id, mapped);
    await retry(job);
  };

  const discard = async (job: LessonProcessingJob) => {
    discardedRef.current.add(job.id); abortRef.current.get(job.id)?.(); abortRef.current.delete(job.id);
    if (job.ownerId && job.status !== "ready") {
      try {
        await deleteCloudLesson(job.lessonId, job.ownerId);
      } catch {
        await deletePreLessonSourceObjects(job.sources.flatMap((source) => source.storagePath ? [source.storagePath] : []), job.ownerId);
      }
    }
    if (job.status !== "ready") await deleteSavedLesson(job.lessonId);
    filesRef.current.delete(job.id); await deleteProcessingJob(job.id);
    setJobs((current) => current.filter((item) => item.id !== job.id));
  };

  return { jobs: jobs.filter((job) => job.ownerId === ownerId), hydrated, enqueue, retry, reselect, discard };
}

async function fetchLocal(job: LessonProcessingJob, files: Map<string, File>, signal: AbortSignal) {
  const form = new FormData(); form.append("metadata", JSON.stringify(job.sources));
  for (const source of job.sources) { const file = files.get(source.id); if (!file) throw new Error("Source file required"); form.append("sources", file, file.name); }
  return fetch("/api/lesson-sources", { method: "POST", body: form, signal });
}

function buildLesson(job: LessonProcessingJob, prepared: PreparedResponse): SavedLesson {
  const title = prepared.lessonTitle?.trim() || job.title;
  const tree = prepared.lessonTree!;
  const now = new Date().toISOString();
  return {
    schemaVersion: SAVED_LESSON_SCHEMA_VERSION, id: job.lessonId, title, lessonFocus: "", hasStarted: false,
    source: { metadata: { name: title, mimeType: job.sources[0].mimeType, sizeBytes: job.sources.reduce((sum, source) => sum + source.sizeBytes, 0), status: "ready" },
      prepared: { name: title, mimeType: job.sources[0].mimeType, text: prepared.structuredText!, lessonTree: tree } },
    sources: job.sources, lessonState: createLessonState(`Main topics in ${title}`, tree), recentTeachingContext: [],
    teachingPreferences: DEFAULT_TEACHING_PREFERENCES, createdAt: job.createdAt, updatedAt: now, cloudOwnerId: job.ownerId,
  };
}

function normalizeFailure(error: unknown, status: LessonProcessingJob["status"]): NonNullable<LessonProcessingJob["error"]> {
  if (status === "uploading") return { category: "UPLOAD_FAILED", message: error instanceof Error ? error.message : "Source upload failed.", retryable: true };
  if (status === "saving") return { category: "SAVE_FAILED", message: error instanceof Error ? error.message : "Lesson finalization failed.", retryable: true };
  if (isSourceProcessingErrorResponse(error)) return { category: error.code, message: error.message, retryable: error.retryable };
  const aborted = error instanceof DOMException && error.name === "AbortError";
  return { category: (aborted ? "PROCESSING_TIMEOUT" : "UNKNOWN") as SourceProcessingErrorCode, message: aborted ? "Processing was interrupted." : error instanceof Error ? error.message : "Processing failed.", retryable: true };
}
