export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_SOURCE_TYPES = ["application/pdf", "text/plain"] as const;

export type SupportedSourceType = (typeof SUPPORTED_SOURCE_TYPES)[number];
export type LearningSourceStatus = "preparing" | "processing" | "ready" | "error";

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
  sourceReferences?: string[];
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
  sourceReference?: string;
  teaching?: AtomicTeachingContract;
};

export type PreparedLearningSource = {
  name: string;
  mimeType: SupportedSourceType;
  text: string;
  lessonTree: LessonTreeItem[];
};
