"use client";

import { useEffect, useMemo, useState } from "react";
import type { LessonProcessingJob } from "../lib/lesson-processing-job";
import type { LessonSource } from "../lib/learning-source";
import type { SavedLesson } from "../lib/local-persistence";

const MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash"] as const;
type DiagnosticModel = typeof MODELS[number];

type DiagnosticMetadata = {
  elapsedMs?: number;
  httpStatus?: number;
  sdkErrorClass?: string;
  providerStatus?: string | number;
  providerCode?: string | number;
  providerMessage?: string;
  retryAfter?: string;
  retryDelay?: string;
  quotaViolations?: Array<{
    metric?: string;
    id?: string;
    limit?: string | number;
    value?: string | number;
    dimensions?: Record<string, string>;
    description?: string;
  }>;
  requestId?: string;
  inputTokens?: string | number;
  outputTokens?: string | number;
  totalTokens?: string | number;
  rawNodeCount?: number;
  normalizedNodeCount?: number;
  leafCount?: number;
  maxDepth?: number;
  canonicalTeachableCount?: number;
  artifactSourceCount?: number;
  artifactPageCount?: number;
  artifactChars?: number;
  requestedSourceId?: string;
  requestedPage?: number;
};

type StageResult = {
  success: boolean;
  httpStatus: number;
  model: string;
  diagnostic: DiagnosticMetadata;
  message?: string;
};

type StageOneState = StageResult & {
  artifact?: unknown;
  sources?: LessonSource[];
  artifactSourceCount?: number;
  extractedPdfPages?: number;
  artifactChars?: number;
};

type SourceProbeState = StageResult & {
  sourceCount?: number;
  canReadSources?: boolean;
  briefTopics?: string[];
};

type CompactSourceState = StageResult & { artifact?: unknown };
type PageProbeState = StageResult & { canReadPage?: boolean; briefSummary?: string };

type Candidate = {
  key: string;
  lessonId: string;
  title: string;
  status: string;
  sources: LessonSource[];
  usable: boolean;
  unavailableReason?: string;
};

export function PreprocessingDiagnostic({
  jobs,
  lessons,
}: {
  jobs: LessonProcessingJob[];
  lessons: SavedLesson[];
}) {
  const [queryEnabled, setQueryEnabled] = useState(false);
  const [selectedKey, setSelectedKey] = useState("");
  const [model, setModel] = useState<DiagnosticModel>(MODELS[0]);
  const [sourceProbe, setSourceProbe] = useState<SourceProbeState | null>(null);
  const [tokenCount, setTokenCount] = useState<StageResult | null>(null);
  const [compactSource, setCompactSource] = useState<CompactSourceState | null>(null);
  const [singlePageCompact, setSinglePageCompact] = useState<CompactSourceState | null>(null);
  const [pageProbe, setPageProbe] = useState<PageProbeState | null>(null);
  const [singlePageSourceId, setSinglePageSourceId] = useState("");
  const [singlePageNumber, setSinglePageNumber] = useState("1");
  const [stageOne, setStageOne] = useState<StageOneState | null>(null);
  const [stageTwo, setStageTwo] = useState<StageResult | null>(null);
  const [running, setRunning] = useState<"probe" | "tokens" | "compact" | "single-page" | "page-probe" | "source" | "design" | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [liveElapsedMs, setLiveElapsedMs] = useState(0);

  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      setQueryEnabled(new URLSearchParams(window.location.search).get("enable") === "1");
    }
  }, []);

  const candidates = useMemo(() => {
    const byLesson = new Map<string, Candidate>();
    for (const lesson of lessons) {
      byLesson.set(lesson.id, makeCandidate(`lesson:${lesson.id}`, lesson.id, lesson.title, "saved", lesson.sources));
    }
    for (const job of jobs) {
      byLesson.set(job.lessonId, makeCandidate(`job:${job.id}`, job.lessonId, job.title || "Untitled lesson", job.status, job.sources));
    }
    return [...byLesson.values()].sort((a, b) => Number(b.usable) - Number(a.usable));
  }, [jobs, lessons]);

  useEffect(() => {
    if (selectedKey && candidates.some((candidate) => candidate.key === selectedKey)) return;
    const preferred = candidates.find((candidate) => candidate.usable && candidate.status === "error") ??
      candidates.find((candidate) => candidate.usable) ?? candidates[0];
    setSelectedKey(preferred?.key ?? "");
  }, [candidates, selectedKey]);

  useEffect(() => {
    if (!running || startedAt === null) return;
    const update = () => setLiveElapsedMs(Date.now() - startedAt);
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  const selected = candidates.find((candidate) => candidate.key === selectedKey) ?? null;
  const pdfCount = selected?.sources.filter((source) => source.mimeType === "application/pdf").length ?? 0;
  const txtCount = selected?.sources.filter((source) => source.mimeType === "text/plain").length ?? 0;
  const totalBytes = selected?.sources.reduce((sum, source) => sum + source.sizeBytes, 0) ?? 0;
  const pdfSources = selected?.sources.filter((source) => source.mimeType === "application/pdf") ?? [];
  const parsedSinglePage = Number(singlePageNumber);
  const validSinglePage = /^\d+$/.test(singlePageNumber) && Number.isSafeInteger(parsedSinglePage) && parsedSinglePage > 0;

  useEffect(() => {
    if (pdfSources.some((source) => source.id === singlePageSourceId)) return;
    setSinglePageSourceId(pdfSources.length === 1 ? pdfSources[0].id : "");
  }, [pdfSources, singlePageSourceId]);

  if (process.env.NODE_ENV !== "development" || !queryEnabled) return null;

  const reset = () => {
    setSourceProbe(null);
    setTokenCount(null);
    setCompactSource(null);
    setSinglePageCompact(null);
    setPageProbe(null);
    setStageOne(null);
    setStageTwo(null);
    setRunning(null);
    setStartedAt(null);
    setLiveElapsedMs(0);
  };

  const runSourceProbe = async () => {
    if (!selected?.usable || running) return;
    setSourceProbe(null);
    setRunning("probe");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const response = await fetch(`/api/lesson-sources?diagnosticStage=source-probe&diagnosticModel=${encodeURIComponent(selectedModel)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: selected.lessonId, sources: selected.sources }),
      });
      const payload = await readPayload(response);
      const probe = payload.probe && typeof payload.probe === "object" && !Array.isArray(payload.probe)
        ? payload.probe as Record<string, unknown> : {};
      setSourceProbe({ success: response.ok, httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic: getDiagnostic(payload), message: getMessage(payload),
        sourceCount: typeof probe.sourceCount === "number" ? probe.sourceCount : undefined,
        canReadSources: typeof probe.canReadSources === "boolean" ? probe.canReadSources : undefined,
        briefTopics: Array.isArray(probe.briefTopics) ? probe.briefTopics.filter((item): item is string => typeof item === "string") : undefined });
    } catch (error) {
      setSourceProbe({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Source Probe request failed." });
    } finally { setRunning(null); setStartedAt(null); }
  };

  const countInputTokens = async () => {
    if (!selected?.usable || running) return;
    setTokenCount(null);
    setRunning("tokens");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const response = await fetch(`/api/lesson-sources?diagnosticStage=count-tokens&diagnosticModel=${encodeURIComponent(selectedModel)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: selected.lessonId, sources: selected.sources }),
      });
      const payload = await readPayload(response);
      const diagnostic = getDiagnostic(payload);
      if (typeof payload.inputTokens === "number" || typeof payload.inputTokens === "string") diagnostic.inputTokens = payload.inputTokens;
      setTokenCount({ success: response.ok, httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic, message: getMessage(payload) });
    } catch (error) {
      setTokenCount({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Input-token count request failed." });
    } finally { setRunning(null); setStartedAt(null); }
  };

  const runStageOne = async () => {
    if (!selected?.usable || running) return;
    setStageOne(null);
    setStageTwo(null);
    setRunning("source");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const response = await fetch(`/api/lesson-sources?diagnosticStage=source&diagnosticModel=${encodeURIComponent(selectedModel)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: selected.lessonId, sources: selected.sources }),
      });
      const payload = await readPayload(response);
      const artifact = payload.artifact;
      const artifactSources = getArtifactSources(artifact);
      setStageOne({
        success: response.ok,
        httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic: getDiagnostic(payload),
        message: getMessage(payload),
        ...(response.ok ? {
          artifact,
          sources: Array.isArray(payload.sources) ? payload.sources as LessonSource[] : [],
          artifactSourceCount: artifactSources.length,
          extractedPdfPages: artifactSources.reduce((sum, source) => sum + (Array.isArray(source.pages) ? source.pages.length : 0), 0),
          artifactChars: JSON.stringify(artifact).length,
        } : {}),
      });
    } catch (error) {
      setStageOne({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Stage 1 request failed." });
    } finally {
      setRunning(null);
      setStartedAt(null);
    }
  };

  const runCompactSource = async () => {
    if (!selected?.usable || running) return;
    setCompactSource(null);
    setRunning("compact");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const response = await fetch(`/api/lesson-sources?diagnosticStage=compact-source&diagnosticModel=${encodeURIComponent(selectedModel)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: selected.lessonId, sources: selected.sources }),
      });
      const payload = await readPayload(response);
      setCompactSource({ success: response.ok, httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic: getDiagnostic(payload), message: getMessage(payload),
        ...(response.ok ? { artifact: payload.artifact } : {}) });
    } catch (error) {
      setCompactSource({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Compact Stage 1 request failed." });
    } finally { setRunning(null); setStartedAt(null); }
  };

  const runSinglePageCompact = async () => {
    if (!selected?.usable || !singlePageSourceId || !validSinglePage || running) return;
    setSinglePageCompact(null);
    setRunning("single-page");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const params = new URLSearchParams({ diagnosticStage: "single-page-compact", diagnosticModel: selectedModel,
        sourceId: singlePageSourceId, page: String(parsedSinglePage) });
      const response = await fetch(`/api/lesson-sources?${params.toString()}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: selected.lessonId, sources: selected.sources }),
      });
      const payload = await readPayload(response);
      setSinglePageCompact({ success: response.ok, httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic: getDiagnostic(payload), message: getMessage(payload),
        ...(response.ok ? { artifact: payload.artifact } : {}) });
    } catch (error) {
      setSinglePageCompact({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Single-page compact request failed." });
    } finally { setRunning(null); setStartedAt(null); }
  };

  const runPageProbe = async () => {
    if (!selected?.usable || !singlePageSourceId || !validSinglePage || running) return;
    setPageProbe(null);
    setRunning("page-probe");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const params = new URLSearchParams({ diagnosticStage: "page-probe", diagnosticModel: selectedModel,
        sourceId: singlePageSourceId, page: String(parsedSinglePage) });
      const response = await fetch(`/api/lesson-sources?${params.toString()}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: selected.lessonId, sources: selected.sources }),
      });
      const payload = await readPayload(response);
      const probe = payload.probe && typeof payload.probe === "object" && !Array.isArray(payload.probe)
        ? payload.probe as Record<string, unknown> : {};
      setPageProbe({ success: response.ok, httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic: getDiagnostic(payload), message: getMessage(payload),
        canReadPage: typeof probe.canReadPage === "boolean" ? probe.canReadPage : undefined,
        briefSummary: typeof probe.briefSummary === "string" ? probe.briefSummary : undefined });
    } catch (error) {
      setPageProbe({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Page Probe request failed." });
    } finally { setRunning(null); setStartedAt(null); }
  };

  const runStageTwo = async () => {
    if (!stageOne?.success || !stageOne.artifact || !stageOne.sources || running) return;
    setStageTwo(null);
    setRunning("design");
    setStartedAt(Date.now());
    const selectedModel = model;
    try {
      const response = await fetch(`/api/lesson-sources?diagnosticStage=design&diagnosticModel=${encodeURIComponent(selectedModel)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sources: stageOne.sources, artifact: stageOne.artifact }),
      });
      const payload = await readPayload(response);
      setStageTwo({ success: response.ok, httpStatus: response.status,
        model: typeof payload.model === "string" ? payload.model : selectedModel,
        diagnostic: getDiagnostic(payload), message: getMessage(payload) });
    } catch (error) {
      setStageTwo({ success: false, httpStatus: 0, model: selectedModel, diagnostic: {},
        message: error instanceof Error ? error.message : "Stage 2 request failed." });
    } finally {
      setRunning(null);
      setStartedAt(null);
    }
  };

  return (
    <section className="preprocessing-diagnostic" aria-labelledby="preprocessing-diagnostic-title">
      <div className="diagnostic-heading">
        <div><p className="eyebrow">Development tooling</p><h2 id="preprocessing-diagnostic-title">Preprocessing Diagnostic</h2></div>
        <button className="button-secondary" type="button" disabled={Boolean(running)} onClick={reset}>Reset Diagnostic</button>
      </div>

      <div className="diagnostic-controls">
        <label><span>Lesson or processing job</span><select value={selectedKey} disabled={Boolean(running)} onChange={(event) => { reset(); setSinglePageNumber("1"); setSinglePageSourceId(""); setSelectedKey(event.target.value); }}>
          {!candidates.length && <option value="">No lessons or jobs available</option>}
          {candidates.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.title} · {candidate.lessonId} · {candidate.status} · {candidate.sources.length} source{candidate.sources.length === 1 ? "" : "s"}{candidate.usable ? "" : " · unavailable"}</option>)}
        </select></label>
        <label><span>Diagnostic model</span><select value={model} disabled={Boolean(running)} onChange={(event) => setModel(event.target.value as DiagnosticModel)}>{MODELS.map((item) => <option key={item}>{item}</option>)}</select></label>
      </div>

      {selected && <div className="diagnostic-source-summary">
        <dl><div><dt>Lesson ID</dt><dd>{selected.lessonId}</dd></div><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>Sources</dt><dd>{selected.sources.length} ({pdfCount} PDF, {txtCount} TXT)</dd></div><div><dt>Known bytes</dt><dd>{totalBytes.toLocaleString()}</dd></div></dl>
        <ul>{selected.sources.map((source) => <li key={source.id}><strong>{source.name}</strong> <span>{source.role}</span></li>)}</ul>
        {!selected.usable && <p className="diagnostic-warning" role="status">Unavailable: {selected.unavailableReason}</p>}
      </div>}

      <section className="diagnostic-step"><h3>Source Probe</h3><p>Same original source bundle with a tiny readability response. Success does not prove that all PDF semantics were extracted correctly.</p><div className="diagnostic-actions"><button className="button-primary" type="button" disabled={!selected?.usable || Boolean(running)} onClick={() => void runSourceProbe()}>{running === "probe" ? "Running Source Probe..." : "Run Source Probe"}</button>{running === "probe" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>
      {sourceProbe && <StageResultView title="Source Probe" result={sourceProbe} extras={sourceProbe.success ? [
        ["Reported sources", sourceProbe.sourceCount], ["Can read sources", sourceProbe.canReadSources], ["Brief topics", sourceProbe.briefTopics?.join("; ")],
      ] : []} />}

      <section className="diagnostic-step"><h3>Input Token Count</h3><p>Manual input-token measurement for the full Stage 1 multimodal request. This is not a generation attempt.</p><div className="diagnostic-actions"><button className="button-secondary" type="button" disabled={!selected?.usable || Boolean(running)} onClick={() => void countInputTokens()}>{running === "tokens" ? "Counting Input Tokens..." : "Count Input Tokens"}</button>{running === "tokens" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>
      {tokenCount && <StageResultView title="Input Token Count" result={tokenCount} extras={[]} />}

      <section className="diagnostic-step"><h3>Stage 1 — Compact Source Extraction</h3><p>Same original source bundle with bounded page and section summaries. This result is not used by Stage 2.</p><div className="diagnostic-actions"><button className="button-primary" type="button" disabled={!selected?.usable || Boolean(running)} onClick={() => void runCompactSource()}>{running === "compact" ? "Running Compact Stage 1..." : "Run Compact Stage 1"}</button>{running === "compact" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>
      {compactSource && <StageResultView title="Compact Stage 1" result={compactSource} extras={compactSource.success ? [
        ["Artifact sources", compactSource.diagnostic.artifactSourceCount], ["Artifact PDF pages", compactSource.diagnostic.artifactPageCount],
        ["Artifact characters", compactSource.diagnostic.artifactChars],
      ] : []} />}
      {compactSource?.success && <details className="diagnostic-artifact"><summary>Inspect compact source artifact</summary><pre>{JSON.stringify(compactSource.artifact, null, 2)}</pre></details>}

      <section className="diagnostic-step"><h3>Single-Page Compact Extraction</h3><p>The complete original bundle is sent, but structured extraction is requested for one physical PDF page only.</p><div className="diagnostic-page-controls">
        {pdfSources.length > 1 ? <label><span>PDF source</span><select value={singlePageSourceId} disabled={Boolean(running)} onChange={(event) => setSinglePageSourceId(event.target.value)}><option value="">Select a PDF source</option>{pdfSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label> : <div><span>PDF source</span><strong>{pdfSources[0]?.name ?? "No PDF source available"}</strong></div>}
        <label><span>PDF page to test</span><input type="number" min="1" step="1" value={singlePageNumber} disabled={Boolean(running)} onChange={(event) => setSinglePageNumber(event.target.value)} /></label>
      </div><div className="diagnostic-actions"><button className="button-primary" type="button" disabled={!selected?.usable || !singlePageSourceId || !validSinglePage || Boolean(running)} onClick={() => void runSinglePageCompact()}>{running === "single-page" ? "Running Single-Page Compact..." : "Run Single-Page Compact"}</button>{running === "single-page" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>
      {singlePageCompact && <StageResultView title="Single-Page Compact" result={singlePageCompact} extras={[
        ["Requested source", singlePageCompact.diagnostic.requestedSourceId], ["Requested page", singlePageCompact.diagnostic.requestedPage],
        ["Artifact characters", singlePageCompact.diagnostic.artifactChars],
      ]} />}
      {singlePageCompact?.success && <details className="diagnostic-artifact"><summary>Inspect single-page compact result</summary><pre>{JSON.stringify(singlePageCompact.artifact, null, 2)}</pre></details>}

      <section className="diagnostic-step"><h3>Page Probe</h3><p>Uses the PDF source and physical page selected above with the same complete original bundle, requesting only a boolean and one short sentence.</p><div className="diagnostic-actions"><button className="button-primary" type="button" disabled={!selected?.usable || !singlePageSourceId || !validSinglePage || Boolean(running)} onClick={() => void runPageProbe()}>{running === "page-probe" ? "Running Page Probe..." : "Run Page Probe"}</button>{running === "page-probe" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>
      {pageProbe && <StageResultView title="Page Probe" result={pageProbe} extras={[
        ["Requested source", pageProbe.diagnostic.requestedSourceId], ["Requested page", pageProbe.diagnostic.requestedPage],
        ["Can read page", pageProbe.canReadPage], ["Brief summary", pageProbe.briefSummary],
      ]} />}

      <section className="diagnostic-step"><h3>Stage 1 — Full Source Extraction</h3><div className="diagnostic-actions"><button className="button-primary" type="button" disabled={!selected?.usable || Boolean(running)} onClick={() => void runStageOne()}>{running === "source" ? "Running Stage 1..." : "Run Stage 1 — Understand Sources"}</button>{running === "source" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>

      {stageOne && <StageResultView title="Stage 1" result={stageOne} extras={stageOne.success ? [
        ["Artifact sources", stageOne.artifactSourceCount], ["Extracted PDF pages", stageOne.extractedPdfPages], ["Artifact characters", stageOne.artifactChars],
      ] : []} />}
      {stageOne?.success && <p className="diagnostic-ready">Stage 1 artifact ready for Stage 2. Stage 1 model: <strong>{stageOne.model}</strong>; Stage 2 selected model: <strong>{model}</strong>.</p>}
      {stageOne?.success && <details className="diagnostic-artifact"><summary>Inspect Stage 1 artifact</summary><pre>{JSON.stringify(stageOne.artifact, null, 2)}</pre></details>}
      <section className="diagnostic-step"><h3>Stage 2 — Lesson Design</h3><div className="diagnostic-actions"><button className="button-primary" type="button" disabled={!stageOne?.success || Boolean(running)} onClick={() => void runStageTwo()}>{running === "design" ? "Running Stage 2..." : "Run Stage 2 — Design Lesson"}</button>{running === "design" && <span role="status">Elapsed {(liveElapsedMs / 1000).toFixed(1)}s</span>}</div></section>
      {stageTwo && <StageResultView title="Stage 2" result={stageTwo} extras={stageTwo.success ? [
        ["Raw nodes", stageTwo.diagnostic.rawNodeCount], ["Normalized nodes", stageTwo.diagnostic.normalizedNodeCount],
        ["Leaves", stageTwo.diagnostic.leafCount], ["Max depth", stageTwo.diagnostic.maxDepth],
        ["Canonical teachable", stageTwo.diagnostic.canonicalTeachableCount],
      ] : []} />}
      {(sourceProbe || compactSource || singlePageCompact || pageProbe || stageOne || stageTwo) && <p className="diagnostic-interpretation">{interpret(sourceProbe, compactSource, singlePageCompact, pageProbe, stageOne, stageTwo)}</p>}
    </section>
  );
}

function StageResultView({ title, result, extras }: { title: string; result: StageResult; extras: Array<[string, unknown]> }) {
  const fields: Array<[string, unknown]> = [
    ["HTTP status", result.httpStatus || "network failure"], ["Model", result.model], ["Elapsed ms", result.diagnostic.elapsedMs],
    ["Input tokens", result.diagnostic.inputTokens], ["Output tokens", result.diagnostic.outputTokens], ["Total tokens", result.diagnostic.totalTokens], ...extras,
  ];
  return <section className="diagnostic-result"><h3>{title}: <span className={result.success ? "diagnostic-success" : "diagnostic-failure"}>{result.success ? "SUCCESS" : "FAILURE"}</span></h3><dl>{fields.filter(([, value]) => value !== undefined).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl>{result.message && <p>{result.message}</p>}{!result.success && <ProviderErrorDetails result={result} />}</section>;
}

function ProviderErrorDetails({ result }: { result: StageResult }) {
  const diagnostic = result.diagnostic;
  const fields: Array<[string, unknown]> = [
    ["HTTP status", diagnostic.httpStatus ?? (result.httpStatus || "not provided")],
    ["SDK error class", diagnostic.sdkErrorClass ?? "not provided"],
    ["Provider status", diagnostic.providerStatus ?? "not provided"],
    ["Provider code", diagnostic.providerCode ?? "not provided"],
    ["Provider message", diagnostic.providerMessage ?? "not provided"],
    ["Retry delay", diagnostic.retryDelay ?? "not provided"],
    ["Retry-After", diagnostic.retryAfter ?? "not provided"],
    ["Request/trace ID", diagnostic.requestId ?? "not provided"],
  ];
  return <details className="diagnostic-provider-error"><summary>Provider Error Details</summary><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value)}</dd></div>)}</dl><h4>QuotaFailure</h4>{diagnostic.quotaViolations?.length ? diagnostic.quotaViolations.map((violation, index) => <dl key={index}><div><dt>Quota metric</dt><dd>{violation.metric ?? "not provided"}</dd></div><div><dt>Quota ID</dt><dd>{violation.id ?? "not provided"}</dd></div><div><dt>Quota limit</dt><dd>{violation.limit ?? "not provided"}</dd></div><div><dt>Quota value/current</dt><dd>{violation.value ?? "not provided"}</dd></div><div><dt>Quota dimensions</dt><dd>{violation.dimensions ? JSON.stringify(violation.dimensions) : "not provided"}</dd></div>{violation.description && <div><dt>Description</dt><dd>{violation.description}</dd></div>}</dl>) : <p>not provided</p>}</details>;
}

function makeCandidate(key: string, lessonId: string, title: string, status: string, sources: LessonSource[]): Candidate {
  const missing = sources.filter((source) => source.storageStatus !== "stored" || !source.storagePath);
  return { key, lessonId, title, status, sources, usable: sources.length > 0 && missing.length === 0,
    ...(missing.length ? { unavailableReason: `${missing.length} source descriptor${missing.length === 1 ? " is" : "s are"} not storage-ready.` } : {}) };
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getDiagnostic(payload: Record<string, unknown>): DiagnosticMetadata {
  return payload.diagnostic && typeof payload.diagnostic === "object" && !Array.isArray(payload.diagnostic)
    ? payload.diagnostic as DiagnosticMetadata : {};
}

function getMessage(payload: Record<string, unknown>) {
  return typeof payload.message === "string" ? payload.message : undefined;
}

function getArtifactSources(artifact: unknown): Array<Record<string, unknown>> {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return [];
  const sources = (artifact as Record<string, unknown>).sources;
  return Array.isArray(sources) ? sources.filter((source): source is Record<string, unknown> => Boolean(source) && typeof source === "object" && !Array.isArray(source)) : [];
}

function interpret(sourceProbe: SourceProbeState | null, compactSource: CompactSourceState | null, singlePageCompact: CompactSourceState | null, pageProbe: PageProbeState | null, stageOne: StageOneState | null, stageTwo: StageResult | null) {
  if (sourceProbe?.success && pageProbe?.success && singlePageCompact && !singlePageCompact.success) return "Explicit page targeting succeeds with a tiny response. The richer compact extraction request or schema is a stronger suspect. This does not prove causation.";
  if (sourceProbe?.success && pageProbe && !pageProbe.success && singlePageCompact && !singlePageCompact.success) return "Source-level understanding succeeds, but explicitly page-targeted requests fail in these tests. Page-targeted PDF processing is a stronger suspect. This does not prove causation.";
  if (sourceProbe?.success && singlePageCompact?.success && compactSource && !compactSource.success) return "Gemini can perform page-aware structured extraction for a limited scope. Whole-document exhaustive extraction or scaling is a stronger suspect. This does not prove causation.";
  if (sourceProbe?.success && singlePageCompact && !singlePageCompact.success && compactSource && !compactSource.success) return "Gemini can answer a small source-level query, but page-targeted extraction also fails. Whole-document output volume alone is not isolated. This does not prove causation.";
  if (sourceProbe?.success && compactSource?.success && stageOne && !stageOne.success) return "Gemini can ingest the source bundle and produce bounded page-aware output. The larger full-extraction workload is a stronger suspect. This does not prove causation.";
  if (sourceProbe?.success && compactSource && !compactSource.success && stageOne && !stageOne.success) return "Source ingestion succeeds for a tiny response, but both page-aware extraction variants fail. Output size alone is not yet isolated. This does not prove causation.";
  if (stageOne && !stageOne.success && sourceProbe?.success) return "Full Stage 1 failed while the tiny Source Probe succeeded. The sources were readable for the probe, so the larger extraction/output workload is a main suspect; this does not prove root cause or complete PDF understanding.";
  if (stageOne && !stageOne.success && sourceProbe && !sourceProbe.success) return "Full Stage 1 and the tiny Source Probe both failed. Source ingestion, multimodal processing, or broader provider capacity remains a main suspect; this does not prove root cause.";
  if (stageOne && !stageOne.success && (stageOne.httpStatus === 503 || stageOne.diagnostic.providerStatus === 503)) return "Source understanding failed before lesson design was attempted. This result does not by itself prove causation.";
  if (stageOne?.success && stageTwo && !stageTwo.success) return "Source understanding succeeded; lesson design failed separately. This result does not by itself prove causation.";
  if (stageOne?.success && stageTwo?.success) return "Both isolated stages completed successfully. This result does not by itself prove causation.";
  return "Run the isolated stages to compare their outcomes; a single result does not prove causation.";
}
