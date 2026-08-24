"use client";

import { useEffect, useRef, type ChangeEvent } from "react";
import {
  MAX_SOURCE_BYTES,
  SUPPORTED_SOURCE_TYPES,
  type LearningSource,
  type PreparedLearningSource,
  type SupportedSourceType,
} from "../lib/learning-source";

type Props = {
  source: LearningSource | null;
  disabled: boolean;
  onChange: (source: LearningSource | null) => void;
  onPreparedChange: (source: PreparedLearningSource | null) => void;
  onDebug: (message: string) => void;
};

type PdfSourceResponse = {
  structuredText?: string;
  error?: string;
};

const PDF_CLIENT_TIMEOUT_MS = 135_000;

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
  const inputRef = useRef<HTMLInputElement | null>(null);

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
  ) => {
    onPreparedChange(null);
    onChange({
      name: file.name,
      mimeType,
      sizeBytes: file.size,
      status: "error",
      error: message,
    });
    onDebug(`Source error: ${message}`);
  };

  const selectSource = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const operation = ++operationRef.current;
    requestRef.current?.abort();
    requestRef.current = null;
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
      return;
    }

    if (file.size === 0 || file.size > MAX_SOURCE_BYTES) {
      const message =
        file.size === 0
          ? "The selected file is empty"
          : "The selected file exceeds the 20 MB proof-of-concept limit";
      setError(file, file.type, message);
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

        onPreparedChange({ name: file.name, mimeType, text });
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

      onChange({
        name: file.name,
        mimeType,
        sizeBytes: file.size,
        status: "processing",
      });
      onDebug("PDF preprocessing started");
      onDebug("PDF sent to document model");

      const controller = new AbortController();
      requestRef.current = controller;
      const formData = new FormData();
      formData.append("source", file);
      const timeout = window.setTimeout(
        () => controller.abort(),
        PDF_CLIENT_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await fetch("/api/pdf-source", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted && operation === operationRef.current) {
          throw new Error(
            "PDF preprocessing timed out. Try again or use a smaller PDF.",
          );
        }
        throw error;
      } finally {
        window.clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new Error(
          await getResponseError(response, "PDF preprocessing failed"),
        );
      }

      const body = (await response.json()) as PdfSourceResponse;
      if (!body.structuredText?.trim()) {
        throw new Error("The document model returned an empty source representation");
      }
      if (operation !== operationRef.current) return;

      onPreparedChange({
        name: file.name,
        mimeType,
        text: body.structuredText,
      });
      onChange({
        name: file.name,
        mimeType,
        sizeBytes: file.size,
        status: "ready",
      });
      onDebug("PDF preprocessing completed");
      onDebug("Structured source ready");
    } catch (error) {
      if (operation !== operationRef.current) return;
      const message =
        error instanceof Error ? error.message : "Source preparation failed";
      setError(file, mimeType, message);
    } finally {
      if (operation === operationRef.current) requestRef.current = null;
    }
  };

  const removeSource = () => {
    operationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
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
          </div>
          <button
            className="source-remove"
            type="button"
            onClick={removeSource}
            disabled={disabled}
          >
            Remove
          </button>
        </div>
      )}
    </section>
  );
}
