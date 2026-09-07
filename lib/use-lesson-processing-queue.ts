"use client";

import { useEffect, useRef, useState } from "react";
import {
  MAX_CLOUD_SOURCE_BUNDLE_BYTES,
  MAX_LESSON_SOURCES,
  MAX_SOURCE_BUNDLE_BYTES,
  MAX_SOURCE_BYTES,
  type LessonSource,
  type LessonTreeItem,
} from "./learning-source";
import { createLessonState } from "./lesson-state";
import { DEFAULT_TEACHING_PREFERENCES } from "./teaching-preferences";
import {
  SAVED_LESSON_SCHEMA_VERSION,
  deleteSavedLesson,
  getSavedLesson,
  saveSavedLesson,
  type SavedLesson,
} from "./local-persistence";
import {
  createQueuedSourceUpload,
  deleteCloudLesson,
  deletePreLessonSourceObjects,
  finalizeCloudLesson,
  upsertStoredLessonSources,
} from "./cloud-sync";
import {
  deleteProcessingJob,
  listProcessingJobs,
  saveProcessingJob,
  type LessonProcessingJob,
} from "./lesson-processing-job";
import {
  isSourceProcessingErrorResponse,
  type SourceProcessingErrorCode,
} from "./source-processing-error";

type PreparedResponse = {
  lessonTitle?: string;
  structuredText?: string;
  lessonTree?: LessonTreeItem[];
  model?: string;
};

type Options = {
  ownerId: string | null;
  onDebug: (message: string) => void;
  /** Library notification only. This callback must not hydrate an active lesson. */
  onLessonReady: (lessonId: string) => void | Promise<void>;
};

export function useLessonProcessingQueue({ ownerId, onDebug, onLessonReady }: Options) {
  const [jobs, setJobs] = useState<LessonProcessingJob[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const filesRef = useRef(new Map<string, Map<string, File>>());
  const uploadRunningRef = useRef<string | null>(null);
  const processingRunningRef = useRef<string | null>(null);
  const discardedRef = useRef(new Set<string>());
  const uploadAbortRef = useRef(new Map<string, () => void>());
  const processingAbortRef = useRef(new Map<string, () => void>());
  const processingWaitLogRef = useRef<string | null>(null);
  const debugRef = useRef(onDebug);
  const readyRef = useRef(onLessonReady);
  const ownerRef = useRef(ownerId);
  const ownerEpochRef = useRef(0);
  debugRef.current = onDebug;
  readyRef.current = onLessonReady;

  const publish = async (job: LessonProcessingJob) => {
    if (discardedRef.current.has(job.id)) return;
    await saveProcessingJob(job);
    if (discardedRef.current.has(job.id)) {
      await deleteProcessingJob(job.id);
      return;
    }
    debugRef.current(`Processing job updated: job=${job.id}, status=${job.status}`);
    if (ownerRef.current !== job.ownerId) return;
    setJobs((current) => [...current.filter((item) => item.id !== job.id), job]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  };

  useEffect(() => {
    ownerRef.current = ownerId;
    ownerEpochRef.current += 1;
    let active = true;
    setHydrated(false);
    setJobs([]);
    uploadRunningRef.current = null;
    processingRunningRef.current = null;
    void listProcessingJobs(ownerId).then(async (loaded) => {
      const recovered: LessonProcessingJob[] = [];
      for (const job of loaded) {
        let next = job;
        const stored = areSourcesStored(job);
        if (job.status === "uploading" || job.status === "processing" || job.status === "saving") {
          next = {
            ...job,
            status: stored ? "queued" : "needs-source",
            phase: stored ? "Queued" : "Needs sources",
            updatedAt: new Date().toISOString(),
            generation: job.generation + 1,
          };
          await saveProcessingJob(next);
          debugRef.current(`Processing job recovered after reload: job=${job.id}, oldStatus=${job.status}, newStatus=${next.status}`);
        } else if (job.status === "queued" && !ownerId) {
          next = { ...job, status: "needs-source", phase: "Needs sources", updatedAt: new Date().toISOString() };
          await saveProcessingJob(next);
        } else if (job.status === "error" && !stored) {
          next = {
            ...job,
            status: "needs-source",
            phase: "Needs sources",
            updatedAt: new Date().toISOString(),
            generation: job.generation + 1,
          };
          await saveProcessingJob(next);
        } else if (job.status === "ready" && !(await getSavedLesson(job.lessonId))) {
          next = {
            ...job,
            status: stored ? "queued" : "needs-source",
            phase: stored ? "Queued" : "Needs sources",
            updatedAt: new Date().toISOString(),
            generation: job.generation + 1,
          };
          await saveProcessingJob(next);
        }
        recovered.push(next);
      }
      if (active) {
        setJobs(recovered);
        setHydrated(true);
      }
    }).catch(() => {
      if (active) setHydrated(true);
    });
    return () => {
      active = false;
      for (const abort of uploadAbortRef.current.values()) abort();
      for (const abort of processingAbortRef.current.values()) abort();
      uploadAbortRef.current.clear();
      processingAbortRef.current.clear();
    };
  }, [ownerId]);

  const enqueue = async (sources: LessonSource[], files: Map<string, File>, title: string) => {
    const total = sources.reduce((sum, source) => sum + source.sizeBytes, 0);
    const limit = ownerId ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
    if (!sources.length || sources.length > MAX_LESSON_SOURCES ||
        sources.some((source) => source.sizeBytes <= 0 || source.sizeBytes > MAX_SOURCE_BYTES) ||
        sources.some((source) => {
          const file = files.get(source.id);
          return !file || file.name !== source.name || file.type !== source.mimeType || file.size !== source.sizeBytes;
        }) || total > limit) {
      throw new Error(`Bundle exceeds the ${ownerId ? "40" : "4"} MB limit.`);
    }
    const now = new Date().toISOString();
    const job: LessonProcessingJob = {
      id: crypto.randomUUID(),
      lessonId: crypto.randomUUID(),
      ownerId,
      title,
      sources: sources.map((source) => ({
        ...source,
        storagePath: null,
        storageStatus: "local",
        storageError: undefined,
      })),
      status: "queued",
      phase: "Queued",
      createdAt: now,
      updatedAt: now,
      generation: 0,
    };
    filesRef.current.set(job.id, files);
    await publish(job);
    debugRef.current(`Processing job created: job=${job.id}, lesson=${job.lessonId}, sources=${job.sources.length}`);
  };

  useEffect(() => {
    if (!hydrated || uploadRunningRef.current) return;
    const job = jobs.find((item) =>
      item.ownerId === ownerId && item.ownerId !== null && item.status === "queued" &&
      !areSourcesStored(item)
    );
    if (!job) return;
    uploadRunningRef.current = job.id;
    const epoch = ownerEpochRef.current;
    debugRef.current(`Upload worker started: job=${job.id}`);
    void runUpload(job).finally(() => {
      if (ownerEpochRef.current === epoch && uploadRunningRef.current === job.id) {
        uploadRunningRef.current = null;
        setJobs((current) => [...current]);
      }
    });

    async function runUpload(initial: LessonProcessingJob) {
      let current = initial;
      try {
        current = await setUploadPhase(current, "uploading", "Uploading sources");
        const files = filesRef.current.get(current.id);
        for (let index = 0; index < current.sources.length; index += 1) {
          const source = current.sources[index];
          if (isSourceStored(current, source)) continue;
          const file = files?.get(source.id);
          if (!file) {
            await setUploadPhase(current, "needs-source", "Needs sources");
            logUploadAdvance(current.id);
            return;
          }
          const uploadingSources = [...current.sources];
          uploadingSources[index] = {
            ...source,
            storageStatus: "uploading",
            storageError: undefined,
          };
          current = { ...current, sources: uploadingSources, updatedAt: new Date().toISOString() };
          await publish(current);
          const queuedUpload = await createQueuedSourceUpload(
            file,
            uploadingSources[index],
            current.lessonId,
            current.ownerId!,
          );
          uploadAbortRef.current.set(current.id, () => void queuedUpload.abort());
          try {
            const storagePath = await queuedUpload.promise;
            uploadAbortRef.current.delete(current.id);
            const storedSources = [...current.sources];
            storedSources[index] = {
              ...storedSources[index],
              storagePath,
              storageStatus: "stored",
              storageError: undefined,
            };
            current = { ...current, sources: storedSources, updatedAt: new Date().toISOString() };
            await publish(current);
          } catch (error) {
            uploadAbortRef.current.delete(current.id);
            const failedSources = [...current.sources];
            failedSources[index] = {
              ...failedSources[index],
              storageStatus: "error",
              storageError: "Source upload failed.",
            };
            current = { ...current, sources: failedSources, updatedAt: new Date().toISOString() };
            throw error;
          }
        }
        filesRef.current.delete(current.id);
        current = await setUploadPhase(current, "queued", "Queued");
        debugRef.current(`Job fully staged: job=${current.id}`);
        debugRef.current(`Upload worker completed: job=${current.id}, sourcesStored=${current.sources.length}`);
        logUploadAdvance(current.id);
      } catch (error) {
        if (discardedRef.current.has(current.id)) return;
        const normalized = normalizeFailure(error, "uploading");
        await publish({
          ...current,
          status: "error",
          phase: "Error",
          error: normalized,
          updatedAt: new Date().toISOString(),
        });
        logUploadAdvance(current.id);
      } finally {
        uploadAbortRef.current.delete(current.id);
      }
    }

    async function setUploadPhase(
      current: LessonProcessingJob,
      status: LessonProcessingJob["status"],
      phase: string,
    ) {
      const next = { ...current, status, phase, error: undefined, updatedAt: new Date().toISOString() };
      await publish(next);
      return next;
    }

    function logUploadAdvance(fromId: string) {
      const next = jobs.find((item) =>
        item.id !== fromId && item.ownerId === ownerId && item.ownerId !== null &&
        item.status === "queued" && !areSourcesStored(item)
      );
      if (next) debugRef.current(`Upload worker advanced: from=${fromId}, to=${next.id}`);
    }
  }, [hydrated, jobs, ownerId]);

  useEffect(() => {
    if (!hydrated || processingRunningRef.current) return;
    const job = jobs.find((item) =>
      item.status === "queued" && item.ownerId === ownerId &&
      (item.ownerId ? areSourcesStored(item) : filesRef.current.has(item.id))
    );
    if (!job) {
      const waiting = jobs.find((item) =>
        item.status === "queued" && item.ownerId === ownerId && item.ownerId !== null &&
        !areSourcesStored(item)
      );
      if (waiting && processingWaitLogRef.current !== waiting.id) {
        processingWaitLogRef.current = waiting.id;
        debugRef.current(`Processing waiting: job=${waiting.id}, reason=sources-not-stored`);
      }
      return;
    }
    processingWaitLogRef.current = null;
    processingRunningRef.current = job.id;
    const epoch = ownerEpochRef.current;
    debugRef.current(`Processing worker started: job=${job.id}`);
    void runJob(job).finally(() => {
      if (ownerEpochRef.current === epoch && processingRunningRef.current === job.id) {
        processingRunningRef.current = null;
        setJobs((current) => [...current]);
      }
    });

    async function runJob(initial: LessonProcessingJob) {
      let current = initial;
      let processingTimeout: number | undefined;
      try {
        const existingLesson = await getSavedLesson(current.lessonId);
        if (existingLesson && existingLesson.sources.length === current.sources.length &&
            existingLesson.sources.every((source) => current.sources.some((item) => item.id === source.id))) {
          current = await setPhase(current, "saving", "Saving");
          if (discardedRef.current.has(current.id)) return;
          let recovered = existingLesson;
          if (current.ownerId) {
            recovered = await finalizeCloudLesson(existingLesson, current.ownerId, debugRef.current);
            await upsertStoredLessonSources(recovered, current.ownerId, debugRef.current);
          }
          current = await setPhase(current, "ready", "Ready");
          await readyRef.current(recovered.id);
          debugRef.current(`Processing lesson finalized: job=${current.id}, lesson=${current.lessonId}, activeLessonChanged=no`);
          return;
        }

        if (!current.ownerId && !filesRef.current.get(current.id)) {
          await setPhase(current, "needs-source", "Needs sources");
          return;
        }

        current = await setPhase(current, "processing", "Processing lesson");
        const controller = new AbortController();
        processingAbortRef.current.set(current.id, () => controller.abort());
        processingTimeout = window.setTimeout(() => controller.abort(), 315_000);
        const response = await (current.ownerId
          ? fetch("/api/lesson-sources", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lessonId: current.lessonId,
              sources: current.sources.map((source) => ({
                id: source.id,
                name: source.name,
                mimeType: source.mimeType,
                sizeBytes: source.sizeBytes,
                role: source.role,
                storagePath: source.storagePath,
              })),
            }),
            signal: controller.signal,
          })
          : fetchLocal(current, filesRef.current.get(current.id)!, controller.signal));
        window.clearTimeout(processingTimeout);
        processingTimeout = undefined;
        processingAbortRef.current.delete(current.id);
        const body: unknown = await response.json().catch(() => null);
        if (discardedRef.current.has(current.id)) return;
        if (!response.ok) {
          if (isSourceProcessingErrorResponse(body)) throw body;
          throw {
            code: "UNKNOWN" as const,
            retryable: response.status >= 500,
            message: "The lesson could not be processed.",
          };
        }
        const prepared = body as PreparedResponse;
        if (!prepared.structuredText?.trim() || !prepared.lessonTree?.length) {
          throw { code: "UNKNOWN" as const, retryable: false, message: "The model returned no usable lesson." };
        }
        current = await setPhase(current, "saving", "Saving");
        const lesson = buildLesson(current, prepared);
        await saveSavedLesson(lesson);
        let finalized = lesson;
        if (current.ownerId) {
          finalized = await finalizeCloudLesson(lesson, current.ownerId, debugRef.current);
          await upsertStoredLessonSources(finalized, current.ownerId, debugRef.current);
          await saveSavedLesson(finalized);
        }
        if (discardedRef.current.has(current.id)) return;
        current = await setPhase(current, "ready", "Ready");
        filesRef.current.delete(current.id);
        await readyRef.current(finalized.id);
        debugRef.current(`Processing lesson finalized: job=${current.id}, lesson=${current.lessonId}, activeLessonChanged=no`);
      } catch (error) {
        if (discardedRef.current.has(current.id)) return;
        const normalized = normalizeFailure(error, current.status);
        await publish({
          ...current,
          status: "error",
          phase: "Error",
          error: normalized,
          updatedAt: new Date().toISOString(),
        });
      } finally {
        if (processingTimeout) window.clearTimeout(processingTimeout);
        processingAbortRef.current.delete(current.id);
      }
    }

    async function setPhase(
      current: LessonProcessingJob,
      status: LessonProcessingJob["status"],
      phase: string,
    ) {
      const next = { ...current, status, phase, error: undefined, updatedAt: new Date().toISOString() };
      await publish(next);
      return next;
    }
  }, [hydrated, jobs, ownerId]);

  const retry = async (job: LessonProcessingJob) => {
    const missing = job.sources.some((source) => source.storageStatus !== "stored" || !source.storagePath);
    if (missing && !filesRef.current.get(job.id)) {
      await publish({
        ...job,
        status: "needs-source",
        phase: "Needs sources",
        error: undefined,
        updatedAt: new Date().toISOString(),
        generation: job.generation + 1,
      });
      return;
    }
    await publish({
      ...job,
      status: "queued",
      phase: "Queued",
      error: undefined,
      updatedAt: new Date().toISOString(),
      generation: job.generation + 1,
    });
  };

  const reselect = async (job: LessonProcessingJob, files: File[]) => {
    const unmatched = [...files];
    const mapped = new Map<string, File>();
    for (const source of job.sources.filter(
      (item) => item.storageStatus !== "stored" || !item.storagePath,
    )) {
      const index = unmatched.findIndex((file) =>
        file.name === source.name && file.type === source.mimeType && file.size === source.sizeBytes
      );
      if (index < 0) throw new Error(`Reselect ${source.name} with the same file.`);
      mapped.set(source.id, unmatched.splice(index, 1)[0]);
    }
    if (unmatched.length) throw new Error("Select only the exact sources requested by this job.");
    filesRef.current.set(job.id, mapped);
    await retry(job);
  };

  const discard = async (job: LessonProcessingJob) => {
    discardedRef.current.add(job.id);
    uploadAbortRef.current.get(job.id)?.();
    processingAbortRef.current.get(job.id)?.();
    uploadAbortRef.current.delete(job.id);
    processingAbortRef.current.delete(job.id);
    if (job.ownerId && job.status !== "ready") {
      try {
        await deleteCloudLesson(job.lessonId, job.ownerId);
      } catch {
        // A pre-lesson job normally has no public.lessons row yet.
      }
      await deletePreLessonSourceObjects(
        job.sources.flatMap((source) => source.storagePath ? [source.storagePath] : []),
        job.ownerId,
      );
    }
    if (job.status !== "ready") await deleteSavedLesson(job.lessonId);
    filesRef.current.delete(job.id);
    await deleteProcessingJob(job.id);
    setJobs((current) => current.filter((item) => item.id !== job.id));
  };

  return {
    jobs: jobs.filter((job) => job.ownerId === ownerId),
    hydrated,
    enqueue,
    retry,
    reselect,
    discard,
  };
}

function areSourcesStored(job: LessonProcessingJob) {
  return job.ownerId !== null && job.sources.every((source) => isSourceStored(job, source));
}

function isSourceStored(job: LessonProcessingJob, source: LessonSource) {
  if (!job.ownerId || source.storageStatus !== "stored" || !source.storagePath) return false;
  const segments = source.storagePath.split("/");
  return segments.length === 4 && segments[0] === job.ownerId &&
    segments[1] === job.lessonId && segments[2] === source.id && Boolean(segments[3]);
}

async function fetchLocal(job: LessonProcessingJob, files: Map<string, File>, signal: AbortSignal) {
  const form = new FormData();
  form.append("metadata", JSON.stringify(job.sources));
  for (const source of job.sources) {
    const file = files.get(source.id);
    if (!file) throw new Error("Source file required");
    form.append("sources", file, file.name);
  }
  return fetch("/api/lesson-sources", { method: "POST", body: form, signal });
}

function buildLesson(job: LessonProcessingJob, prepared: PreparedResponse): SavedLesson {
  const title = prepared.lessonTitle?.trim() || job.title;
  const tree = prepared.lessonTree!;
  const now = new Date().toISOString();
  return {
    schemaVersion: SAVED_LESSON_SCHEMA_VERSION,
    id: job.lessonId,
    title,
    lessonFocus: "",
    hasStarted: false,
    source: {
      metadata: {
        name: title,
        mimeType: job.sources[0].mimeType,
        sizeBytes: job.sources.reduce((sum, source) => sum + source.sizeBytes, 0),
        status: "ready",
      },
      prepared: {
        name: title,
        mimeType: job.sources[0].mimeType,
        text: prepared.structuredText!,
        lessonTree: tree,
      },
    },
    sources: job.sources,
    lessonState: createLessonState(`Main topics in ${title}`, tree),
    recentTeachingContext: [],
    teachingPreferences: DEFAULT_TEACHING_PREFERENCES,
    createdAt: job.createdAt,
    updatedAt: now,
    cloudOwnerId: job.ownerId,
  };
}

function normalizeFailure(
  error: unknown,
  status: LessonProcessingJob["status"],
): NonNullable<LessonProcessingJob["error"]> {
  if (status === "uploading") {
    return { category: "UPLOAD_FAILED", message: error instanceof Error ? error.message : "Source upload failed.", retryable: true };
  }
  if (status === "saving") {
    return { category: "SAVE_FAILED", message: error instanceof Error ? error.message : "Lesson finalization failed.", retryable: true };
  }
  if (isSourceProcessingErrorResponse(error)) {
    return { category: error.code, message: error.message, retryable: error.retryable };
  }
  const aborted = error instanceof DOMException && error.name === "AbortError";
  return {
    category: (aborted ? "PROCESSING_TIMEOUT" : "UNKNOWN") as SourceProcessingErrorCode,
    message: aborted ? "Processing was interrupted." : error instanceof Error ? error.message : "Processing failed.",
    retryable: true,
  };
}
