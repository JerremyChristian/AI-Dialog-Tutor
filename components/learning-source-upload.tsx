"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  MAX_SOURCE_BYTES,
  SUPPORTED_SOURCE_TYPES,
  type LearningSource,
  type LessonTreeItem,
  type PreparedLearningSource,
  type SupportedSourceType,
} from "../lib/learning-source";
import {
  isSourceProcessingErrorResponse,
  type SourceProcessingErrorCode,
} from "../lib/source-processing-error";

type Props = {
  source: LearningSource | null;
  disabled: boolean;
  onChange: (source: LearningSource | null) => void;
  onPreparedChange: (source: PreparedLearningSource | null) => void;
  onDebug: (message: string) => void;
};

type PdfSourceResponse = {
  structuredText?: string;
  lessonTree?: LessonTreeItem[];
  model?: string;
  error?: string;
};

type PdfProcessingFailure = {
  code: SourceProcessingErrorCode;
  retryable: boolean;
  message: string;
};

const PDF_CLIENT_TIMEOUT_MS = 315_000;

function formatFileSize(sizeBytes: number) {
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function getResponseError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

async function getPdfResponseFailure(response: Response): Promise<PdfProcessingFailure> {
  try {
    const body: unknown = await response.json();
    if (isSourceProcessingErrorResponse(body)) return body;
  } catch {
    // Fall through to a status-based response when the server body is unavailable.
  }
  if (response.status === 503) {
    return {
      code: "TEMPORARY_UNAVAILABLE",
      retryable: true,
      message: "Gemini is temporarily busy and could not process this source yet.",
    };
  }
  if (response.status === 504) {
    return {
      code: "PROCESSING_TIMEOUT",
      retryable: true,
      message: "PDF processing took longer than expected.",
    };
  }
  return { code: "UNKNOWN", retryable: false, message: "The PDF could not be processed." };
}

async function validatePdfSignature(file: File) {
  const signature = new TextDecoder("ascii").decode(
    await file.slice(0, 5).arrayBuffer(),
  );
  if (signature !== "%PDF-") throw new Error("The selected file is not a valid PDF");
}

async function decodeText(file: File) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    await file.arrayBuffer(),
  );
}

export function LearningSourceUpload({
  source,
  disabled,
  onChange,
  onPreparedChange,
  onDebug,
}: Props) {
  const operationRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const selectedFileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pdfFailure, setPdfFailure] = useState<PdfProcessingFailure | null>(null);
  const [retryingPdf, setRetryingPdf] = useState(false);

  useEffect(() => {
    return () => {
      operationRef.current += 1;
      requestRef.current?.abort();
    };
  }, []);

  const setError = (
    file: File,
    mimeType: SupportedSourceType | string,
    message: string,
    failure: PdfProcessingFailure | null = null,
  ) => {
    setPdfFailure(failure);
    setRetryingPdf(false);
    onChange({
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      status: "error",
      error: message,
    });
    onDebug(`Source error: ${message}`);
  };

  const processPdf = async (file: File, operation: number, manualRetry: boolean) => {
    setPdfFailure(null);
    setRetryingPdf(manualRetry);
    onChange({
      name: file.name,
      mimeType: "application/pdf",
      sizeBytes: file.size,
      status: "processing",
    });
    if (manualRetry) onDebug("PDF preprocessing manual retry started");
    else onDebug("PDF preprocessing started");
    onDebug("PDF sent to document model");

    for (let attempt = 1; attempt <= 1; attempt += 1) {
      if (operation !== operationRef.current) return;
      onDebug(`PDF preprocessing attempt started: attempt=${attempt}`);
      const controller = new AbortController();
      requestRef.current = controller;
      const formData = new FormData();
      formData.append("source", file);
      let clientTimedOut = false;
      const timeout = window.setTimeout(() => {
        clientTimedOut = true;
        controller.abort();
      }, PDF_CLIENT_TIMEOUT_MS);

      try {
        const response = await fetch("/api/pdf-source", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        if (!response.ok) throw await getPdfResponseFailure(response);

        const body = (await response.json()) as PdfSourceResponse;
        if (!body.structuredText?.trim() || !body.lessonTree?.length) {
          throw {
            code: "UNKNOWN",
            retryable: false,
            message: "The document model returned an empty source representation.",
          } satisfies PdfProcessingFailure;
        }
        if (operation !== operationRef.current) return;

        onPreparedChange({
          name: file.name,
          mimeType: "application/pdf",
          text: body.structuredText,
          lessonTree: body.lessonTree,
        });
        onChange({
          name: file.name,
          mimeType: "application/pdf",
          sizeBytes: file.size,
          status: "ready",
        });
        setPdfFailure(null);
        setRetryingPdf(false);
        onDebug(
          `PDF preprocessing completed: model=${body.model || "server-selected"}, ` +
          `attempt=${attempt}`,
        );
        onDebug("Structured source ready");
        return;
      } catch (error) {
        if (operation !== operationRef.current) return;
        const failure: PdfProcessingFailure = clientTimedOut
          ? {
              code: "PROCESSING_TIMEOUT",
              retryable: true,
              message: "PDF processing took longer than expected.",
            }
          : error && typeof error === "object" &&
              "code" in error && "retryable" in error && "message" in error
            ? error as PdfProcessingFailure
            : {
                code: "TEMPORARY_UNAVAILABLE",
                retryable: true,
                message: "A temporary network error interrupted PDF processing.",
              };
        const failureType = failure.code.toLowerCase().replaceAll("_", "-");
        onDebug(
          failure.retryable
            ? `PDF preprocessing transient failure: type=${failureType}, attempt=${attempt}`
            : `PDF preprocessing non-retryable failure: type=${failureType}, attempt=${attempt}`,
        );
        onDebug(
          `PDF preprocessing failed: type=${failureType}, ` +
          `retryable=${failure.retryable ? "yes" : "no"}`,
        );
        setError(file, "application/pdf", failure.message, failure);
        return;
      } finally {
        window.clearTimeout(timeout);
        if (requestRef.current === controller) requestRef.current = null;
      }
    }
  };

  const selectSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const operation = ++operationRef.current;
    requestRef.current?.abort();
    requestRef.current = null;
    selectedFileRef.current = file;
    setPdfFailure(null);
    setRetryingPdf(false);
    onPreparedChange(null);
    if (source) onDebug("Source removed");
    onDebug(`Source selected: ${file.name}`);

    if (
      !SUPPORTED_SOURCE_TYPES.includes(
        file.type as (typeof SUPPORTED_SOURCE_TYPES)[number],
      )
    ) {
      setError(
        file,
        file.type || "Unknown",
        "Unsupported file type. Choose a PDF or plain text file.",
      );
      selectedFileRef.current = null;
      return;
    }

    if (file.size === 0 || file.size > MAX_SOURCE_BYTES) {
      const message =
        file.size === 0
          ? "The selected file is empty"
          : "The selected file exceeds the 20 MB proof-of-concept limit";
      setError(file, file.type, message);
      selectedFileRef.current = null;
      if (file.size > MAX_SOURCE_BYTES) onDebug("Source too large");
      return;
    }

    const mimeType = file.type as SupportedSourceType;
    onDebug("Source validation passed");
    onChange({
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      status: "preparing",
    });

    try {
      if (mimeType === "text/plain") {
        const text = await decodeText(file);
        if (!text.trim()) throw new Error("The selected text source is empty");
        if (operation !== operationRef.current) return;

        onChange({
          name: file.name,
          mimeType,
          sizeBytes: file.size,
          status: "processing",
        });
        onDebug("TXT outline extraction started");
        const controller = new AbortController();
        requestRef.current = controller;
        const formData = new FormData();
        formData.append("source", file);
        const response = await fetch("/api/text-outline", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(await getResponseError(response, "TXT outline extraction failed"));
        }
        const body = (await response.json()) as { lessonTree?: LessonTreeItem[] };
        if (!body.lessonTree?.length) throw new Error("TXT lesson tree is empty");
        if (operation !== operationRef.current) return;

        onPreparedChange({
          name: file.name,
          mimeType,
          text,
          lessonTree: body.lessonTree,
        });
        onChange({
          name: file.name,
          mimeType,
          sizeBytes: file.size,
          status: "ready",
        });
        onDebug("TXT source ready");
        return;
      }

      await validatePdfSignature(file);
      if (operation !== operationRef.current) return;

      await processPdf(file, operation, false);
    } catch (error) {
      if (operation !== operationRef.current) return;
      const message =
        error instanceof Error ? error.message : "Source preparation failed";
      setError(file, mimeType, message);
    } finally {
      if (operation === operationRef.current) requestRef.current = null;
    }
  };

  const retryPdf = () => {
    const file = selectedFileRef.current;
    if (!file || file.type !== "application/pdf" || !pdfFailure?.retryable) return;
    const operation = ++operationRef.current;
    requestRef.current?.abort();
    requestRef.current = null;
    void processPdf(file, operation, true);
  };

  const removeSource = () => {
    operationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    selectedFileRef.current = null;
    setPdfFailure(null);
    setRetryingPdf(false);
    if (inputRef.current) inputRef.current.value = "";
    onPreparedChange(null);
    onChange(null);
    onDebug("Source removed");
  };

  return (
    <section className="source-upload" aria-labelledby="source-upload-title">
      <div className="source-upload-heading">
        <div>
          <h2 id="source-upload-title">Learning Material</h2>
          <p>Select one PDF or plain text source, up to 20 MB.</p>
        </div>
        <span className={`source-status source-status-${source?.status || "none"}`}>
          {source
            ? source.status.charAt(0).toUpperCase() + source.status.slice(1)
            : "No material"}
        </span>
      </div>

      <input
        ref={inputRef}
        className="source-file-input"
        type="file"
        accept="application/pdf,text/plain,.pdf,.txt"
        onChange={selectSource}
        disabled={disabled}
      />

      {source && (
        <div className="source-details">
          <div>
            <strong>{source.name}</strong>
            <small>
              {source.mimeType} - {formatFileSize(source.sizeBytes)}
            </small>
            {source.error && (
              <p className="source-error" role="alert">
                {source.error}
              </p>
            )}
            {source.status === "processing" && retryingPdf && (
              <p className="source-processing" role="status">
                Retrying PDF processing…
              </p>
            )}
          </div>
          <div className="source-actions">
            {source.status === "error" && pdfFailure?.retryable && (
              <button
                className="source-retry"
                type="button"
                onClick={retryPdf}
                disabled={disabled}
              >
                Retry
              </button>
            )}
            <button
              className="source-remove"
              type="button"
              onClick={removeSource}
              disabled={disabled}
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
