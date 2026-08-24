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

export type PreparedLearningSource = {
  name: string;
  mimeType: SupportedSourceType;
  text: string;
};
