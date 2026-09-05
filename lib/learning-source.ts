export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_SOURCE_BUNDLE_BYTES = 4 * 1024 * 1024;
export const MAX_LESSON_SOURCES = 6;
export const SUPPORTED_SOURCE_TYPES = ["application/pdf", "text/plain"] as const;

export type SupportedSourceType = (typeof SUPPORTED_SOURCE_TYPES)[number];
export type LearningSourceStatus = "preparing" | "processing" | "ready" | "error";
export type LessonSourceRole = "slides" | "transcript" | "notes" | "other";
export type SourceStorageStatus = "local" | "uploading" | "stored" | "error";

export type LessonSource = {
  id: string;
  name: string;
  mimeType: SupportedSourceType;
  sizeBytes: number;
  role: LessonSourceRole;
  storagePath?: string | null;
  storageStatus?: SourceStorageStatus;
  storageError?: string;
};

export type SourceReference = {
  sourceId: string;
  /** One-based human/PDF page index. TXT references omit this field. */
  page?: number;
  section?: string;
};

export type LearningSource = {
  name: string;
  mimeType: SupportedSourceType | string;
  sizeBytes: number;
  status: LearningSourceStatus;
  error?: string;
};

export type TeachingNodeType =
  | "overview"
  | "concept"
  | "definition"
  | "procedure"
  | "worked-example"
  | "comparison"
  | "summary";

export type TeachingImportance = "core" | "supporting" | "optional";

export type AtomicTeachingContract = {
  objective: string;
  teachingPoints: string[];
  completionCriteria: string[];
  type: TeachingNodeType;
  importance: TeachingImportance;
  sourceReferences?: SourceReference[];
  keyTerms?: string[];
  notation?: string[];
  sourceConfidence?: "clear" | "uncertain";
  uncertaintyNote?: string;
};

export type LessonTreeItem = {
  id: string;
  title: string;
  parentId: string | null;
  order: number;
  sourceReferences?: SourceReference[];
  teaching?: AtomicTeachingContract;
};

export type PreparedLearningSource = {
  name: string;
  mimeType: SupportedSourceType;
  text: string;
  lessonTree: LessonTreeItem[];
};
