"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { AtomicTeachingContract, LessonSource } from "../lib/learning-source";
import { downloadCloudLessonSource, resolveCloudLessonSourcePath } from "../lib/cloud-sync";
import { selectBeatVisualReferences } from "../lib/source-visual";
import { deriveBeatSourceReferences } from "../lib/teaching-delivery";

type Props = {
  conceptId: string | null;
  conceptTitle?: string;
  contract?: AtomicTeachingContract;
  teachingPointIndexes: number[];
  presentationKey: string;
  sources: LessonSource[];
  lessonId: string | null;
  cloudOwnerId: string | null;
  authReady: boolean;
  onDebug: (message: string) => void;
};
type VisualStatus = "idle" | "resolving" | "downloading" | "rendering" | "ready" | "error" | "unavailable";
type AvailabilityReason =
  | "none"
  | "invalid-source-reference"
  | "missing-page-reference"
  | "waiting-for-auth"
  | "missing-cloud-context"
  | "cloud-source-not-found"
  | "metadata-lookup-failed"
  | "download-failed"
  | "empty-pdf-bytes"
  | "pdf-load-failed"
  | "pdf-module-import-timeout"
  | "pdf-load-timeout"
  | "pdf-loading-task-rejected"
  | "pdf-modern-and-legacy-load-failed"
  | "pdf-get-page-failed"
  | "pdf-render-failed"
  | "page-out-of-range"
  | "ready";
type MetadataLookupResult = "not-run" | "started" | "success" | "not-found" | "error";
type StorageDownloadResult = "not-run" | "started" | "success" | "error";
type PdfLoadResult = "not-run" | "started" | "success" | "error";
type SourceVisualDiagnostics = {
  metadataLookupResult: MetadataLookupResult;
  resolvedStoragePath: boolean;
  storageDownloadResult: StorageDownloadResult;
  pdfByteCount: number;
  pdfLoadResult: PdfLoadResult;
  pdfPageCount: number;
  pdfDataPrepared: boolean;
  pdfModuleImportStarted: boolean;
  pdfModuleImportResolved: boolean;
  workerConfigured: boolean;
  workerSrcKind: "local" | "unconfigured";
  pdfGetDocumentCalled: boolean;
  pdfLoadingTaskCreated: boolean;
  pdfLoadingTaskPromiseStarted: boolean;
  pdfLoadingTaskPromiseResolved: boolean;
  pdfLoadingTaskPromiseRejected: boolean;
  pdfDocumentLoaded: boolean;
  pdfGetPageStarted: boolean;
  pdfGetPageResolved: boolean;
  pdfRenderStarted: boolean;
  pdfRenderResolved: boolean;
  pdfRenderRejected: boolean;
  errorName: string;
  errorCategory: string;
  errorMessage: string;
  pdfLoaderAttempt: "modern" | "legacy";
  modernImportStarted: boolean;
  modernImportResolved: boolean;
  modernLoadingTaskStarted: boolean;
  modernLoadingTaskResolved: boolean;
  modernFailureReason: string;
  legacyFallbackTriggered: boolean;
  legacyImportStarted: boolean;
  legacyImportResolved: boolean;
  legacyWorkerConfigured: boolean;
  legacyWorkerSrcKind: "local" | "unconfigured";
  legacyGetDocumentCalled: boolean;
  legacyLoadingTaskCreated: boolean;
  legacyLoadingTaskPromiseStarted: boolean;
  legacyLoadingTaskPromiseResolved: boolean;
  legacyLoadingTaskPromiseRejected: boolean;
  legacyDocumentLoaded: boolean;
  successfulLoader: "modern" | "legacy" | "none";
  finalStatus: VisualStatus;
  reason: AvailabilityReason;
};

const SOURCE_VISUAL_DEBUG_STORAGE_KEY = "ai-dialog-tutor:debug-source-visual";
const PDF_LOAD_TIMEOUT_MS = 15_000;
const INITIAL_DIAGNOSTICS: SourceVisualDiagnostics = {
  metadataLookupResult: "not-run",
  resolvedStoragePath: false,
  storageDownloadResult: "not-run",
  pdfByteCount: 0,
  pdfLoadResult: "not-run",
  pdfPageCount: 0,
  pdfDataPrepared: false,
  pdfModuleImportStarted: false,
  pdfModuleImportResolved: false,
  workerConfigured: false,
  workerSrcKind: "unconfigured",
  pdfGetDocumentCalled: false,
  pdfLoadingTaskCreated: false,
  pdfLoadingTaskPromiseStarted: false,
  pdfLoadingTaskPromiseResolved: false,
  pdfLoadingTaskPromiseRejected: false,
  pdfDocumentLoaded: false,
  pdfGetPageStarted: false,
  pdfGetPageResolved: false,
  pdfRenderStarted: false,
  pdfRenderResolved: false,
  pdfRenderRejected: false,
  errorName: "none",
  errorCategory: "none",
  errorMessage: "none",
  pdfLoaderAttempt: "modern",
  modernImportStarted: false,
  modernImportResolved: false,
  modernLoadingTaskStarted: false,
  modernLoadingTaskResolved: false,
  modernFailureReason: "none",
  legacyFallbackTriggered: false,
  legacyImportStarted: false,
  legacyImportResolved: false,
  legacyWorkerConfigured: false,
  legacyWorkerSrcKind: "unconfigured",
  legacyGetDocumentCalled: false,
  legacyLoadingTaskCreated: false,
  legacyLoadingTaskPromiseStarted: false,
  legacyLoadingTaskPromiseResolved: false,
  legacyLoadingTaskPromiseRejected: false,
  legacyDocumentLoaded: false,
  successfulLoader: "none",
  finalStatus: "idle",
  reason: "none",
};

function safePdfError(error: unknown, category: string) {
  const name = error instanceof Error ? error.name.slice(0, 80) : "UnknownError";
  const message = error instanceof Error
    ? error.message.replace(/https?:\/\/\S+/gi, "[url]")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[id]").replace(/\s+/g, " ").slice(0, 160)
    : "Unknown PDF error";
  return { errorName: name, errorCategory: category.slice(0, 80), errorMessage: message };
}

export function SourceVisual({ conceptId, conceptTitle, contract, teachingPointIndexes, presentationKey, sources, lessonId, cloudOwnerId, authReady, onDebug }: Props) {
  const teachingPointIndexesKey = teachingPointIndexes.join(",");
  const visualSelection = useMemo(
    () => selectBeatVisualReferences(contract, sources, teachingPointIndexes),
    [contract, sources, teachingPointIndexesKey],
  );
  const [referenceIndex, setReferenceIndex] = useState(0);
  const selection = visualSelection.candidates[referenceIndex] ?? visualSelection.primary;
  const activeReferences = useMemo(
    () => contract ? deriveBeatSourceReferences(contract, teachingPointIndexes) : [],
    [contract, teachingPointIndexesKey],
  );
  const invalidPdfReference = useMemo(() => Boolean(activeReferences.find((reference) => {
    const source = sources.find((candidate) => candidate.id === reference.sourceId);
    return source?.mimeType === "application/pdf" && reference.page !== undefined &&
      (!Number.isInteger(reference.page) || reference.page < 1);
  })), [activeReferences, sources]);
  const cacheRef = useRef(new Map<string, Promise<PDFDocumentProxy>>());
  const loadingTasksRef = useRef(new Set<PDFDocumentLoadingTask>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const debugRef = useRef(onDebug);
  const lastVisualDebugKeyRef = useRef("");
  const [status, setStatus] = useState<VisualStatus>("idle");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [viewedPage, setViewedPage] = useState<number | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [renderWidth, setRenderWidth] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  const [debugPanelEnabled, setDebugPanelEnabled] = useState(false);
  const [copyResult, setCopyResult] = useState<"idle" | "copied" | "failed">("idle");
  const [diagnostics, setDiagnostics] = useState<SourceVisualDiagnostics>(INITIAL_DIAGNOSTICS);
  const availabilityReasonRef = useRef<AvailabilityReason>("none");
  debugRef.current = onDebug;
  const automaticPage = selection?.reference.page ?? null;
  const lessonSelectionKey = `${conceptId ?? "none"}:${presentationKey}:${visualSelection.candidates
    .map((candidate) => `${candidate.source.id}:${candidate.reference.page ?? "document"}`).join("|")}`;
  const selectionKey = `${selection?.source.id ?? "none"}:${automaticPage ?? "none"}`;
  const visualDebugKey = `${presentationKey}:${selectionKey}:${referenceIndex}:` +
    `${autoFollow ? "auto" : "manual"}:expanded:` +
    `${invalidPdfReference ? "invalid" : "valid"}:${retryNonce}`;

  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("debugSourceVisual");
    try {
      if (flag === "1") localStorage.setItem(SOURCE_VISUAL_DEBUG_STORAGE_KEY, "1");
      else if (flag === "0") localStorage.removeItem(SOURCE_VISUAL_DEBUG_STORAGE_KEY);
      setDebugPanelEnabled(flag === "1" || (flag !== "0" && localStorage.getItem(SOURCE_VISUAL_DEBUG_STORAGE_KEY) === "1"));
    } catch {
      setDebugPanelEnabled(flag === "1");
    }
  }, []);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      renderTaskRef.current?.cancel();
      for (const task of loadingTasksRef.current) void task.destroy().catch(() => undefined);
      loadingTasksRef.current.clear();
      for (const document of cache.values()) void document.then((loaded) => loaded.destroy()).catch(() => undefined);
      cache.clear();
    };
  }, []);

  useEffect(() => {
    setReferenceIndex(0);
    setAutoFollow(true);
    setViewedPage(visualSelection.primary?.reference.page ?? null);
  }, [lessonSelectionKey, visualSelection.primary?.reference.page]);

  useEffect(() => {
    setViewedPage(automaticPage);
    setPdf(null);
    setPageCount(0);
  }, [selectionKey, automaticPage]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => setRenderWidth(Math.floor(entry.contentRect.width)));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [status]);

  useEffect(() => {
    if (lastVisualDebugKeyRef.current === visualDebugKey) return;
    lastVisualDebugKeyRef.current = visualDebugKey;
    if (!selection) {
      debugRef.current(`Source visual unavailable: reason=${invalidPdfReference ? "invalid-page-reference" : "no-pdf-reference"}`);
      return;
    }
    debugRef.current(
      `Visual source selected: source=${selection.source.id}, page=${automaticPage ?? "none"}, ` +
      `reason=${selection.reason}, points=${teachingPointIndexesKey.replaceAll(",", "-")}, references=${visualSelection.candidates.length}, ` +
      `fallback=${visualSelection.fallbackUsed ? "yes" : "no"}, mode=${autoFollow ? "automatic" : "manual"}`,
    );
  }, [visualDebugKey, selection?.source.id, selection?.reason, automaticPage,
    invalidPdfReference, teachingPointIndexesKey, visualSelection.candidates.length,
    visualSelection.fallbackUsed, autoFollow]);

  useEffect(() => {
    const logAvailability = (options: {
      finalState: VisualStatus;
      reason: AvailabilityReason;
      metadataLookup: MetadataLookupResult;
      download: StorageDownloadResult;
      resolvedStoragePath?: boolean;
      pdfByteCount?: number;
      pdfLoad?: PdfLoadResult;
      pdfPageCount?: number;
      pdfStages?: Partial<SourceVisualDiagnostics>;
      resetPdfStages?: boolean;
    }) => {
      availabilityReasonRef.current = options.reason;
      setDiagnostics((current) => ({
        ...(options.resetPdfStages ? INITIAL_DIAGNOSTICS : current),
        metadataLookupResult: options.metadataLookup,
        resolvedStoragePath: options.resolvedStoragePath ?? Boolean(selection?.source.storagePath),
        storageDownloadResult: options.download,
        pdfByteCount: options.pdfByteCount ?? current.pdfByteCount,
        pdfLoadResult: options.pdfLoad ?? current.pdfLoadResult,
        pdfPageCount: options.pdfPageCount ?? current.pdfPageCount,
        finalStatus: options.finalState,
        reason: options.reason,
        ...options.pdfStages,
      }));
      if (process.env.NODE_ENV !== "development") return;
      debugRef.current(
        `SOURCE VISUAL AVAILABILITY: lessonId=${lessonId ? "present" : "missing"}, ` +
        `sourceId=${selection?.source.id ? "present" : "missing"}, sourceName=${selection?.source.name ? "present" : "missing"}, ` +
        `mimeType=${selection?.source.mimeType ?? "missing"}, authReady=${authReady}, authUserId=${cloudOwnerId ? "present" : "missing"}, ` +
        `cloudOwnerId=${cloudOwnerId ? "present" : "missing"}, cloudSyncReadiness=not-used, localFile=missing, localBlob=missing, ` +
        `storagePath=${selection?.source.storagePath ? "present" : "missing"}, storageStatus=${selection?.source.storageStatus ?? "missing"}, ` +
        `metadataLookupPossible=${Boolean(authReady && cloudOwnerId && lessonId && selection?.source.id)}, ` +
        `metadataLookupStarted=${options.metadataLookup === "started" || options.metadataLookup === "success" || options.metadataLookup === "not-found" || options.metadataLookup === "error"}, ` +
        `metadataLookupResult=${options.metadataLookup}, storageDownloadStarted=${options.download !== "not-run"}, ` +
        `storageDownloadResult=${options.download}, privateStorageAvailability=${options.download === "success" ? "available" : options.download === "error" ? "failed" : "unknown"}, ` +
        `pdfBytes=${options.pdfByteCount && options.pdfByteCount > 0 ? "present" : "missing"}, pdfByteCount=${options.pdfByteCount ?? 0}, ` +
        `finalAvailabilityState=${options.finalState}, unavailableReason=${options.reason}`,
      );
    };
    if (!selection) {
      const nextStatus = invalidPdfReference ? "unavailable" : "idle";
      setStatus(nextStatus);
      logAvailability({ finalState: nextStatus, reason: "invalid-source-reference", metadataLookup: "not-run", download: "not-run", resetPdfStages: true });
      return;
    }
    if (!automaticPage) {
      setStatus("unavailable");
      logAvailability({ finalState: "unavailable", reason: "missing-page-reference", metadataLookup: "not-run", download: "not-run", resetPdfStages: true });
      return;
    }
    debugRef.current(`Source visual metadata: source=${selection.source.id}, snapshotStoragePath=${selection.source.storagePath ? "present" : "missing"}, auth=${authReady ? "ready" : "not-ready"}`);
    if (!authReady) {
      setStatus("resolving");
      logAvailability({ finalState: "resolving", reason: "waiting-for-auth", metadataLookup: "not-run", download: "not-run", resetPdfStages: true });
      return;
    }
    if (!cloudOwnerId || !lessonId) {
      setStatus("unavailable");
      debugRef.current("Source visual unavailable: reason=no-cloud-source-context");
      logAvailability({ finalState: "unavailable", reason: "missing-cloud-context", metadataLookup: "not-run", download: "not-run", resetPdfStages: true });
      return;
    }
    let active = true;
    let retrievalStage: "metadata" | "download" | "pdf" = "metadata";
    let pdfOperationStage: "module-import" | "get-document" | "loading-task" = "module-import";
    let metadataLookup: "not-run" | "started" | "success" | "not-found" | "error" = "not-run";
    let download: "not-run" | "started" | "success" | "error" = "not-run";
    let pdfByteCount = 0;
    const load = async () => {
      let storagePath = selection.source.storagePath;
      if (!storagePath) {
        setStatus("resolving");
        metadataLookup = "started";
        logAvailability({ finalState: "resolving", reason: "none", metadataLookup, download });
        debugRef.current(`Source visual metadata lookup started: lesson=${lessonId}, source=${selection.source.id}`);
        try {
          storagePath = await resolveCloudLessonSourcePath(lessonId, selection.source.id, cloudOwnerId);
        } catch (error) {
          metadataLookup = "error";
          throw error;
        }
        debugRef.current(`Source visual metadata lookup completed: source=${selection.source.id}, storagePath=${storagePath ? "present" : "missing"}`);
        if (!storagePath) {
          metadataLookup = "not-found";
          if (active) {
            setStatus("unavailable");
            logAvailability({ finalState: "unavailable", reason: "cloud-source-not-found", metadataLookup, download });
          }
          return null;
        }
        metadataLookup = "success";
        logAvailability({ finalState: "resolving", reason: "none", metadataLookup, download, resolvedStoragePath: true });
      }
      if (!active) return null;
      const key = `${selection.source.id}:${storagePath}`;
      let promise = cacheRef.current.get(key);
      if (promise) {
        retrievalStage = "pdf";
        download = "success";
        debugRef.current(`Source visual cache hit: source=${selection.source.id}`);
      }
      else {
        setStatus("downloading");
        retrievalStage = "download";
        download = "started";
        logAvailability({ finalState: "downloading", reason: "none", metadataLookup, download, resolvedStoragePath: true });
        debugRef.current(`Source visual private download started: source=${selection.source.id}`);
        promise = downloadCloudLessonSource({ storagePath }, cloudOwnerId).then(async (blob) => {
          const bytes = await blob.arrayBuffer();
          download = "success";
          pdfByteCount = bytes.byteLength;
          debugRef.current(`Source visual private download completed: source=${selection.source.id}, byteCount=${bytes.byteLength}`);
          if (!bytes.byteLength) {
            retrievalStage = "download";
            throw new Error("cloud-source-empty");
          }
          retrievalStage = "pdf";
          debugRef.current(`Source visual PDF renderer started: source=${selection.source.id}`);
          const loadPdfAttempt = async (loader: "modern" | "legacy") => {
            const pdfData = new Uint8Array(bytes.slice(0));
            const legacy = loader === "legacy";
            logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
              pdfByteCount, pdfLoad: "started", pdfStages: {
                pdfDataPrepared: true, pdfLoaderAttempt: loader,
                ...(legacy ? { legacyImportStarted: true } : { pdfModuleImportStarted: true, modernImportStarted: true }),
              } });
            let importTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const importTimeout = new Promise<never>((_, reject) => {
              importTimeoutId = setTimeout(() => reject(new Error("pdf-module-import-timeout")), PDF_LOAD_TIMEOUT_MS);
            });
            const modulePromise = legacy
              ? import("pdfjs-dist/legacy/build/pdf.mjs")
              : import("pdfjs-dist");
            const pdfjs = await Promise.race([modulePromise, importTimeout]).finally(() => {
              if (importTimeoutId) clearTimeout(importTimeoutId);
            });
            logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
              pdfByteCount, pdfLoad: "started", pdfStages: legacy
                ? { legacyImportResolved: true }
                : { pdfModuleImportResolved: true, modernImportResolved: true } });
            pdfjs.GlobalWorkerOptions.workerSrc = legacy
              ? new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString()
              : new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
            pdfOperationStage = "get-document";
            logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
              pdfByteCount, pdfLoad: "started", pdfStages: {
                workerConfigured: true, workerSrcKind: "local", pdfGetDocumentCalled: true,
                ...(legacy ? { legacyWorkerConfigured: true, legacyWorkerSrcKind: "local", legacyGetDocumentCalled: true } : {}),
              } });
            const loadingTask = pdfjs.getDocument({ data: pdfData });
            pdfOperationStage = "loading-task";
            loadingTasksRef.current.add(loadingTask);
            logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
              pdfByteCount, pdfLoad: "started", pdfStages: {
                pdfLoadingTaskCreated: true, pdfLoadingTaskPromiseStarted: true,
                ...(legacy
                  ? { legacyLoadingTaskCreated: true, legacyLoadingTaskPromiseStarted: true }
                  : { modernLoadingTaskStarted: true }),
              } });
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              const timeout = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("pdf-load-timeout")), PDF_LOAD_TIMEOUT_MS);
              });
              const document = await Promise.race([loadingTask.promise, timeout]);
              logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
                pdfByteCount, pdfLoad: "success", pdfPageCount: document.numPages,
                pdfStages: {
                  pdfLoadingTaskPromiseResolved: true, pdfDocumentLoaded: true, successfulLoader: loader,
                  ...(legacy
                    ? { legacyLoadingTaskPromiseResolved: true, legacyDocumentLoaded: true }
                    : { modernLoadingTaskResolved: true }),
                } });
              return document;
            } catch (error) {
              const timedOut = error instanceof Error && error.message === "pdf-load-timeout";
              const failureReason = timedOut ? "pdf-load-timeout" : "pdf-loading-task-rejected";
              logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
                pdfByteCount, pdfLoad: "error", pdfStages: {
                  pdfLoadingTaskPromiseRejected: !timedOut,
                  ...(legacy
                    ? { legacyLoadingTaskPromiseRejected: !timedOut }
                    : { modernFailureReason: failureReason }),
                  ...safePdfError(error, timedOut ? `${loader}-loading-task-timeout` : `${loader}-loading-task`),
                } });
              await loadingTask.destroy().catch(() => undefined);
              throw error;
            } finally {
              if (timeoutId) clearTimeout(timeoutId);
              loadingTasksRef.current.delete(loadingTask);
            }
          };

          try {
            return await loadPdfAttempt("modern");
          } catch (modernError) {
            if (!active) throw new Error("pdf-load-cancelled");
            const modernFailureReason = modernError instanceof Error && modernError.message === "pdf-load-timeout"
              ? "pdf-load-timeout"
              : pdfOperationStage === "loading-task" ? "pdf-loading-task-rejected" : "pdf-load-failed";
            logAvailability({ finalState: "rendering", reason: "none", metadataLookup, download, resolvedStoragePath: true,
              pdfByteCount, pdfLoad: "started", pdfStages: { modernFailureReason, legacyFallbackTriggered: true,
                pdfLoaderAttempt: "legacy", pdfLoadingTaskCreated: false, pdfLoadingTaskPromiseStarted: false,
                pdfLoadingTaskPromiseResolved: false, pdfLoadingTaskPromiseRejected: false } });
            try {
              return await loadPdfAttempt("legacy");
            } catch {
              throw new Error("pdf-modern-and-legacy-load-failed");
            }
          }
        });
        cacheRef.current.set(key, promise);
        promise.catch(() => cacheRef.current.delete(key));
      }
      setStatus("rendering");
      return promise;
    };
    void load().then((document) => {
      if (!document) return;
      if (!active) return;
      setPdf(document); setPageCount(document.numPages);
      if (automaticPage > document.numPages) {
        setStatus("unavailable");
        debugRef.current(`Source visual unavailable: reason=page-out-of-range, source=${selection.source.id}, page=${automaticPage}, pages=${document.numPages}`);
        logAvailability({ finalState: "unavailable", reason: "page-out-of-range", metadataLookup, download,
          resolvedStoragePath: true, pdfByteCount, pdfLoad: "success", pdfPageCount: document.numPages });
      } else {
        setStatus("ready");
        logAvailability({ finalState: "ready", reason: "ready", metadataLookup, download,
          resolvedStoragePath: true, pdfByteCount, pdfLoad: "success", pdfPageCount: document.numPages });
      }
    }).catch((error: unknown) => {
      if (!active) return;
      if (retrievalStage === "metadata") metadataLookup = "error";
      if (retrievalStage === "download") download = "error";
      const reason: AvailabilityReason = error instanceof Error && error.message === "cloud-source-empty"
        ? "empty-pdf-bytes"
        : error instanceof Error && error.message === "pdf-modern-and-legacy-load-failed" ? "pdf-modern-and-legacy-load-failed"
        : error instanceof Error && error.message === "pdf-module-import-timeout" ? "pdf-module-import-timeout"
        : error instanceof Error && error.message === "pdf-load-timeout" ? "pdf-load-timeout"
        : retrievalStage === "metadata" ? "metadata-lookup-failed"
          : retrievalStage === "download" ? "download-failed"
            : pdfOperationStage === "loading-task" ? "pdf-loading-task-rejected" : "pdf-load-failed";
      setStatus("error");
      debugRef.current(`Source visual retrieval failed: source=${selection.source.id}`);
      logAvailability({ finalState: "error", reason, metadataLookup, download,
        resolvedStoragePath: metadataLookup === "success" || Boolean(selection.source.storagePath), pdfByteCount,
        pdfLoad: retrievalStage === "pdf" ? "error" : "not-run",
        pdfStages: retrievalStage === "pdf" ? safePdfError(error, reason) : undefined });
    });
    return () => {
      active = false;
      for (const task of loadingTasksRef.current) void task.destroy().catch(() => undefined);
      loadingTasksRef.current.clear();
    };
  }, [selectionKey, automaticPage, lessonId, cloudOwnerId, authReady, retryNonce, invalidPdfReference,
    teachingPointIndexesKey, visualSelection.candidates.length, visualSelection.fallbackUsed,
    selection?.source.id, selection?.source.storagePath, selection?.reason]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas || !viewedPage || viewedPage > pdf.numPages || renderWidth < 1 || status !== "ready") return;
    let active = true;
    renderTaskRef.current?.cancel();
    renderTaskRef.current = null;
    setDiagnostics((current) => ({ ...current, finalStatus: "rendering", reason: "none",
      pdfGetPageStarted: true, pdfGetPageResolved: false, pdfRenderStarted: false,
      pdfRenderResolved: false, pdfRenderRejected: false }));
    void pdf.getPage(viewedPage).then((page) => {
      if (!active) return;
      setDiagnostics((current) => ({ ...current, pdfGetPageResolved: true }));
      const base = page.getViewport({ scale: 1 });
      const cssScale = Math.max(0.1, renderWidth / base.width);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: cssScale * pixelRatio });
      canvas.width = Math.floor(viewport.width); canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
      canvas.style.height = `${Math.floor(viewport.height / pixelRatio)}px`;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      const task = page.render({ canvas, canvasContext: context, viewport });
      renderTaskRef.current = task;
      setDiagnostics((current) => ({ ...current, pdfRenderStarted: true }));
      return task.promise.then(() => {
        if (active) {
          renderTaskRef.current = null;
          setDiagnostics((current) => ({ ...current, finalStatus: "ready", reason: "ready", pdfRenderResolved: true }));
          debugRef.current(`Source visual page rendered: source=${selection?.source.id}, page=${viewedPage}`);
        }
      });
    }).catch((error: unknown) => {
      if (!active || (error instanceof Error && error.name === "RenderingCancelledException")) return;
      const renderStarted = renderTaskRef.current !== null;
      const reason: AvailabilityReason = renderStarted ? "pdf-render-failed" : "pdf-get-page-failed";
      setStatus("error");
      setDiagnostics((current) => ({ ...current, finalStatus: "error", reason,
        pdfRenderRejected: renderStarted, ...safePdfError(error, renderStarted ? "render" : "get-page") }));
    });
    return () => { active = false; renderTaskRef.current?.cancel(); };
  }, [pdf, viewedPage, renderWidth, status, selection]);

  const selectManualPage = (page: number) => {
    if (page < 1 || page > pageCount) return;
    setViewedPage(page);
    setAutoFollow(referenceIndex === 0 && page === visualSelection.primary?.reference.page);
    debugRef.current(`Manual visual page selected: source=${selection?.source.id}, page=${page}`);
  };
  const followLesson = () => {
    const primaryPage = visualSelection.primary?.reference.page;
    if (!primaryPage) return;
    setReferenceIndex(0); setViewedPage(primaryPage); setAutoFollow(true);
    debugRef.current(`Visual auto-follow restored: page=${primaryPage}`);
  };
  const selectManualReference = (index: number) => {
    if (index < 0 || index >= visualSelection.candidates.length) return;
    setReferenceIndex(index); setAutoFollow(false);
    const candidate = visualSelection.candidates[index];
    debugRef.current(`Manual visual reference selected: source=${candidate.source.id}, page=${candidate.reference.page ?? "none"}, reference=${index + 1}/${visualSelection.candidates.length}`);
  };
  const retry = () => {
    renderTaskRef.current?.cancel();
    for (const task of loadingTasksRef.current) void task.destroy().catch(() => undefined);
    loadingTasksRef.current.clear();
    setPdf(null);
    setStatus("idle");
    setDiagnostics(INITIAL_DIAGNOSTICS);
    if (selection) cacheRef.current.delete(`${selection.source.id}:${selection.source.storagePath}`);
    setViewedPage(automaticPage);
    setRetryNonce((value) => value + 1);
  };

  const debugText = [
    "SOURCE VISUAL DEBUG",
    `selectedSource: ${selection ? "present" : "missing"}`,
    `sourceId: ${selection?.source.id ? "present" : "missing"}`,
    `sourceName: ${selection?.source.name ? "present" : "missing"}`,
    `mimeType: ${selection?.source.mimeType ?? "missing"}`,
    `selectedPage: ${automaticPage ?? "missing"}`,
    `lessonId: ${lessonId ? "present" : "missing"}`,
    `authReady: ${authReady}`,
    `authUser: ${cloudOwnerId ? "present" : "missing"}`,
    `cloudOwner: ${cloudOwnerId ? "present" : "missing"}`,
    `snapshotStoragePath: ${selection?.source.storagePath ? "present" : "missing"}`,
    `snapshotStorageStatus: ${selection?.source.storageStatus ?? "missing"}`,
    "localFile: missing",
    "localBlob: missing",
    `metadataLookupPossible: ${Boolean(authReady && cloudOwnerId && lessonId && selection?.source.id)}`,
    `metadataLookupStarted: ${diagnostics.metadataLookupResult !== "not-run"}`,
    `metadataLookupResult: ${diagnostics.metadataLookupResult === "started" ? "not-run" : diagnostics.metadataLookupResult}`,
    `resolvedStoragePath: ${diagnostics.resolvedStoragePath ? "present" : "missing"}`,
    `storageDownloadStarted: ${diagnostics.storageDownloadResult !== "not-run"}`,
    `storageDownloadResult: ${diagnostics.storageDownloadResult === "started" ? "not-run" : diagnostics.storageDownloadResult}`,
    `pdfBytes: ${diagnostics.pdfByteCount > 0 ? "present" : "missing"}`,
    `pdfByteCount: ${diagnostics.pdfByteCount}`,
    `pdfLoadStarted: ${diagnostics.pdfLoadResult !== "not-run"}`,
    `pdfLoadResult: ${diagnostics.pdfLoadResult === "started" ? "not-run" : diagnostics.pdfLoadResult}`,
    `pdfDataPrepared: ${diagnostics.pdfDataPrepared}`,
    `pdfModuleImportStarted: ${diagnostics.pdfModuleImportStarted}`,
    `pdfModuleImportResolved: ${diagnostics.pdfModuleImportResolved}`,
    `workerConfigured: ${diagnostics.workerConfigured}`,
    `workerSrcKind: ${diagnostics.workerSrcKind}`,
    `pdfGetDocumentCalled: ${diagnostics.pdfGetDocumentCalled}`,
    `pdfLoadingTaskCreated: ${diagnostics.pdfLoadingTaskCreated}`,
    `pdfLoadingTaskPromiseStarted: ${diagnostics.pdfLoadingTaskPromiseStarted}`,
    `pdfLoadingTaskPromiseResolved: ${diagnostics.pdfLoadingTaskPromiseResolved}`,
    `pdfLoadingTaskPromiseRejected: ${diagnostics.pdfLoadingTaskPromiseRejected}`,
    `pdfDocumentLoaded: ${diagnostics.pdfDocumentLoaded}`,
    `pdfPageCount: ${diagnostics.pdfPageCount || "unknown"}`,
    `pdfGetPageStarted: ${diagnostics.pdfGetPageStarted}`,
    `pdfGetPageResolved: ${diagnostics.pdfGetPageResolved}`,
    `pdfRenderStarted: ${diagnostics.pdfRenderStarted}`,
    `pdfRenderResolved: ${diagnostics.pdfRenderResolved}`,
    `pdfRenderRejected: ${diagnostics.pdfRenderRejected}`,
    `errorName: ${diagnostics.errorName}`,
    `errorCategory: ${diagnostics.errorCategory}`,
    `errorMessage: ${diagnostics.errorMessage}`,
    `pdfLoaderAttempt: ${diagnostics.pdfLoaderAttempt}`,
    `modernImportStarted: ${diagnostics.modernImportStarted}`,
    `modernImportResolved: ${diagnostics.modernImportResolved}`,
    `modernLoadingTaskStarted: ${diagnostics.modernLoadingTaskStarted}`,
    `modernLoadingTaskResolved: ${diagnostics.modernLoadingTaskResolved}`,
    `modernFailureReason: ${diagnostics.modernFailureReason}`,
    `legacyFallbackTriggered: ${diagnostics.legacyFallbackTriggered}`,
    `legacyImportStarted: ${diagnostics.legacyImportStarted}`,
    `legacyImportResolved: ${diagnostics.legacyImportResolved}`,
    `legacyWorkerConfigured: ${diagnostics.legacyWorkerConfigured}`,
    `legacyWorkerSrcKind: ${diagnostics.legacyWorkerSrcKind}`,
    `legacyGetDocumentCalled: ${diagnostics.legacyGetDocumentCalled}`,
    `legacyLoadingTaskCreated: ${diagnostics.legacyLoadingTaskCreated}`,
    `legacyLoadingTaskPromiseStarted: ${diagnostics.legacyLoadingTaskPromiseStarted}`,
    `legacyLoadingTaskPromiseResolved: ${diagnostics.legacyLoadingTaskPromiseResolved}`,
    `legacyLoadingTaskPromiseRejected: ${diagnostics.legacyLoadingTaskPromiseRejected}`,
    `legacyDocumentLoaded: ${diagnostics.legacyDocumentLoaded}`,
    `successfulLoader: ${diagnostics.successfulLoader}`,
    `finalStatus: ${diagnostics.finalStatus}`,
    `reason: ${diagnostics.reason}`,
  ].join("\n");

  const copyDebugInfo = async () => {
    try {
      await navigator.clipboard.writeText(debugText);
      setCopyResult("copied");
    } catch {
      setCopyResult("failed");
    }
  };

  const label = selection ? `${selection.source.name}${automaticPage ? ` · Page ${automaticPage}` : " · Page not specified"}` : "No source visual for this topic";
  return <section className="source-visual" aria-label="Current lesson source visual">
    <header className="source-visual-header"><div><small>{conceptTitle || "Current concept"}</small><strong>{label}</strong></div></header>
    <div className="source-visual-body">
      {!selection && <p className="source-visual-message">{invalidPdfReference ? "The referenced PDF page is invalid." : "No source visual for this topic."}</p>}
      {selection && !automaticPage && <p className="source-visual-message">This PDF is relevant, but the source does not specify a page.</p>}
      {selection && automaticPage && status === "unavailable" && <p className="source-visual-message">{selection.source.storagePath ? automaticPage > pageCount && pageCount ? `Referenced page ${automaticPage} is outside this ${pageCount}-page PDF.` : "Original source not available on this device." : "Original source not available on this device."}</p>}
      {(status === "resolving" || status === "downloading" || status === "rendering") && <p className="source-visual-message" role="status">Loading source...</p>}
      {status === "error" && <div className="source-visual-message" role="alert"><p>Couldn't load the original source. Tutoring can continue.</p><button type="button" onClick={retry}>Retry visual</button></div>}
      {selection && status === "ready" && <><div className="source-visual-frame" ref={frameRef}><canvas ref={canvasRef} aria-label={`${selection.source.name}, page ${viewedPage}`} /></div>
        {visualSelection.candidates.length > 1 && <div className="source-visual-controls"><button type="button" onClick={() => selectManualReference(referenceIndex - 1)} disabled={referenceIndex <= 0} aria-label="Previous source reference">Previous source</button><span>Reference {referenceIndex + 1} / {visualSelection.candidates.length}</span><button type="button" onClick={() => selectManualReference(referenceIndex + 1)} disabled={referenceIndex >= visualSelection.candidates.length - 1} aria-label="Next source reference">Next source</button></div>}
        <div className="source-visual-controls"><button type="button" onClick={() => selectManualPage((viewedPage ?? 1) - 1)} disabled={!viewedPage || viewedPage <= 1} aria-label="Previous PDF page">Previous page</button><span>{autoFollow ? `Lesson page ${visualSelection.primary?.reference.page}` : `Viewing page ${viewedPage} manually`}</span><button type="button" onClick={() => selectManualPage((viewedPage ?? 0) + 1)} disabled={!viewedPage || viewedPage >= pageCount} aria-label="Next PDF page">Next page</button>{!autoFollow && <button type="button" onClick={followLesson}>Follow lesson</button>}</div></>}
      {debugPanelEnabled && <aside aria-label="Source visual diagnostics" style={{ marginTop: 12, padding: 12, overflowX: "auto", border: "1px solid currentColor", borderRadius: 8 }}>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.45 }}>{debugText}</pre>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          <button type="button" onClick={retry}>Retry Source Resolution</button>
          <button type="button" onClick={() => void copyDebugInfo()}>Copy Debug Info</button>
        </div>
        {copyResult !== "idle" && <small role="status">{copyResult === "copied" ? "Debug info copied." : "Couldn't copy debug info."}</small>}
      </aside>}
    </div>
  </section>;
}
