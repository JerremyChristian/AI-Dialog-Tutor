import type { LearningSource, LessonSource, PreparedLearningSource } from "./learning-source";
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
const LEGACY_ACTIVE_LESSON_KEY = "activeLessonId";
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
  sources: LessonSource[];
  lessonState: LessonState;
  recentTeachingContext: RecentTeachingContextEntry[];
  teachingPreferences: TeachingPreferences;
  createdAt: string;
  updatedAt: string;
  cloudOwnerId?: string | null;
  cloudSync?: CloudSyncMetadata;
};

export type CloudSyncMetadata = {
  lastSyncedLocalUpdatedAt: string;
  lastKnownCloudUpdatedAt: string;
};

export type RecentTeachingContextEntry = {
  conceptId: string;
  excerpt: string;
};

export function getSavedLessonContentSignature(lesson: SavedLesson): string {
  const content = structuredClone(lesson) as SavedLesson;
  delete content.cloudOwnerId;
  delete content.cloudSync;
  const withoutInfrastructure = content as unknown as Record<string, unknown>;
  delete withoutInfrastructure.createdAt;
  delete withoutInfrastructure.updatedAt;
  return canonicalStringify(withoutInfrastructure);
}

export type ActiveLessonLoadResult =
  | { status: "none"; lesson: null }
  | { status: "incompatible"; lesson: null }
  | { status: "restored"; lesson: SavedLesson };

export function saveActiveLesson(lesson: SavedLesson, ownerId = lesson.cloudOwnerId ?? null) {
  const write = () => writeActiveLesson(lesson, ownerId);
  mutationQueue = mutationQueue.then(write, write);
  return mutationQueue;
}

async function writeActiveLesson(lesson: SavedLesson, ownerId: string | null) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(
      [SAVED_LESSONS_STORE, APP_STATE_STORE],
      "readwrite",
    );
    transaction.objectStore(SAVED_LESSONS_STORE).put(lesson);
    transaction.objectStore(APP_STATE_STORE).put({
      key: activeLessonKey(ownerId),
      value: lesson.id,
    });
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function loadActiveLesson(ownerId: string | null = null): Promise<ActiveLessonLoadResult> {
  const database = await openTutorDatabase();
  try {
    const appState = database.transaction(APP_STATE_STORE, "readonly")
      .objectStore(APP_STATE_STORE);
    let pointer = await requestResult<{ key: string; value?: unknown } | undefined>(
      appState.get(activeLessonKey(ownerId)),
    );
    if (!ownerId && !pointer) {
      pointer = await requestResult<{ key: string; value?: unknown } | undefined>(
        database.transaction(APP_STATE_STORE, "readonly")
          .objectStore(APP_STATE_STORE)
          .get(LEGACY_ACTIVE_LESSON_KEY),
      );
    }
    if (typeof pointer?.value !== "string" || !pointer.value) {
      return { status: "none", lesson: null };
    }
    const candidate = await requestResult<unknown>(
      database.transaction(SAVED_LESSONS_STORE, "readonly")
        .objectStore(SAVED_LESSONS_STORE)
        .get(pointer.value),
    );
    const lesson = parseSavedLesson(candidate);
    if (lesson && (lesson.cloudOwnerId ?? null) !== ownerId) {
      return { status: "none", lesson: null };
    }
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

export function saveSavedLesson(lesson: SavedLesson) {
  const save = () => writeSavedLesson(lesson);
  mutationQueue = mutationQueue.then(save, save);
  return mutationQueue;
}

export function updateSavedLessonCloudSync(
  id: string,
  expectedUpdatedAt: string,
  cloudSync: CloudSyncMetadata,
) {
  let result: SavedLesson | null = null;
  const update = async () => {
    result = await writeSavedLessonCloudSync(id, expectedUpdatedAt, cloudSync);
  };
  mutationQueue = mutationQueue.then(update, update);
  return mutationQueue.then(() => result);
}

async function writeSavedLessonCloudSync(
  id: string,
  expectedUpdatedAt: string,
  cloudSync: CloudSyncMetadata,
) {
  const database = await openTutorDatabase();
  let updated: SavedLesson | null = null;
  try {
    const transaction = database.transaction(SAVED_LESSONS_STORE, "readwrite");
    const store = transaction.objectStore(SAVED_LESSONS_STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      const current = parseSavedLesson(request.result);
      if (!current || current.updatedAt !== expectedUpdatedAt) return;
      updated = { ...current, cloudSync };
      store.put(updated);
    };
    await transactionComplete(transaction);
    return updated;
  } finally {
    database.close();
  }
}

async function writeSavedLesson(lesson: SavedLesson) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(SAVED_LESSONS_STORE, "readwrite");
    transaction.objectStore(SAVED_LESSONS_STORE).put(lesson);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export function setActiveLessonId(id: string, ownerId: string | null = null) {
  const set = () => writeActiveLessonId(id, ownerId);
  mutationQueue = mutationQueue.then(set, set);
  return mutationQueue;
}

async function writeActiveLessonId(id: string, ownerId: string | null) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(APP_STATE_STORE, "readwrite");
    transaction.objectStore(APP_STATE_STORE).put({ key: activeLessonKey(ownerId), value: id });
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
    lessons.delete(id);
    const pointerRequest = appState.openCursor();
    pointerRequest.onsuccess = () => {
      const cursor = pointerRequest.result;
      if (!cursor) return;
      const pointer = cursor.value as { value?: unknown };
      if (pointer.value === id) cursor.delete();
      cursor.continue();
    };
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export function clearActiveLessonId(ownerId: string | null = null) {
  const clear = () => deleteActiveLessonId(ownerId);
  mutationQueue = mutationQueue.then(clear, clear);
  return mutationQueue;
}

async function deleteActiveLessonId(ownerId: string | null) {
  const database = await openTutorDatabase();
  try {
    const transaction = database.transaction(APP_STATE_STORE, "readwrite");
    transaction.objectStore(APP_STATE_STORE).delete(activeLessonKey(ownerId));
    if (!ownerId) transaction.objectStore(APP_STATE_STORE).delete(LEGACY_ACTIVE_LESSON_KEY);
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

export function parseSavedLesson(value: unknown): SavedLesson | null {
  if (!isRecord(value) || value.schemaVersion !== SAVED_LESSON_SCHEMA_VERSION) return null;
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.title)) return null;
  if (typeof value.lessonFocus !== "string" || typeof value.hasStarted !== "boolean") return null;
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) return null;
  const source = parseSource(value.source);
  const sources = parseLessonSources(value.sources, value.id, source?.metadata);
  const lessonState = parseLessonState(value.lessonState);
  const recentTeachingContext = parseRecentTeachingContext(
    value.recentTeachingContext,
    lessonState?.nodes,
  );
  const teachingPreferences = parseTeachingPreferences(value.teachingPreferences);
  const cloudOwnerId = value.cloudOwnerId === undefined || value.cloudOwnerId === null
    ? null
    : isNonEmptyString(value.cloudOwnerId) ? value.cloudOwnerId : undefined;
  if (cloudOwnerId === undefined) return null;
  const cloudSync = parseCloudSyncMetadata(value.cloudSync);
  if (value.cloudSync !== undefined && !cloudSync) return null;
  if (!source || !sources || !lessonState || !recentTeachingContext || !teachingPreferences) return null;
  normalizeLegacySourceReferences(source.prepared, sources[0].id);
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
    sources,
    lessonState,
    recentTeachingContext,
    teachingPreferences,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    cloudOwnerId,
    ...(cloudSync ? { cloudSync } : {}),
  };
}

function normalizeLegacySourceReferences(prepared: PreparedLearningSource, sourceId: string) {
  for (const node of prepared.lessonTree) {
    const legacyNode = node as typeof node & { sourceReference?: unknown };
    if (!node.sourceReferences && typeof legacyNode.sourceReference === "string") {
      node.sourceReferences = [legacyReference(legacyNode.sourceReference, sourceId)];
    }
    const references = node.teaching?.sourceReferences as unknown;
    if (node.teaching && Array.isArray(references)) {
      node.teaching.sourceReferences = references.flatMap((reference) =>
        typeof reference === "string" ? [legacyReference(reference, sourceId)] :
          isRecord(reference) && typeof reference.sourceId === "string" ? [{
            sourceId: reference.sourceId,
            ...(typeof reference.page === "number" && Number.isInteger(reference.page) && reference.page > 0 ? { page: reference.page } : {}),
            ...(typeof reference.section === "string" ? { section: reference.section } : {}),
          }] : []
      );
    }
  }
}

function legacyReference(value: string, sourceId: string) {
  const page = value.match(/(?:page|slide)\s*(\d+)/i)?.[1];
  return { sourceId, ...(page ? { page: Number(page) } : {}), section: value.slice(0, 200) };
}

function parseLessonSources(
  value: unknown,
  lessonId: string,
  legacy: LearningSource | undefined,
): LessonSource[] | null {
  // Schema-1 lessons before M6.6 carried only source.metadata.
  if (value === undefined && legacy) return [{
    id: legacySourceId(lessonId),
    name: legacy.name,
    mimeType: legacy.mimeType as LessonSource["mimeType"],
    sizeBytes: legacy.sizeBytes,
    role: "other",
    storageStatus: "local",
  }];
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return null;
  const parsed: LessonSource[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isUuid(item.id) || !isNonEmptyString(item.name) || item.name.length > 200 ||
        (item.mimeType !== "application/pdf" && item.mimeType !== "text/plain") ||
        typeof item.sizeBytes !== "number" || !Number.isInteger(item.sizeBytes) || item.sizeBytes < 0 ||
        (item.role !== "slides" && item.role !== "transcript" && item.role !== "notes" && item.role !== "other") ||
        (item.storageStatus !== undefined && item.storageStatus !== "local" && item.storageStatus !== "uploading" && item.storageStatus !== "stored" && item.storageStatus !== "error")) return null;
    const storagePath = item.storagePath === undefined || item.storagePath === null ? null : typeof item.storagePath === "string" ? item.storagePath : undefined;
    if (storagePath === undefined || (item.storageStatus === "stored" && !storagePath)) return null;
    if (storagePath) {
      const segments = storagePath.split("/");
      if (segments.length !== 4 || segments[1] !== lessonId || segments[2] !== item.id) return null;
    }
    parsed.push({ id: item.id, name: item.name, mimeType: item.mimeType, sizeBytes: item.sizeBytes, role: item.role,
      storagePath, storageStatus: item.storageStatus ?? (storagePath ? "stored" : "local"),
      ...(typeof item.storageError === "string" ? { storageError: item.storageError.slice(0, 300) } : {}),
    });
  }
  return parsed;
}

function legacySourceId(lessonId: string) {
  let hash = 2166136261;
  for (const character of lessonId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  const tail = Math.abs(hash >>> 0).toString(16).padStart(8, "0");
  return `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseCloudSyncMetadata(value: unknown): CloudSyncMetadata | null {
  if (!isRecord(value) || !isIsoDate(value.lastSyncedLocalUpdatedAt) ||
      !isIsoDate(value.lastKnownCloudUpdatedAt)) return null;
  return {
    lastSyncedLocalUpdatedAt: value.lastSyncedLocalUpdatedAt,
    lastKnownCloudUpdatedAt: value.lastKnownCloudUpdatedAt,
  };
}

function activeLessonKey(ownerId: string | null) {
  return ownerId ? `activeLessonId:user:${ownerId}` : "activeLessonId:anonymous";
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

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) =>
    canonicalStringify(item === undefined ? null : item)
  ).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalStringify(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
