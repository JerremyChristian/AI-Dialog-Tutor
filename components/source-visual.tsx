"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { AtomicTeachingContract, LessonSource } from "../lib/learning-source";
import { downloadCloudLessonSource } from "../lib/cloud-sync";
import { selectPrimaryVisualReference } from "../lib/source-visual";

type Props = {
  conceptId: string | null;
  conceptTitle?: string;
  contract?: AtomicTeachingContract;
  sources: LessonSource[];
  cloudOwnerId: string | null;
  onDebug: (message: string) => void;
};
type VisualStatus = "idle" | "loading" | "ready" | "error" | "unavailable";

export function SourceVisual({ conceptId, conceptTitle, contract, sources, cloudOwnerId, onDebug }: Props) {
  const selection = useMemo(() => selectPrimaryVisualReference(contract, sources), [contract, sources]);
  const invalidPdfReference = useMemo(() => (contract?.sourceReferences ?? []).find((reference) => {
    const source = sources.find((candidate) => candidate.id === reference.sourceId);
    return source?.mimeType === "application/pdf" && reference.page !== undefined &&
      (!Number.isInteger(reference.page) || reference.page < 1);
  }), [contract, sources]);
  const cacheRef = useRef(new Map<string, Promise<PDFDocumentProxy>>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const debugRef = useRef(onDebug);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<VisualStatus>("idle");
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [viewedPage, setViewedPage] = useState<number | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [renderWidth, setRenderWidth] = useState(0);
  const [retryNonce, setRetryNonce] = useState(0);
  debugRef.current = onDebug;
  const automaticPage = selection?.reference.page ?? null;
  const selectionKey = `${conceptId ?? "none"}:${selection?.source.id ?? "none"}:${automaticPage ?? "none"}`;

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      renderTaskRef.current?.cancel();
      for (const document of cache.values()) void document.then((loaded) => loaded.destroy()).catch(() => undefined);
      cache.clear();
    };
  }, []);

  useEffect(() => setExpanded(window.matchMedia("(min-width: 900px)").matches), []);

  useEffect(() => {
    setAutoFollow(true);
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
  }, [expanded, status]);

  useEffect(() => {
    if (!selection) {
      setStatus(invalidPdfReference ? "unavailable" : "idle");
      debugRef.current(`Source visual unavailable: reason=${invalidPdfReference ? "invalid-page-reference" : "no-pdf-reference"}`);
      return;
    }
    debugRef.current(`Visual source selected: source=${selection.source.id}, page=${automaticPage ?? "none"}, reason=${selection.reason}`);
    if (!automaticPage) {
      setStatus("unavailable");
      return;
    }
    if (!expanded) {
      setStatus("idle");
      return;
    }
    if (!selection.source.storagePath || selection.source.storageStatus !== "stored" || !cloudOwnerId) {
      setStatus("unavailable");
      debugRef.current("Source visual unavailable: reason=original-source-not-stored");
      return;
    }
    let active = true;
    const key = `${selection.source.id}:${selection.source.storagePath}`;
    let promise = cacheRef.current.get(key);
    if (promise) debugRef.current(`Source visual cache hit: source=${selection.source.id}`);
    else {
      debugRef.current(`Source visual download started: source=${selection.source.id}`);
      promise = downloadCloudLessonSource(selection.source, cloudOwnerId).then(async (blob) => {
        const bytes = await blob.arrayBuffer();
        debugRef.current(`Source visual download completed: source=${selection.source.id}, bytes=${bytes.byteLength}`);
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        return pdfjs.getDocument({ data: bytes }).promise;
      });
      cacheRef.current.set(key, promise);
      promise.catch(() => cacheRef.current.delete(key));
    }
    setStatus("loading");
    void promise.then((document) => {
      if (!active) return;
      setPdf(document); setPageCount(document.numPages);
      if (automaticPage > document.numPages) {
        setStatus("unavailable");
        debugRef.current(`Source visual unavailable: reason=page-out-of-range, source=${selection.source.id}, page=${automaticPage}, pages=${document.numPages}`);
      } else setStatus("ready");
    }).catch(() => {
      if (active) { setStatus("error"); debugRef.current(`Source visual unavailable: reason=download-failed, source=${selection.source.id}`); }
    });
    return () => { active = false; };
  }, [selectionKey, selection, automaticPage, cloudOwnerId, retryNonce, expanded, invalidPdfReference]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!pdf || !canvas || !viewedPage || viewedPage > pdf.numPages || renderWidth < 1 || status !== "ready") return;
    let active = true;
    renderTaskRef.current?.cancel();
    void pdf.getPage(viewedPage).then((page) => {
      if (!active) return;
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
      return task.promise.then(() => {
        if (active) debugRef.current(`Source visual page rendered: source=${selection?.source.id}, page=${viewedPage}`);
      });
    }).catch((error: unknown) => {
      if (active && !(error instanceof Error && error.name === "RenderingCancelledException")) setStatus("error");
    });
    return () => { active = false; renderTaskRef.current?.cancel(); };
  }, [pdf, viewedPage, renderWidth, status, selection]);

  const selectManualPage = (page: number) => {
    if (page < 1 || page > pageCount) return;
    setViewedPage(page); setAutoFollow(page === automaticPage);
    debugRef.current(`Manual visual page selected: source=${selection?.source.id}, page=${page}`);
  };
  const followLesson = () => {
    if (!automaticPage) return;
    setViewedPage(automaticPage); setAutoFollow(true);
    debugRef.current(`Visual auto-follow restored: page=${automaticPage}`);
  };
  const retry = () => { setPdf(null); setStatus("idle"); if (selection) cacheRef.current.delete(`${selection.source.id}:${selection.source.storagePath}`); setViewedPage(automaticPage); setRetryNonce((value) => value + 1); };

  const label = selection ? `${selection.source.name}${automaticPage ? ` · Page ${automaticPage}` : " · Page not specified"}` : "No source visual for this topic";
  return <section className="source-visual" aria-label="Current lesson source visual">
    <header className="source-visual-header"><div><small>{conceptTitle || "Current concept"}</small><strong>{label}</strong></div>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} source visual`}>{expanded ? "Hide" : "Show"}</button></header>
    {expanded && <div className="source-visual-body">
      {!selection && <p className="source-visual-message">{invalidPdfReference ? "The referenced PDF page is invalid." : "No source visual for this topic."}</p>}
      {selection && !automaticPage && <p className="source-visual-message">This PDF is relevant, but the source does not specify a page.</p>}
      {selection && automaticPage && status === "unavailable" && <p className="source-visual-message">{selection.source.storagePath ? automaticPage > pageCount && pageCount ? `Referenced page ${automaticPage} is outside this ${pageCount}-page PDF.` : "Original source not available on this device." : "Original source not available on this device."}</p>}
      {status === "loading" && <p className="source-visual-message" role="status">Loading source page…</p>}
      {status === "error" && <div className="source-visual-message" role="alert"><p>The source visual could not be loaded. Tutoring can continue.</p><button type="button" onClick={retry}>Retry visual</button></div>}
      {selection && status === "ready" && <><div className="source-visual-frame" ref={frameRef}><canvas ref={canvasRef} aria-label={`${selection.source.name}, page ${viewedPage}`} /></div>
        <div className="source-visual-controls"><button type="button" onClick={() => selectManualPage((viewedPage ?? 1) - 1)} disabled={!viewedPage || viewedPage <= 1} aria-label="Previous PDF page">Previous</button><span>{autoFollow ? `Lesson page ${automaticPage}` : `Viewing page ${viewedPage} manually`}</span><button type="button" onClick={() => selectManualPage((viewedPage ?? 0) + 1)} disabled={!viewedPage || viewedPage >= pageCount} aria-label="Next PDF page">Next</button>{!autoFollow && <button type="button" onClick={followLesson}>Return to lesson page {automaticPage}</button>}</div></>}
    </div>}
  </section>;
}
