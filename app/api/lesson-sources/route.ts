import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { NextResponse } from "next/server";
import {
  MAX_LESSON_SOURCES,
  MAX_CLOUD_SOURCE_BUNDLE_BYTES,
  MAX_SOURCE_BUNDLE_BYTES,
  MAX_SOURCE_BYTES,
  SUPPORTED_SOURCE_TYPES,
  type LessonSource,
} from "../../../lib/learning-source";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { createLessonTreeNormalizationDiagnostics, normalizeLessonTree } from "../../../lib/lesson-outline";
import {
  formatDepthDistribution,
  formatNormalizationLoss,
  measureNormalizedLessonTree,
  measureRawLessonTree,
} from "../../../lib/preprocessing-diagnostics";
import type { SourceProcessingErrorCode, SourceProcessingErrorResponse } from "../../../lib/source-processing-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash"] as const;
const DEFAULT_DIAGNOSTIC_MODEL = MODELS[0];
const MODEL_TIMEOUT_MS = 180_000;
const OPERATION_TIMEOUT_MS = 300_000;

type SourceDescriptor = Pick<LessonSource, "id" | "name" | "mimeType" | "sizeBytes" | "role"> & {
  storagePath?: string;
};

type DiagnosticSourceArtifact = {
  version: 1;
  sources: Array<{
    sourceId: string;
    name: string;
    role: SourceDescriptor["role"];
    mimeType: SourceDescriptor["mimeType"];
    pages: Array<{ page: number; headings: string[]; content: string }>;
    sections: Array<{ heading: string; content: string }>;
  }>;
};

function failure(code: SourceProcessingErrorCode, retryable: boolean, message: string, status: number) {
  return NextResponse.json<SourceProcessingErrorResponse>({ code, retryable, message }, { status });
}

function describe(error: unknown) {
  if (error instanceof Error) return `${error.message} ${(error as Error & { status?: unknown }).status ?? ""}`;
  return typeof error === "string" ? error : "Unknown error";
}

function classify(error: unknown) {
  const detail = describe(error);
  if (/429|RESOURCE_EXHAUSTED|quota|free_tier/i.test(detail)) return { code: "QUOTA_EXHAUSTED" as const, retryable: true, status: 429 };
  if (/503|UNAVAILABLE|high demand|overload/i.test(detail)) return { code: "TEMPORARY_UNAVAILABLE" as const, retryable: true, status: 503 };
  if (/499|CANCELLED|aborted|timeout|deadline/i.test(detail)) return { code: "PROCESSING_TIMEOUT" as const, retryable: true, status: 504 };
  return { code: "UNKNOWN" as const, retryable: false, status: 500 };
}

function safeProviderErrorDetails(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const parsedBody = parseSdkErrorBody(error instanceof Error ? error.message : undefined);
  const nested = asRecord(parsedBody?.error) ?? asRecord(record.error) ?? {};
  const details: Record<string, unknown>[] = Array.isArray(nested.details) ? nested.details.flatMap((value): Record<string, unknown>[] => {
    const detail = asRecord(value);
    return detail ? [detail] : [];
  }) : [];
  const errorInfo = details.find((detail) => providerDetailType(detail) === "google.rpc.ErrorInfo");
  const retryInfo = details.find((detail) => providerDetailType(detail) === "google.rpc.RetryInfo");
  const quotaFailure = details.find((detail) => providerDetailType(detail) === "google.rpc.QuotaFailure");
  const quotaViolations = Array.isArray(quotaFailure?.violations) ? quotaFailure.violations.flatMap((value) => {
    const violation = asRecord(value);
    if (!violation) return [];
    const dimensions = stringRecord(violation.quotaDimensions ?? violation.dimensions);
    return [{
      ...(safeText(violation.quotaMetric, 240) ? { metric: safeText(violation.quotaMetric, 240) } : {}),
      ...(safeText(violation.quotaId ?? violation.quotaName, 240) ? { id: safeText(violation.quotaId ?? violation.quotaName, 240) } : {}),
      ...(safeScalar(violation.quotaLimit ?? violation.limit) !== undefined ? { limit: safeScalar(violation.quotaLimit ?? violation.limit) } : {}),
      ...(safeScalar(violation.quotaValue ?? violation.currentValue ?? violation.value) !== undefined
        ? { value: safeScalar(violation.quotaValue ?? violation.currentValue ?? violation.value) } : {}),
      ...(dimensions ? { dimensions } : {}),
      ...(safeText(violation.description, 300) ? { description: safeText(violation.description, 300) } : {}),
    }];
  }) : [];
  const metadata = asRecord(errorInfo?.metadata);
  const httpStatus = [record.status, record.statusCode, nested.code].find((value) => typeof value === "number");
  const providerStatus = safeText(nested.status, 100);
  const providerCode = safeText(errorInfo?.reason, 120) ?? safeScalar(nested.code);
  const requestId = safeText(
    nested.requestId ?? nested.request_id ?? nested.traceId ?? nested.trace_id ??
    metadata?.requestId ?? metadata?.request_id ?? metadata?.traceId ?? metadata?.trace_id,
    240,
  );
  return {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(safeText(error instanceof Error ? error.name : record.name, 100) ? { sdkErrorClass: safeText(error instanceof Error ? error.name : record.name, 100) } : {}),
    ...(providerStatus ? { providerStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(sanitizeProviderMessage(nested.message) ? { providerMessage: sanitizeProviderMessage(nested.message) } : {}),
    ...(safeText(retryInfo?.retryDelay ?? nested.retryDelay, 100) ? { retryDelay: safeText(retryInfo?.retryDelay ?? nested.retryDelay, 100) } : {}),
    ...(quotaViolations.length ? { quotaViolations } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

function parseSdkErrorBody(message: string | undefined): Record<string, unknown> | null {
  if (!message) return null;
  try { return asRecord(JSON.parse(message)); } catch { return null; }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function providerDetailType(detail: Record<string, unknown>) {
  const type = safeText(detail["@type"], 200) ?? "";
  return type.split("/").at(-1) ?? type;
}

function safeText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim() ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maxLength) : undefined;
}

function safeScalar(value: unknown): string | number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : safeText(value, 160);
}

function stringRecord(value: unknown) {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).flatMap(([key, item]) => {
    const safeKey = safeText(key, 100); const safeValue = safeText(item, 160);
    return safeKey && safeValue ? [[safeKey, safeValue] as const] : [];
  }).slice(0, 20);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sanitizeProviderMessage(value: unknown) {
  const message = safeText(value, 500);
  if (!message) return undefined;
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "[redacted-api-key]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[redacted]");
}

function providerLogFields(provider: ReturnType<typeof safeProviderErrorDetails>) {
  return {
    providerHttpStatus: provider.httpStatus ?? "unknown",
    providerStatus: provider.providerStatus ?? "unknown",
    providerCode: provider.providerCode ?? "unknown",
    sdkErrorClass: provider.sdkErrorClass ?? "unknown",
    providerMessage: provider.providerMessage ?? "unknown",
    retryAfter: "unknown",
    retryDelay: provider.retryDelay ?? "unknown",
    quotaViolations: JSON.stringify(provider.quotaViolations ?? []),
    requestId: provider.requestId ?? "unknown",
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseDescriptors(value: FormDataEntryValue | null): SourceDescriptor[] | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_LESSON_SOURCES) return null;
    const sources = parsed as Array<Record<string, unknown>>;
    if (!sources.every((source) =>
      typeof source.id === "string" && isUuid(source.id) &&
      typeof source.name === "string" && Boolean(source.name.trim()) && source.name.length <= 200 &&
      SUPPORTED_SOURCE_TYPES.includes(source.mimeType as never) &&
      typeof source.sizeBytes === "number" && Number.isInteger(source.sizeBytes) && source.sizeBytes > 0 &&
      (source.role === "slides" || source.role === "transcript" || source.role === "notes" || source.role === "other")
    )) return null;
    return sources as SourceDescriptor[];
  } catch {
    return null;
  }
}

const sourceReferenceSchema = {
  type: "object",
  properties: {
    sourceId: { type: "string" },
    page: { type: "integer", minimum: 1 },
    section: { type: "string" },
  },
  required: ["sourceId"],
  additionalProperties: false,
} as const;

const lessonTreeSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string" }, title: { type: "string" }, parentId: { type: ["string", "null"] }, order: { type: "integer" },
      sourceReferences: { type: "array", items: sourceReferenceSchema },
      teaching: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["overview", "concept", "definition", "procedure", "worked-example", "comparison", "summary"] },
          importance: { type: "string", enum: ["core", "supporting", "optional"] },
          objective: { type: "string" }, teachingPoints: { type: "array", items: { type: "string" } },
          teachingPointSourceReferences: {
            type: "array",
            items: { type: "array", items: sourceReferenceSchema },
          },
          completionCriteria: { type: "array", items: { type: "string" } },
          deliveryUnits: {
            type: "array", items: { type: "object", properties: {
              objective: { type: "string" },
              teachingPointIndexes: { type: "array", items: { type: "integer" } },
              completionCriteriaIndexes: { type: "array", items: { type: "integer" } },
              presentationBeats: { type: "array", items: { type: "object", properties: {
                teachingPointIndexes: { type: "array", items: { type: "integer" } },
              }, required: ["teachingPointIndexes"], additionalProperties: false } },
            }, required: ["objective", "teachingPointIndexes", "completionCriteriaIndexes", "presentationBeats"],
            additionalProperties: false },
          },
          sourceReferences: { type: "array", items: sourceReferenceSchema },
          keyTerms: { type: "array", items: { type: "string" } }, notation: { type: "array", items: { type: "string" } },
          sourceConfidence: { type: "string", enum: ["clear", "uncertain"] }, uncertaintyNote: { type: "string" },
        },
        required: ["type", "importance", "objective", "teachingPoints", "completionCriteria", "deliveryUnits"],
        additionalProperties: false,
      },
    },
    required: ["id", "title", "parentId", "order"], additionalProperties: false,
  },
} as const;

const diagnosticSourceSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceId: { type: "string" }, name: { type: "string" }, role: { type: "string" }, mimeType: { type: "string" },
          pages: { type: "array", items: { type: "object", properties: {
            page: { type: "integer", minimum: 1 }, headings: { type: "array", items: { type: "string" } }, content: { type: "string" },
          }, required: ["page", "headings", "content"], additionalProperties: false } },
          sections: { type: "array", items: { type: "object", properties: {
            heading: { type: "string" }, content: { type: "string" },
          }, required: ["heading", "content"], additionalProperties: false } },
        },
        required: ["sourceId", "name", "role", "mimeType", "pages", "sections"], additionalProperties: false,
      },
    },
  },
  required: ["version", "sources"], additionalProperties: false,
} as const;

const sourceProbeSchema = {
  type: "object",
  properties: {
    sourceCount: { type: "integer", minimum: 0 },
    canReadSources: { type: "boolean" },
    briefTopics: { type: "array", maxItems: 3, items: { type: "string", maxLength: 100 } },
  },
  required: ["sourceCount", "canReadSources", "briefTopics"], additionalProperties: false,
} as const;

const compactSourceSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    sources: { type: "array", items: { type: "object", properties: {
      sourceId: { type: "string" }, name: { type: "string" }, role: { type: "string" }, mimeType: { type: "string" },
      pages: { type: "array", items: { type: "object", properties: {
        page: { type: "integer", minimum: 1 }, heading: { type: "string", maxLength: 100 },
        summary: { type: "string", maxLength: 900 },
        keyPoints: { type: "array", maxItems: 3, items: { type: "string", maxLength: 240 } },
        keyTerms: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
      }, required: ["page", "heading", "summary", "keyPoints", "keyTerms"], additionalProperties: false } },
      sections: { type: "array", items: { type: "object", properties: {
        heading: { type: "string", maxLength: 100 }, summary: { type: "string", maxLength: 900 },
        keyPoints: { type: "array", maxItems: 3, items: { type: "string", maxLength: 240 } },
        keyTerms: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
      }, required: ["heading", "summary", "keyPoints", "keyTerms"], additionalProperties: false } },
    }, required: ["sourceId", "name", "role", "mimeType", "pages", "sections"], additionalProperties: false } },
  },
  required: ["version", "sources"], additionalProperties: false,
} as const;

const singlePageCompactSchema = {
  type: "object",
  properties: {
    sourceId: { type: "string" }, page: { type: "integer", minimum: 1 },
    heading: { type: "string", maxLength: 100 }, summary: { type: "string", maxLength: 900 },
    keyPoints: { type: "array", maxItems: 3, items: { type: "string", maxLength: 240 } },
    keyTerms: { type: "array", maxItems: 5, items: { type: "string", maxLength: 100 } },
  },
  required: ["sourceId", "page", "heading", "summary", "keyPoints", "keyTerms"], additionalProperties: false,
} as const;

const pageProbeSchema = {
  type: "object",
  properties: {
    canReadPage: { type: "boolean" }, briefSummary: { type: "string", maxLength: 240 },
  },
  required: ["canReadPage", "briefSummary"], additionalProperties: false,
} as const;

function prompt(sources: SourceDescriptor[]) {
  const catalog = sources.map((s) => `- id=${s.id}; role=${s.role}; name=${s.name}; type=${s.mimeType}`).join("\n");
  return `Convert this bundle of complementary educational sources into ONE faithful structured learning source, ONE coherent hierarchy, and ONE set of atomic teaching contracts.

SOURCE CATALOG
${catalog}

Treat every uploaded source as authoritative course material. Preserve lecturer terminology, notation, equations, tables, figures, examples, ordering, warnings, and qualifications. Slides primarily provide structure, notation, tables and visuals. Transcripts enrich those concepts with spoken explanation, examples, emphasis and context without duplicating slide wording. Notes supplement with supported detail and worked explanations. Other sources add relevant supported material.

Merge overlapping explanations conservatively into one concept. Preserve useful additional detail. If sources conflict, explicitly describe what each source says, set sourceConfidence to uncertain where relevant, and explain the conflict in uncertaintyNote. Do not reconcile conflicts using outside knowledge.

Return JSON with lessonTitle, structuredSource, and lessonTree. The tree is a flat hierarchical node array. Atomic leaves have teaching contracts; structural parents do not. Contracts contain a short objective, 3-7 source-derived teachingPoints, 2-5 tutor-facing completionCriteria, type, importance, and optional keyTerms/notation/confidence.

Use structured sourceReferences with an exact sourceId from the catalog. PDF page is the 1-based physical PDF page index; omit page for TXT and never invent one. Include node and contract references when useful.

For every teachingPoints entry, return the index-aligned teachingPointSourceReferences entry containing every source location materially useful for teaching that specific point. A point may cite zero, one, or multiple locations, including consecutive or non-consecutive PDF pages and multiple sources. Slides may supply visual structure, notes detailed explanation, transcripts lecturer explanation, and other sources supplementary material. Prefer precise point references, but never force a mapping or invent a page. Preserve an empty inner array when no point-specific location is confidently supported. Keep teachingPoints as strings and keep the outer arrays index-aligned.

For each atomic contract also return deliveryUnits. Units must partition every teaching-point index exactly once, in order, into contiguous moderate spoken teaching segments organized around coherent objectives and preferably one or more completion criteria. Do not blindly create one unit per criterion; a unit may have no criterion and a criterion may relate to multiple units. Avoid making an entire large section one unit merely because it shares a heading.

Each unit's presentationBeats must partition that unit's indexes exactly once, in order and contiguously. A beat is one natural Gemini explanation and one visual context. Prefer grouping multiple closely related points. Split for a clearly meaningful slide/source context change, or when a group becomes too large or awkward, but treat source changes as evidence rather than a hard rule: do not make one beat per point or page. Automatic visuals change only between beats.`;
}

function sourceUnderstandingPrompt(sources: SourceDescriptor[]) {
  const catalog = sources.map((s) => `- id=${s.id}; role=${s.role}; name=${s.name}; type=${s.mimeType}`).join("\n");
  return `Extract a compact but faithful structured representation of these educational sources for a later lesson-design operation.

SOURCE CATALOG
${catalog}

This is source understanding only. Do not create a lesson hierarchy, teaching contracts, teaching points, completion criteria, delivery units, presentation beats, coverage, mastery judgments, or pedagogy.

Keep every source separate and use its exact catalog id, name, role, and MIME type. For PDFs, preserve every physical PDF page as a separate pages entry with its 1-based page number, headings visible on that page, and source text needed to design a faithful lesson later. Preserve lecturer terminology, notation, equations, tables, figure meaning, examples, warnings, qualifications, and meaningful ordering. Use sections=[] for PDFs. For TXT, preserve source boundaries and headings/sections in sections, use pages=[], and retain the source text needed for later lesson design. Do not aggressively summarize or add outside knowledge. The later operation will not receive the original files.`;
}

function sourceProbePrompt(sources: SourceDescriptor[]) {
  const catalog = sources.map((s) => `- id=${s.id}; role=${s.role}; name=${s.name}; type=${s.mimeType}`).join("\n");
  return `Read the supplied educational source bundle only enough to verify that its contents are accessible.

SOURCE CATALOG
${catalog}

Return only sourceCount, canReadSources, and up to three brief topic labels of at most 100 characters each. Do not perform page-by-page extraction or transcription. Do not return structured source material, lesson hierarchy, teaching points, contracts, delivery units, presentation beats, or pedagogical design. Topic labels are only a lightweight readability probe and do not prove that every PDF semantic detail was extracted.`;
}

function compactSourcePrompt(sources: SourceDescriptor[]) {
  const catalog = sources.map((s) => `- id=${s.id}; role=${s.role}; name=${s.name}; type=${s.mimeType}`).join("\n");
  return `Create a deliberately compact, page-aware representation of these educational sources.

SOURCE CATALOG
${catalog}

Keep every source separate and copy its exact sourceId, name, role, and MIME type from the catalog. For each PDF, include one pages entry for every physical PDF page you can identify, in order, using the 1-based physical page number. Do not invent page numbers. Each page must contain only: a heading of about 12 words maximum, a summary of 80-120 words maximum, up to 3 short keyPoints, and up to 5 short keyTerms. Use sections=[] for PDFs.

For TXT sources use pages=[] and preserve identifiable section boundaries in sections. Each TXT section has the same bounds: heading about 12 words maximum, summary 80-120 words maximum, up to 3 short keyPoints, and up to 5 short keyTerms.

Do not transcribe or reproduce complete source content. Do not include a content field, lesson tree, atomic teaching contracts, teaching points, completion criteria, delivery units, presentation beats, coverage, mastery, pedagogy, or lesson sequencing. Use only the supplied sources and keep the output bounded.`;
}

function singlePageCompactPrompt(sources: SourceDescriptor[], sourceId: string, page: number) {
  const catalog = sources.map((s) => `- id=${s.id}; role=${s.role}; name=${s.name}; type=${s.mimeType}`).join("\n");
  return `Create a deliberately compact representation of exactly one requested physical PDF page from the supplied educational source bundle.

SOURCE CATALOG
${catalog}

REQUESTED PDF SOURCE ID: ${sourceId}
REQUESTED PHYSICAL PDF PAGE: ${page}

Return only the requested sourceId and 1-based physical page number, a heading of about 12 words maximum, a summary of 80-120 words maximum, up to 3 short keyPoints, and up to 5 short keyTerms. Inspect and return no other page or TXT section. Do not transcribe the page or reproduce complete source content. Do not return a lesson tree, teaching contracts, teaching points, completion criteria, delivery units, presentation beats, coverage, mastery, pedagogy, or lesson sequencing. Do not invent a different page number.`;
}

function pageProbePrompt(sources: SourceDescriptor[], sourceId: string, page: number) {
  const catalog = sources.map((s) => `- id=${s.id}; role=${s.role}; name=${s.name}; type=${s.mimeType}`).join("\n");
  return `Read the supplied educational source bundle only enough to answer a tiny question about one explicitly requested physical PDF page.

SOURCE CATALOG
${catalog}

REQUESTED PDF SOURCE ID: ${sourceId}
REQUESTED PHYSICAL PDF PAGE: ${page}

Return only whether you can read that requested page and one brief summary sentence of at most approximately 30 words. Do not inspect or return other pages or TXT sections. Do not transcribe, extract structured source material, or return headings, key points, key terms, page arrays, source arrays, sections, lesson content, pedagogy, or teaching structures. Do not substitute a different source or page.`;
}

function diagnosticModel(request: Request) {
  const selected = new URL(request.url).searchParams.get("diagnosticModel") || DEFAULT_DIAGNOSTIC_MODEL;
  return MODELS.find((model) => model === selected) ?? null;
}

function usageFields(response: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } }) {
  return {
    inputTokens: response.usageMetadata?.promptTokenCount ?? "unknown",
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? "unknown",
    totalTokens: response.usageMetadata?.totalTokenCount ?? "unknown",
  };
}

function diagnosticLog(fields: Record<string, string | number>) {
  console.info(`PREPROCESS_STAGE_DIAGNOSTIC ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(" ")}`);
}

function validDiagnosticArtifact(value: unknown, descriptors: SourceDescriptor[]): value is DiagnosticSourceArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<DiagnosticSourceArtifact>;
  if (artifact.version !== 1 || !Array.isArray(artifact.sources) || artifact.sources.length !== descriptors.length) return false;
  return descriptors.every((descriptor) => artifact.sources!.some((source) =>
    source && source.sourceId === descriptor.id && source.name === descriptor.name && source.role === descriptor.role &&
    source.mimeType === descriptor.mimeType && Array.isArray(source.pages) && Array.isArray(source.sections)
  ));
}

async function runDesignDiagnostic(request: Request, model: typeof MODELS[number]) {
  let body: { sources?: unknown; artifact?: unknown };
  try { body = await request.json() as typeof body; } catch { return failure("INVALID_SOURCE", false, "Diagnostic JSON is invalid.", 400); }
  const descriptors = parseDescriptors(JSON.stringify(body.sources));
  if (!descriptors || !validDiagnosticArtifact(body.artifact, descriptors)) {
    return failure("INVALID_SOURCE", false, "Diagnostic sources or Stage 1 artifact are invalid.", 400);
  }
  const artifactText = JSON.stringify(body.artifact);
  const startedAt = Date.now();
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
  try {
    const response = await client.models.generateContent({ model, contents: [{ text:
      `${prompt(descriptors)}\n\nDIAGNOSTIC LESSON-DESIGN STAGE\nThe original PDF/TXT payload is intentionally unavailable. ` +
      `Use only the Stage 1 structured source artifact below. Return the same production lesson-design object requested above.\n\nSTAGE 1 ARTIFACT\n${artifactText}`,
    }], config: {
      maxOutputTokens: 32_768, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, responseMimeType: "application/json",
      responseJsonSchema: { type: "object", properties: {
        lessonTitle: { type: "string" }, structuredSource: { type: "string" }, lessonTree: lessonTreeSchema,
      }, required: ["lessonTitle", "structuredSource", "lessonTree"], additionalProperties: false },
    } });
    const parsed = JSON.parse(response.text || "{}") as Record<string, unknown>;
    const rawMetrics = measureRawLessonTree(parsed.lessonTree);
    const normalizationDiagnostics = createLessonTreeNormalizationDiagnostics();
    const lessonTree = normalizeLessonTree(parsed.lessonTree, new Set(descriptors.map((source) => source.id)), normalizationDiagnostics);
    const normalizedMetrics = measureNormalizedLessonTree(lessonTree);
    if (!lessonTree.length) throw new Error("No lesson tree returned");
    const elapsedMs = Date.now() - startedAt;
    const usage = usageFields(response);
    diagnosticLog({ stage: "lesson-design", model, structuredSourceChars: artifactText.length,
      elapsedMs, result: "success", ...usage });
    console.info(`PREPROCESS_STAGE_DIAGNOSTIC_QUALITY model=${model} rawNodeCount=${rawMetrics.nodeCount} normalizedNodeCount=${normalizedMetrics.nodeCount} leafCount=${normalizedMetrics.leafCount} maxDepth=${normalizedMetrics.maxDepth} canonicalTeachableCount=${normalizedMetrics.canonicalTeachableNodeCount}`);
    return NextResponse.json({ lessonTitle: typeof parsed.lessonTitle === "string" ? parsed.lessonTitle.trim().slice(0, 160) : "",
      structuredText: typeof parsed.structuredSource === "string" ? parsed.structuredSource.trim() : "", lessonTree, model,
      diagnostic: { elapsedMs, ...usage, rawNodeCount: rawMetrics.nodeCount, normalizedNodeCount: normalizedMetrics.nodeCount,
        leafCount: normalizedMetrics.leafCount, maxDepth: normalizedMetrics.maxDepth,
        canonicalTeachableCount: normalizedMetrics.canonicalTeachableNodeCount } },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const classified = classify(error); const provider = safeProviderErrorDetails(error);
    const elapsedMs = Date.now() - startedAt;
    diagnosticLog({ stage: "lesson-design", model, structuredSourceChars: artifactText.length,
      elapsedMs, result: "failure", ...providerLogFields(provider),
      inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" });
    return NextResponse.json({ code: classified.code, retryable: classified.retryable,
      message: "The diagnostic lesson-design stage failed.", diagnostic: { model, elapsedMs,
        ...provider,
        inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" } }, { status: classified.status });
  }
}

function safeFilename(value: string) {
  const cleaned = value.split(/[\\/]/).at(-1)?.normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return cleaned || "source";
}

export async function POST(request: Request) {
  const diagnosticStage = new URL(request.url).searchParams.get("diagnosticStage");
  if (diagnosticStage && process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (diagnosticStage && diagnosticStage !== "source" && diagnosticStage !== "design" &&
      diagnosticStage !== "source-probe" && diagnosticStage !== "count-tokens" && diagnosticStage !== "compact-source" &&
      diagnosticStage !== "single-page-compact" && diagnosticStage !== "page-probe") {
    return failure("INVALID_SOURCE", false, "Unknown diagnostic stage.", 400);
  }
  if (!process.env.GEMINI_API_KEY) return failure("UNKNOWN", false, "Source processing is unavailable.", 500);
  const selectedDiagnosticModel = diagnosticStage ? diagnosticModel(request) : null;
  if (diagnosticStage && !selectedDiagnosticModel) {
    return failure("INVALID_SOURCE", false, `diagnosticModel must be one of: ${MODELS.join(", ")}.`, 400);
  }
  if (diagnosticStage === "design") return runDesignDiagnostic(request, selectedDiagnosticModel!);
  try {
    const storageFirst = request.headers.get("content-type")?.includes("application/json") ?? false;
    let descriptors: SourceDescriptor[] | null;
    let typedFiles: File[];
    let lessonId: string | null = null;
    if (storageFirst) {
      const body = await request.json() as { lessonId?: unknown; sources?: unknown };
      lessonId = typeof body.lessonId === "string" && isUuid(body.lessonId) ? body.lessonId : null;
      descriptors = parseDescriptors(JSON.stringify(body.sources));
      if (!lessonId || !descriptors || descriptors.some((source) => typeof source.storagePath !== "string")) {
        return failure("INVALID_SOURCE", false, "Stored source metadata is invalid.", 400);
      }
      const supabase = await createSupabaseServerClient();
      const authResult = supabase
        ? await supabase.auth.getUser()
        : { data: { user: null }, error: new Error("unavailable") };
      if (authResult.error || !authResult.data.user || !supabase) {
        return failure("INVALID_SOURCE", false, "Sign in to process stored sources.", 401);
      }
      typedFiles = [];
      for (const descriptor of descriptors) {
        const segments = descriptor.storagePath!.split("/");
        if (segments.length !== 4 || segments[0] !== authResult.data.user.id ||
            segments[1] !== lessonId || segments[2] !== descriptor.id ||
            segments[3] !== safeFilename(descriptor.name)) {
          return failure("INVALID_SOURCE", false, "A stored source path is outside this lesson.", 403);
        }
        const { data: blob, error } = await supabase.storage
          .from("lesson-sources")
          .download(descriptor.storagePath!);
        if (error || !blob || blob.size !== descriptor.sizeBytes) {
          return failure("INVALID_SOURCE", false, `Stored source ${descriptor.name} is unavailable or changed.`, 422);
        }
        typedFiles.push(new File([blob], descriptor.name, { type: descriptor.mimeType }));
      }
      console.info(`Storage-first preprocessing request: lesson=${lessonId}, sources=${descriptors.length}, rawBrowserPayload=no`);
    } else {
      const form = await request.formData();
      descriptors = parseDescriptors(form.get("metadata"));
      const files = form.getAll("sources");
      if (!descriptors || files.length !== descriptors.length || !files.every((file) => file instanceof File)) {
        return failure("INVALID_SOURCE", false, "Select between 1 and 6 PDF or TXT sources.", 400);
      }
      typedFiles = files as File[];
    }
    let totalBytes = 0;
    const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt(descriptors) }];
    for (const [index, descriptor] of descriptors.entries()) {
      const file = typedFiles[index];
      if (file.type !== descriptor.mimeType || file.name !== descriptor.name || file.size !== descriptor.sizeBytes || file.size > MAX_SOURCE_BYTES) {
        return failure("INVALID_SOURCE", false, "Source metadata does not match the selected files.", 400);
      }
      totalBytes += file.size;
      const bundleLimit = storageFirst ? MAX_CLOUD_SOURCE_BUNDLE_BYTES : MAX_SOURCE_BUNDLE_BYTES;
      if (totalBytes > bundleLimit) {
        return failure("INVALID_SOURCE", false, `The source bundle exceeds the ${storageFirst ? "40" : "4"} MB limit.`, 413);
      }
      const bytes = await file.arrayBuffer();
      if (descriptor.mimeType === "application/pdf") {
        if (new TextDecoder("ascii").decode(bytes.slice(0, 5)) !== "%PDF-") return failure("INVALID_SOURCE", false, `${file.name} is not a valid PDF.`, 400);
        contents.push({ text: `SOURCE id=${descriptor.id} role=${descriptor.role} name=${descriptor.name}` });
        contents.push({ inlineData: { mimeType: descriptor.mimeType, data: Buffer.from(bytes).toString("base64") } });
      } else {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (!text.trim()) return failure("INVALID_SOURCE", false, `${file.name} is empty.`, 400);
        contents.push({ text: `SOURCE id=${descriptor.id} role=${descriptor.role} name=${descriptor.name}\n\n${text}` });
      }
    }
    console.info(`Source bundle selected: sources=${typedFiles.length}, pdfs=${descriptors.filter(s => s.mimeType === "application/pdf").length}, txt=${descriptors.filter(s => s.mimeType === "text/plain").length}, totalBytes=${totalBytes}`);
    if (diagnosticStage === "source-probe" || diagnosticStage === "count-tokens") {
      const model = selectedDiagnosticModel!;
      const pdfCount = descriptors.filter((source) => source.mimeType === "application/pdf").length;
      const txtCount = descriptors.filter((source) => source.mimeType === "text/plain").length;
      contents[0] = { text: diagnosticStage === "source-probe" ? sourceProbePrompt(descriptors) : sourceUnderstandingPrompt(descriptors) };
      const startedAt = Date.now();
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
      if (diagnosticStage === "count-tokens") {
        try {
          const response = await client.models.countTokens({ model, contents });
          const elapsedMs = Date.now() - startedAt;
          const inputTokens = response.totalTokens ?? "unknown";
          diagnosticLog({ stage: "input-token-count", model, sourceCount: descriptors.length, pdfCount, txtCount,
            sourceBytes: totalBytes, elapsedMs, result: "success", inputTokens });
          return NextResponse.json({ model, inputTokens, diagnostic: { elapsedMs } }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          const classified = classify(error); const provider = safeProviderErrorDetails(error);
          const elapsedMs = Date.now() - startedAt;
          diagnosticLog({ stage: "input-token-count", model, sourceCount: descriptors.length, pdfCount, txtCount,
            sourceBytes: totalBytes, elapsedMs, result: "failure", ...providerLogFields(provider) });
          return NextResponse.json({ code: classified.code, retryable: classified.retryable,
            message: "The diagnostic input-token count failed.", diagnostic: { model, elapsedMs,
              ...provider } }, { status: classified.status });
        }
      }
      try {
        const response = await client.models.generateContent({ model, contents, config: {
          maxOutputTokens: 256, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, responseMimeType: "application/json",
          responseJsonSchema: sourceProbeSchema,
        } });
        const probe = JSON.parse(response.text || "{}") as Record<string, unknown>;
        if (typeof probe.sourceCount !== "number" || typeof probe.canReadSources !== "boolean" ||
            !Array.isArray(probe.briefTopics) || probe.briefTopics.length > 3) throw new Error("Invalid source probe returned");
        const elapsedMs = Date.now() - startedAt;
        const usage = usageFields(response);
        diagnosticLog({ stage: "source-probe", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, elapsedMs, result: "success", ...usage });
        return NextResponse.json({ probe, model, diagnostic: { elapsedMs, ...usage } }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const classified = classify(error); const provider = safeProviderErrorDetails(error);
        const elapsedMs = Date.now() - startedAt;
        diagnosticLog({ stage: "source-probe", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, elapsedMs, result: "failure", ...providerLogFields(provider),
          inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" });
        return NextResponse.json({ code: classified.code, retryable: classified.retryable,
          message: "The diagnostic source probe failed.", diagnostic: { model, elapsedMs,
            ...provider,
            inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" } }, { status: classified.status });
      }
    }
    if (diagnosticStage === "compact-source") {
      const model = selectedDiagnosticModel!;
      const pdfCount = descriptors.filter((source) => source.mimeType === "application/pdf").length;
      const txtCount = descriptors.filter((source) => source.mimeType === "text/plain").length;
      contents[0] = { text: compactSourcePrompt(descriptors) };
      const startedAt = Date.now();
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
      try {
        const response = await client.models.generateContent({ model, contents, config: {
          maxOutputTokens: 16_384, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, responseMimeType: "application/json",
          responseJsonSchema: compactSourceSchema,
        } });
        const artifact = JSON.parse(response.text || "{}") as Record<string, unknown>;
        const artifactSources = Array.isArray(artifact.sources)
          ? artifact.sources.filter((source): source is Record<string, unknown> => Boolean(source) && typeof source === "object" && !Array.isArray(source)) : [];
        const identitiesMatch = descriptors.every((descriptor) => artifactSources.some((source) =>
          source.sourceId === descriptor.id && source.name === descriptor.name && source.role === descriptor.role &&
          source.mimeType === descriptor.mimeType && Array.isArray(source.pages) && Array.isArray(source.sections)
        ));
        if (artifact.version !== 1 || artifactSources.length !== descriptors.length || !identitiesMatch) {
          throw new Error("Invalid compact source artifact returned");
        }
        const artifactPageCount = artifactSources.reduce((sum, source) => {
          const pages = source.mimeType === "application/pdf" ? source.pages : [];
          return sum + (Array.isArray(pages) ? pages.length : 0);
        }, 0);
        const artifactText = JSON.stringify(artifact);
        const elapsedMs = Date.now() - startedAt;
        const usage = usageFields(response);
        diagnosticLog({ stage: "compact-source-extraction", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, elapsedMs, result: "success", ...usage,
          artifactSourceCount: artifactSources.length, artifactPageCount, artifactChars: artifactText.length });
        return NextResponse.json({ artifact, model, diagnostic: { elapsedMs, ...usage,
          artifactSourceCount: artifactSources.length, artifactPageCount, artifactChars: artifactText.length } },
        { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const classified = classify(error); const provider = safeProviderErrorDetails(error);
        const elapsedMs = Date.now() - startedAt;
        diagnosticLog({ stage: "compact-source-extraction", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, elapsedMs, result: "failure", ...providerLogFields(provider),
          inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" });
        return NextResponse.json({ code: classified.code, retryable: classified.retryable,
          message: "The diagnostic compact source extraction failed.", diagnostic: { model, elapsedMs,
            ...provider,
            inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" } }, { status: classified.status });
      }
    }
    if (diagnosticStage === "single-page-compact") {
      const model = selectedDiagnosticModel!;
      const params = new URL(request.url).searchParams;
      const requestedSourceId = params.get("sourceId") ?? "";
      const requestedPageText = params.get("page") ?? "";
      const requestedPage = Number(requestedPageText);
      const requestedSource = descriptors.find((source) => source.id === requestedSourceId && source.mimeType === "application/pdf");
      if (!requestedSource || !/^\d+$/.test(requestedPageText) || !Number.isSafeInteger(requestedPage) || requestedPage < 1) {
        return failure("INVALID_SOURCE", false, "Select a PDF source and a positive physical page number.", 400);
      }
      const pdfCount = descriptors.filter((source) => source.mimeType === "application/pdf").length;
      const txtCount = descriptors.filter((source) => source.mimeType === "text/plain").length;
      contents[0] = { text: singlePageCompactPrompt(descriptors, requestedSourceId, requestedPage) };
      const startedAt = Date.now();
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
      try {
        const response = await client.models.generateContent({ model, contents, config: {
          maxOutputTokens: 1_024, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, responseMimeType: "application/json",
          responseJsonSchema: singlePageCompactSchema,
        } });
        const artifact = JSON.parse(response.text || "{}") as Record<string, unknown>;
        if (artifact.sourceId !== requestedSourceId || artifact.page !== requestedPage) {
          throw new Error("Invalid single-page compact artifact returned");
        }
        const artifactChars = JSON.stringify(artifact).length;
        const elapsedMs = Date.now() - startedAt;
        const usage = usageFields(response);
        diagnosticLog({ stage: "single-page-compact", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, requestedSourceId, requestedPage, elapsedMs, result: "success", ...usage, artifactChars });
        return NextResponse.json({ artifact, model, diagnostic: { requestedSourceId, requestedPage, elapsedMs, ...usage, artifactChars } },
          { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const classified = classify(error); const provider = safeProviderErrorDetails(error);
        const elapsedMs = Date.now() - startedAt;
        diagnosticLog({ stage: "single-page-compact", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, requestedSourceId, requestedPage, elapsedMs, result: "failure",
          ...providerLogFields(provider),
          inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" });
        return NextResponse.json({ code: classified.code, retryable: classified.retryable,
          message: "The diagnostic single-page compact extraction failed.", diagnostic: { model, requestedSourceId,
            requestedPage, elapsedMs, ...provider,
            inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" } }, { status: classified.status });
      }
    }
    if (diagnosticStage === "page-probe") {
      const model = selectedDiagnosticModel!;
      const params = new URL(request.url).searchParams;
      const requestedSourceId = params.get("sourceId") ?? "";
      const requestedPageText = params.get("page") ?? "";
      const requestedPage = Number(requestedPageText);
      const requestedSource = descriptors.find((source) => source.id === requestedSourceId && source.mimeType === "application/pdf");
      if (!requestedSource || !/^\d+$/.test(requestedPageText) || !Number.isSafeInteger(requestedPage) || requestedPage < 1) {
        return failure("INVALID_SOURCE", false, "Select a PDF source and a positive physical page number.", 400);
      }
      const pdfCount = descriptors.filter((source) => source.mimeType === "application/pdf").length;
      const txtCount = descriptors.filter((source) => source.mimeType === "text/plain").length;
      contents[0] = { text: pageProbePrompt(descriptors, requestedSourceId, requestedPage) };
      const startedAt = Date.now();
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
      try {
        const response = await client.models.generateContent({ model, contents, config: {
          maxOutputTokens: 256, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, responseMimeType: "application/json",
          responseJsonSchema: pageProbeSchema,
        } });
        const probe = JSON.parse(response.text || "{}") as Record<string, unknown>;
        if (typeof probe.canReadPage !== "boolean" || typeof probe.briefSummary !== "string") {
          throw new Error("Invalid page probe returned");
        }
        const elapsedMs = Date.now() - startedAt;
        const usage = usageFields(response);
        diagnosticLog({ stage: "page-probe", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, requestedSourceId, requestedPage, elapsedMs, result: "success", ...usage,
          canReadPage: String(probe.canReadPage) });
        return NextResponse.json({ probe, model, diagnostic: { requestedSourceId, requestedPage, elapsedMs, ...usage } },
          { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const classified = classify(error); const provider = safeProviderErrorDetails(error);
        const elapsedMs = Date.now() - startedAt;
        diagnosticLog({ stage: "page-probe", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, requestedSourceId, requestedPage, elapsedMs, result: "failure",
          ...providerLogFields(provider),
          inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" });
        return NextResponse.json({ code: classified.code, retryable: classified.retryable,
          message: "The diagnostic page probe failed.", diagnostic: { model, requestedSourceId, requestedPage,
            elapsedMs, ...provider,
            inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" } }, { status: classified.status });
      }
    }
    if (diagnosticStage === "source") {
      const model = selectedDiagnosticModel!;
      const pdfCount = descriptors.filter((source) => source.mimeType === "application/pdf").length;
      const txtCount = descriptors.filter((source) => source.mimeType === "text/plain").length;
      contents[0] = { text: sourceUnderstandingPrompt(descriptors) };
      const startedAt = Date.now();
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
      try {
        const response = await client.models.generateContent({ model, contents, config: {
          maxOutputTokens: 32_768, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }, responseMimeType: "application/json",
          responseJsonSchema: diagnosticSourceSchema,
        } });
        const artifact = JSON.parse(response.text || "{}") as unknown;
        if (!validDiagnosticArtifact(artifact, descriptors)) throw new Error("Invalid structured source artifact returned");
        const elapsedMs = Date.now() - startedAt;
        const usage = usageFields(response);
        diagnosticLog({ stage: "source-understanding", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, elapsedMs, result: "success", ...usage });
        const artifactSources = descriptors.map(({ storagePath: _storagePath, ...descriptor }) => descriptor);
        return NextResponse.json({ artifact, sources: artifactSources, model, diagnostic: { elapsedMs, ...usage } },
          { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const classified = classify(error); const provider = safeProviderErrorDetails(error);
        const elapsedMs = Date.now() - startedAt;
        diagnosticLog({ stage: "source-understanding", model, sourceCount: descriptors.length, pdfCount, txtCount,
          sourceBytes: totalBytes, elapsedMs, result: "failure",
          ...providerLogFields(provider),
          inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" });
        return NextResponse.json({ code: classified.code, retryable: classified.retryable,
          message: "The diagnostic source-understanding stage failed.", diagnostic: { model, elapsedMs,
            ...provider,
            inputTokens: "unknown", outputTokens: "unknown", totalTokens: "unknown" } }, { status: classified.status });
      }
    }
    console.info(`Lesson source preprocessing started: sources=${typedFiles.length}`);
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    let lastFailure: ReturnType<typeof classify> | null = null;
    try {
      for (const [index, model] of MODELS.entries()) {
        console.info(`Preprocessing model attempt: model=${model}, attempt=${index + 1}/${MODELS.length}`);
        const attemptStartedAt = Date.now();
        try {
          const response = await client.models.generateContent({ model, contents, config: {
            abortSignal: controller.signal, maxOutputTokens: 32_768, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: {
              lessonTitle: { type: "string" }, structuredSource: { type: "string" }, lessonTree: lessonTreeSchema,
            }, required: ["lessonTitle", "structuredSource", "lessonTree"], additionalProperties: false },
          } });
          const parsed = JSON.parse(response.text || "{}") as Record<string, unknown>;
          const rawMetrics = measureRawLessonTree(parsed.lessonTree);
          console.info(
            `PREPROCESSING RAW RESULT: model=${model}, rootCount=${rawMetrics.rootCount}, nodeCount=${rawMetrics.nodeCount}, ` +
            `leafCount=${rawMetrics.leafCount}, nodesWithChildren=${rawMetrics.nodesWithChildren}, maxDepth=${rawMetrics.maxDepth}, ` +
            `nodesWithTeachingContract=${rawMetrics.nodesWithTeachingContract}, totalTeachingPoints=${rawMetrics.totalTeachingPoints}, ` +
            `totalCompletionCriteria=${rawMetrics.totalCompletionCriteria}, nodesWithSourceReferences=${rawMetrics.nodesWithSourceReferences}, ` +
            `nodesWithPointSourceReferences=${rawMetrics.nodesWithPointSourceReferences}, deliveryUnitsPresent=${rawMetrics.deliveryUnitsPresent}, ` +
            `depthDistribution={${formatDepthDistribution(rawMetrics.depthDistribution)}}`,
          );
          const structuredText = typeof parsed.structuredSource === "string" ? parsed.structuredSource.trim() : "";
          const lessonTitle = typeof parsed.lessonTitle === "string" ? parsed.lessonTitle.trim().slice(0, 160) : "";
          const normalizationDiagnostics = createLessonTreeNormalizationDiagnostics();
          const lessonTree = normalizeLessonTree(
            parsed.lessonTree,
            new Set(descriptors.map((source) => source.id)),
            normalizationDiagnostics,
          );
          const normalizedMetrics = measureNormalizedLessonTree(lessonTree);
          console.info(
            `PREPROCESSING NORMALIZED RESULT: model=${model}, rootCount=${normalizedMetrics.rootCount}, nodeCount=${normalizedMetrics.nodeCount}, ` +
            `leafCount=${normalizedMetrics.leafCount}, canonicalTeachableNodeCount=${normalizedMetrics.canonicalTeachableNodeCount}, ` +
            `structuralNodeCount=${normalizedMetrics.structuralNodeCount}, maxDepth=${normalizedMetrics.maxDepth}, ` +
            `nodesWithTeachingContract=${normalizedMetrics.nodesWithTeachingContract}, totalTeachingPoints=${normalizedMetrics.totalTeachingPoints}, ` +
            `totalCompletionCriteria=${normalizedMetrics.totalCompletionCriteria}, nodesWithSourceReferences=${normalizedMetrics.nodesWithSourceReferences}, ` +
            `nodesWithPointSourceReferences=${normalizedMetrics.nodesWithPointSourceReferences}, validDeliveryUnitCount=${normalizationDiagnostics.validDeliveryUnitCount}, ` +
            `fallbackDeliveryUnitCount=${normalizationDiagnostics.fallbackDeliveryUnitCount}, ` +
            `depthDistribution={${formatDepthDistribution(normalizedMetrics.depthDistribution)}}, ` +
            `canonicalIneligible={hasChildrenOnly:${normalizedMetrics.canonicalIneligibility.hasChildrenOnly},` +
            `noTeachingContract:${normalizedMetrics.canonicalIneligibility.noTeachingContract},emptyTeachingPoints:${normalizedMetrics.canonicalIneligibility.emptyTeachingPoints},` +
            `invalidContract:${normalizationDiagnostics.contractsDropped}}, suspiciouslyShallow=${normalizedMetrics.suspiciouslyShallow}`,
          );
          if (rawMetrics.nodeCount !== normalizedMetrics.nodeCount || normalizationDiagnostics.contractsDropped ||
              normalizationDiagnostics.contractsRemovedFromStructuralNodes || normalizationDiagnostics.invalidSourceRefsRemoved ||
              normalizationDiagnostics.invalidDeliveryUnitsFellBack || normalizationDiagnostics.malformedNodesRejected) {
            console.info(`PREPROCESSING NORMALIZATION LOSS: model=${model}, ${formatNormalizationLoss(rawMetrics.nodeCount, normalizedMetrics.nodeCount, normalizationDiagnostics)}`);
          }
          if (!structuredText || !lessonTree.length) throw new Error("No structured content returned");
          console.info(`Bundle preprocessing completed: model=${model}, sources=${typedFiles.length}, elapsedMs=${Date.now() - attemptStartedAt}`);
          return NextResponse.json({ lessonTitle, structuredText, lessonTree, model }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          lastFailure = classify(error);
          const fallback = lastFailure.retryable && index < MODELS.length - 1 && !controller.signal.aborted;
          const provider = safeProviderErrorDetails(error);
          console.warn(
            `Bundle preprocessing failed: model=${model}, category=${lastFailure.code.toLowerCase()}, ` +
            `httpStatus=${provider.httpStatus}, providerStatus=${provider.providerStatus}, providerCode=${provider.providerCode}, providerErrorClass=${provider.sdkErrorClass}, ` +
            `elapsedMs=${Date.now() - attemptStartedAt}, fallback=${fallback ? "yes" : "no"}`,
          );
          if (!fallback) throw error;
        }
      }
    } finally { clearTimeout(timer); }
    throw new Error("Source processing failed");
  } catch (error) {
    const classified = classify(error);
    console.error(`Lesson source preprocessing failed: category=${classified.code.toLowerCase()}`);
    return failure(classified.code, classified.retryable, classified.retryable ? "We couldn't process this source bundle right now. Please retry." : "The source bundle could not be processed.", classified.status);
  }
}
