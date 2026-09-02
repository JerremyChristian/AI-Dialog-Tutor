import type { LearningSource, PreparedLearningSource } from "./learning-source";
import {
  normalizeTeachingContractProgress,
  type CoverageStatus,
  type LessonState,
  type LessonStatus,
} from "./lesson-state";
import {
  parseTeachingPreferences,
  type TeachingPreferences,
} from "./teaching-preferences";

export const SAVED_LESSON_SCHEMA_VERSION = 1 as const;
export const TUTOR_DATABASE_NAME = "ai-dialog-tutor";
export const TUTOR_DATABASE_VERSION = 1;
export const MAX_RECENT_TEACHING_CONTEXT_ENTRIES = 3;
export const MAX_RECENT_TEACHING_EXCERPT_LENGTH = 360;

const SAVED_LESSONS_STORE = "savedLessons";
const APP_STATE_STORE = "appState";
const ACTIVE_LESSON_KEY = "activeLessonId";
let mutationQueue: Promise<void> = Promise.resolve();
const COVERAGE_STATUSES = new Set<CoverageStatus>([
  "not-started",
  "teaching",
  "partial",
  "taught",
  "skipped",
]);
const LESSON_STATUSES = new Set<LessonStatus>([
  "idle",
  "teaching",
  "interrupted",
  "resolving-interruption",
  "resuming",
  "completed",
]);

export type SavedLesson = {
  schemaVersion: typeof SAVED_LESSON_SCHEMA_VERSION;
  id: string;
  title: string;
  lessonFocus: string;
  hasStarted: boolean;
  source: {
    metadata: LearningSource;
    prepared: PreparedLearningSource;
  };
  lessonState: LessonState;
  recentTeachingContext: RecentTeachingContextEntry[];
  teachingPreferences: TeachingPreferences;
  createdAt: string;
  updatedAt: string;
};

export type RecentTeachingContextEntry = {
  conceptId: string;
  excerpt: string;
};

export type ActiveLessonLoadResult =
  | { status: "none"; lesson: null }
  | { status: "incompatible"; lesson: null }
  | { status: "restored"; lesson: SavedLesson };

export function saveActiveLesson(lesson: SavedLesson) {
  const write = () => writeActiveLesson(lesson);
  mutationQueue = mutationQueue.then(write, write);
  return mutationQueue;
}

async function writeActiveLesson(lesson: SavedLesson) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(
      [SAVED_LESSONS_STORE, APP_STATE_STORE],
      "readwrite",
    );
    transaction.objectStore(SAVED_LESSONS_STORE).put(lesson);
    transaction.objectStore(APP_STATE_STORE).put({
      key: ACTIVE_LESSON_KEY,
      value: lesson.id,
    });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function loadActiveLesson(): Promise<ActiveLessonLoadResult> {
  const database = await openTutorDatabase();
  try {
    const pointer = await requestResult<{ key: string; value?: unknown } | undefined>(
      database.transaction(APP_STATE_STORE, "readonly")
        .objectStore(APP_STATE_STORE)
        .get(ACTIVE_LESSON_KEY),
    );
    if (typeof pointer?.value !== "string" || !pointer.value) {
      return { status: "none", lesson: null };
    }
    const candidate = await requestResult<unknown>(
      database.transaction(SAVED_LESSONS_STORE, "readonly")
        .objectStore(SAVED_LESSONS_STORE)
        .get(pointer.value),
    );
    const lesson = parseSavedLesson(candidate);
    return lesson
      ? { status: "restored", lesson }
      : { status: "incompatible", lesson: null };
  } finally {
    database.close();
  }
}

export async function listSavedLessons(): Promise<SavedLesson[]> {
  const database = await openTutorDatabase();
  try {
    const candidates = await requestResult<unknown[]>(
      database.transaction(SAVED_LESSONS_STORE, "readonly")
        .objectStore(SAVED_LESSONS_STORE)
        .index("updatedAt")
        .getAll(),
    );
    return candidates
      .map(parseSavedLesson)
      .filter((lesson): lesson is SavedLesson => lesson !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } finally {
    database.close();
  }
}

export async function getSavedLesson(id: string): Promise<SavedLesson | null> {
  const database = await openTutorDatabase();
  try {
    const candidate = await requestResult<unknown>(
      database.transaction(SAVED_LESSONS_STORE, "readonly")
        .objectStore(SAVED_LESSONS_STORE)
        .get(id),
    );
    return parseSavedLesson(candidate);
  } finally {
    database.close();
  }
}

export function setActiveLessonId(id: string) {
  const set = () => writeActiveLessonId(id);
  mutationQueue = mutationQueue.then(set, set);
  return mutationQueue;
}

async function writeActiveLessonId(id: string) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(APP_STATE_STORE, "readwrite");
    transaction.objectStore(APP_STATE_STORE).put({ key: ACTIVE_LESSON_KEY, value: id });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export function deleteSavedLesson(id: string) {
  const remove = () => deleteSavedLessonRecord(id);
  mutationQueue = mutationQueue.then(remove, remove);
  return mutationQueue;
}

async function deleteSavedLessonRecord(id: string) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(
      [SAVED_LESSONS_STORE, APP_STATE_STORE],
      "readwrite",
    );
    const lessons = transaction.objectStore(SAVED_LESSONS_STORE);
    const appState = transaction.objectStore(APP_STATE_STORE);
    const pointerRequest = appState.get(ACTIVE_LESSON_KEY);
    pointerRequest.onsuccess = () => {
      lessons.delete(id);
      const pointer = pointerRequest.result as { value?: unknown } | undefined;
      if (pointer?.value === id) appState.delete(ACTIVE_LESSON_KEY);
    };
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export function clearActiveLessonId() {
  const clear = () => deleteActiveLessonId();
  mutationQueue = mutationQueue.then(clear, clear);
  return mutationQueue;
}

async function deleteActiveLessonId() {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(APP_STATE_STORE, "readwrite");
    transaction.objectStore(APP_STATE_STORE).delete(ACTIVE_LESSON_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

function openTutorDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(TUTOR_DATABASE_NAME, TUTOR_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SAVED_LESSONS_STORE)) {
        const lessons = database.createObjectStore(SAVED_LESSONS_STORE, { keyPath: "id" });
        lessons.createIndex("updatedAt", "updatedAt");
      }
      if (!database.objectStoreNames.contains(APP_STATE_STORE)) {
        database.createObjectStore(APP_STATE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function parseSavedLesson(value: unknown): SavedLesson | null {
  if (!isRecord(value) || value.schemaVersion !== SAVED_LESSON_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.title)) return null;
  if (typeof value.lessonFocus !== "string" || typeof value.hasStarted !== "boolean") return null;
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) return null;
  const source = parseSource(value.source);
  const lessonState = parseLessonState(value.lessonState);
  const recentTeachingContext = parseRecentTeachingContext(
    value.recentTeachingContext,
    lessonState?.nodes,
  );
  const teachingPreferences = parseTeachingPreferences(value.teachingPreferences);
  if (!source || !lessonState || !recentTeachingContext || !teachingPreferences) return null;
  const sourceNodeIds = new Set(source.prepared.lessonTree.map((node) => node.id));
  const stateNodeIds = Object.keys(lessonState.nodes);
  if (sourceNodeIds.size !== stateNodeIds.length ||
      stateNodeIds.some((id) => !sourceNodeIds.has(id))) return null;
  return {
    schemaVersion: SAVED_LESSON_SCHEMA_VERSION,
    id: value.id,
    title: value.title,
    lessonFocus: value.lessonFocus,
    hasStarted: value.hasStarted,
    source,
    lessonState,
    recentTeachingContext,
    teachingPreferences,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseRecentTeachingContext(
  value: unknown,
  nodes: LessonState["nodes"] | undefined,
): RecentTeachingContextEntry[] | null {
  // This additive field is optional for schema-1 lessons saved before M6.3.
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RECENT_TEACHING_CONTEXT_ENTRIES || !nodes) {
    return null;
  }
  const entries: RecentTeachingContextEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.conceptId !== "string" ||
        !(entry.conceptId in nodes) || !isNonEmptyString(entry.excerpt) ||
        entry.excerpt.length > MAX_RECENT_TEACHING_EXCERPT_LENGTH) return null;
    entries.push({ conceptId: entry.conceptId, excerpt: entry.excerpt });
  }
  return entries;
}

function parseSource(value: unknown): SavedLesson["source"] | null {
  if (!isRecord(value) || !isRecord(value.metadata) || !isRecord(value.prepared)) return null;
  const metadata = value.metadata;
  const prepared = value.prepared;
  if (!isNonEmptyString(metadata.name) ||
      (metadata.mimeType !== "application/pdf" && metadata.mimeType !== "text/plain") ||
      typeof metadata.sizeBytes !== "number" || metadata.sizeBytes < 0 ||
      metadata.status !== "ready") return null;
  if (prepared.name !== metadata.name || prepared.mimeType !== metadata.mimeType ||
      !isNonEmptyString(prepared.text) || !Array.isArray(prepared.lessonTree) ||
      prepared.lessonTree.length === 0) return null;
  if (!prepared.lessonTree.every((node) =>
    isRecord(node) && isNonEmptyString(node.id) && isNonEmptyString(node.title) &&
    (node.parentId === null || typeof node.parentId === "string") &&
    typeof node.order === "number"
  )) return null;
  return value as SavedLesson["source"];
}

function parseLessonState(value: unknown): LessonState | null {
  if (!isRecord(value) || !isNonEmptyString(value.topic) ||
      typeof value.objective !== "string" ||
      !LESSON_STATUSES.has(value.status as LessonStatus) ||
      !Array.isArray(value.rootNodeIds) || !isRecord(value.nodes) ||
      (value.currentNodeId !== null && typeof value.currentNodeId !== "string") ||
      typeof value.resumePoint !== "string" || typeof value.interruptionCount !== "number" ||
      typeof value.lastUserTranscript !== "string" ||
      typeof value.lastAssistantTranscript !== "string") return null;
  const nodes = value.nodes;
  for (const [id, nodeValue] of Object.entries(nodes)) {
    if (!isRecord(nodeValue) || nodeValue.id !== id || !isNonEmptyString(nodeValue.title) ||
        (nodeValue.parentId !== null && typeof nodeValue.parentId !== "string") ||
        !Array.isArray(nodeValue.childrenIds) ||
        !nodeValue.childrenIds.every((childId) => typeof childId === "string" && childId in nodes) ||
        !COVERAGE_STATUSES.has(nodeValue.status as CoverageStatus)) return null;
    if (nodeValue.parentId && !(nodeValue.parentId in nodes)) return null;
  }
  if (!value.rootNodeIds.every((id) => typeof id === "string" && id in nodes)) return null;
  if (value.currentNodeId && !(value.currentNodeId in nodes)) return null;
  return {
    ...(value as Omit<LessonState, "teachingContractProgress">),
    teachingContractProgress: normalizeTeachingContractProgress(
      nodes as LessonState["nodes"],
      value.teachingContractProgress,
    ),
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
