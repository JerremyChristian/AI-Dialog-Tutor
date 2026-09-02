export type SourceProcessingErrorCode =
  | "QUOTA_EXHAUSTED"
  | "RATE_LIMITED"
  | "TEMPORARY_UNAVAILABLE"
  | "PROCESSING_TIMEOUT"
  | "INVALID_SOURCE"
  | "UNKNOWN";

export type SourceProcessingErrorResponse = {
  code: SourceProcessingErrorCode;
  retryable: boolean;
  message: string;
};

export function isSourceProcessingErrorResponse(
  value: unknown,
): value is SourceProcessingErrorResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.code === "QUOTA_EXHAUSTED" ||
      candidate.code === "RATE_LIMITED" ||
      candidate.code === "TEMPORARY_UNAVAILABLE" ||
      candidate.code === "PROCESSING_TIMEOUT" ||
      candidate.code === "INVALID_SOURCE" ||
      candidate.code === "UNKNOWN") &&
    typeof candidate.retryable === "boolean" &&
    typeof candidate.message === "string"
  );
}
