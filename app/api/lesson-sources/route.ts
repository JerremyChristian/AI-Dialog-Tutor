import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { NextResponse } from "next/server";
import {
  MAX_LESSON_SOURCES,
  MAX_SOURCE_BUNDLE_BYTES,
  MAX_SOURCE_BYTES,
  SUPPORTED_SOURCE_TYPES,
  type LessonSource,
} from "../../../lib/learning-source";
import { normalizeLessonTree } from "../../../lib/lesson-outline";
import type { SourceProcessingErrorCode, SourceProcessingErrorResponse } from "../../../lib/source-processing-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"] as const;
const MODEL_TIMEOUT_MS = 180_000;
const OPERATION_TIMEOUT_MS = 300_000;

type SourceDescriptor = Pick<LessonSource, "id" | "name" | "mimeType" | "sizeBytes" | "role">;

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
          completionCriteria: { type: "array", items: { type: "string" } },
          sourceReferences: { type: "array", items: sourceReferenceSchema },
          keyTerms: { type: "array", items: { type: "string" } }, notation: { type: "array", items: { type: "string" } },
          sourceConfidence: { type: "string", enum: ["clear", "uncertain"] }, uncertaintyNote: { type: "string" },
        },
        required: ["type", "importance", "objective", "teachingPoints", "completionCriteria"],
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

Use structured sourceReferences with an exact sourceId from the catalog. PDF page is the 1-based physical PDF page index; omit page for TXT and never invent one. Contract-level references are sufficient. Include node references when useful. Do not use opaque filename/page strings as references.`;
}

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) return failure("UNKNOWN", false, "Source processing is unavailable.", 500);
  try {
    const form = await request.formData();
    const descriptors = parseDescriptors(form.get("metadata"));
    const files = form.getAll("sources");
    if (!descriptors || files.length !== descriptors.length || !files.every((file) => file instanceof File)) {
      return failure("INVALID_SOURCE", false, "Select between 1 and 6 PDF or TXT sources.", 400);
    }
    const typedFiles = files as File[];
    let totalBytes = 0;
    const contents: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt(descriptors) }];
    for (const [index, descriptor] of descriptors.entries()) {
      const file = typedFiles[index];
      if (file.type !== descriptor.mimeType || file.name !== descriptor.name || file.size !== descriptor.sizeBytes || file.size > MAX_SOURCE_BYTES) {
        return failure("INVALID_SOURCE", false, "Source metadata does not match the selected files.", 400);
      }
      totalBytes += file.size;
      if (totalBytes > MAX_SOURCE_BUNDLE_BYTES) return failure("INVALID_SOURCE", false, "The source bundle exceeds the 4 MB deployed request limit.", 413);
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
    console.info(`Source bundle selected: sources=${files.length}, pdfs=${descriptors.filter(s => s.mimeType === "application/pdf").length}, txt=${descriptors.filter(s => s.mimeType === "text/plain").length}, totalBytes=${totalBytes}`);
    console.info(`Lesson source preprocessing started: sources=${files.length}`);
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: MODEL_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    let lastFailure: ReturnType<typeof classify> | null = null;
    try {
      for (const [index, model] of MODELS.entries()) {
        console.info(`Preprocessing model attempt: model=${model}, attempt=${index + 1}/${MODELS.length}`);
        try {
          const response = await client.models.generateContent({ model, contents, config: {
            abortSignal: controller.signal, maxOutputTokens: 32_768, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: "application/json", responseJsonSchema: { type: "object", properties: {
              lessonTitle: { type: "string" }, structuredSource: { type: "string" }, lessonTree: lessonTreeSchema,
            }, required: ["lessonTitle", "structuredSource", "lessonTree"], additionalProperties: false },
          } });
          const parsed = JSON.parse(response.text || "{}") as Record<string, unknown>;
          const structuredText = typeof parsed.structuredSource === "string" ? parsed.structuredSource.trim() : "";
          const lessonTitle = typeof parsed.lessonTitle === "string" ? parsed.lessonTitle.trim().slice(0, 160) : "";
          const lessonTree = normalizeLessonTree(parsed.lessonTree, new Set(descriptors.map((source) => source.id)));
          if (!structuredText || !lessonTree.length) throw new Error("No structured content returned");
          console.info(`Bundle preprocessing completed: model=${model}, sources=${files.length}`);
          return NextResponse.json({ lessonTitle, structuredText, lessonTree, model }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          lastFailure = classify(error);
          const fallback = lastFailure.retryable && index < MODELS.length - 1 && !controller.signal.aborted;
          console.warn(`Bundle preprocessing failed: model=${model}, category=${lastFailure.code.toLowerCase()}, fallback=${fallback ? "yes" : "no"}`);
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
