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

const MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"] as const;
const MODEL_TIMEOUT_MS = 180_000;
const OPERATION_TIMEOUT_MS = 300_000;

type SourceDescriptor = Pick<LessonSource, "id" | "name" | "mimeType" | "sizeBytes" | "role"> & {
  storagePath?: string;
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
  const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
  const status = [record.status, record.statusCode, nested.status, nested.statusCode]
    .find((value) => typeof value === "number");
  const code = [record.code, nested.code].find((value) => typeof value === "string" || typeof value === "number");
  const name = error instanceof Error ? error.name : typeof record.name === "string" ? record.name : undefined;
  return {
    httpStatus: status ?? "unavailable",
    providerCode: code === undefined ? "unavailable" : String(code).slice(0, 80),
    providerErrorClass: name?.slice(0, 80) || "unavailable",
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

function safeFilename(value: string) {
  const cleaned = value.split(/[\\/]/).at(-1)?.normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return cleaned || "source";
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return failure("UNKNOWN", false, "Source processing is unavailable.", 500);
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
            `httpStatus=${provider.httpStatus}, providerCode=${provider.providerCode}, providerErrorClass=${provider.providerErrorClass}, ` +
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
