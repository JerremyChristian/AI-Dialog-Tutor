import type { LessonSource } from "./learning-source";
import {
  PROCESSING_JOBS_STORE,
  openTutorDatabase,
  requestResult,
  transactionComplete,
} from "./local-persistence";
import type { SourceProcessingErrorCode } from "./source-processing-error";

export type ProcessingJobStatus =
  | "queued"
  | "uploading"
  | "processing"
  | "saving"
  | "ready"
  | "error"
  | "needs-source";

export type LessonProcessingJob = {
  id: string;
  lessonId: string;
  ownerId: string | null;
  title: string;
  sources: LessonSource[];
  status: ProcessingJobStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  error?: {
    category: SourceProcessingErrorCode | "UPLOAD_FAILED" | "SAVE_FAILED";
    message: string;
    retryable: boolean;
  };
  generation: number;
};

const STATUSES = new Set<ProcessingJobStatus>([
  "queued", "uploading", "processing", "saving", "ready", "error", "needs-source",
]);

export async function listProcessingJobs(ownerId: string | null) {
  const database = await openTutorDatabase();
  try {
    const values = await requestResult<unknown[]>(
      database.transaction(PROCESSING_JOBS_STORE, "readonly")
        .objectStore(PROCESSING_JOBS_STORE)
        .getAll(),
    );
    return values.flatMap((value) => {
      const parsed = parseProcessingJob(value);
      return parsed && parsed.ownerId === ownerId ? [parsed] : [];
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally {
    database.close();
  }
}

export async function saveProcessingJob(job: LessonProcessingJob) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(PROCESSING_JOBS_STORE, "readwrite");
    transaction.objectStore(PROCESSING_JOBS_STORE).put(job);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function deleteProcessingJob(id: string) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(PROCESSING_JOBS_STORE, "readwrite");
    transaction.objectStore(PROCESSING_JOBS_STORE).delete(id);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

function parseProcessingJob(value: unknown): LessonProcessingJob | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  if (!isUuid(job.id) || !isUuid(job.lessonId) ||
      !(job.ownerId === null || isUuid(job.ownerId)) || typeof job.title !== "string" ||
      !Array.isArray(job.sources) || !job.sources.length ||
      !STATUSES.has(job.status as ProcessingJobStatus) || typeof job.phase !== "string" ||
      !isDate(job.createdAt) || !isDate(job.updatedAt) ||
      typeof job.generation !== "number" || !Number.isInteger(job.generation)) return null;
  const sources = job.sources.flatMap((source): LessonSource[] => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const item = source as Record<string, unknown>;
    if (!isUuid(item.id) || typeof item.name !== "string" || !item.name ||
        (item.mimeType !== "application/pdf" && item.mimeType !== "text/plain") ||
        typeof item.sizeBytes !== "number" || !Number.isInteger(item.sizeBytes) || item.sizeBytes <= 0 ||
        (item.role !== "slides" && item.role !== "transcript" && item.role !== "notes" && item.role !== "other")) return [];
    return [item as LessonSource];
  });
  if (sources.length !== job.sources.length) return null;
  return { ...(job as LessonProcessingJob), sources };
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
