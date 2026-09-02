import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { NextResponse } from "next/server";
import { MAX_SOURCE_BYTES } from "../../../lib/learning-source";
import { normalizeLessonTree } from "../../../lib/lesson-outline";
import type {
  SourceProcessingErrorCode,
  SourceProcessingErrorResponse,
} from "../../../lib/source-processing-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PDF_PROCESSING_MODELS = [
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
] as const;
const PDF_PREPROCESSING_TIMEOUT_MS = 180_000;
const PDF_PROCESSING_OPERATION_TIMEOUT_MS = 300_000;

function errorResponse(
  code: SourceProcessingErrorCode,
  retryable: boolean,
  message: string,
  status: number,
) {
  return NextResponse.json<SourceProcessingErrorResponse>(
    { code, retryable, message },
    { status },
  );
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    const details = error as Error & { status?: unknown; code?: unknown };
    return [error.message, details.status, details.code]
      .filter((value) => value !== undefined)
      .join(" ");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function classifyProviderFailure(error: unknown): {
  code: SourceProcessingErrorCode;
  retryable: boolean;
  message: string;
  status: number;
  retryDelayMs?: number;
} {
  const detail = describeError(error);
  const retryDelaySeconds = detail.match(/retryDelay[^\d]*([\d.]+)s/i)?.[1];
  const retryDelayMs = retryDelaySeconds
    ? Math.round(Number(retryDelaySeconds) * 1_000)
    : undefined;
  if (/429|RESOURCE_EXHAUSTED|quota exceeded|quotaMetric|free_tier/i.test(detail)) {
    const quotaExhausted = /quota exceeded|quotaMetric|free_tier|per.model|requests_per_day/i.test(detail);
    return {
      code: quotaExhausted ? "QUOTA_EXHAUSTED" : "RATE_LIMITED",
      retryable: true,
      message: "Available PDF processing capacity has been reached temporarily.",
      status: 429,
      retryDelayMs,
    };
  }
  if (/503|UNAVAILABLE|high demand|temporar(?:y|ily) unavailable|overload/i.test(detail)) {
    return {
      code: "TEMPORARY_UNAVAILABLE",
      retryable: true,
      message: "Gemini is temporarily busy and could not process this source yet.",
      status: 503,
    };
  }
  if (/499|CANCELLED|aborted|abort|timeout|timed out|deadline/i.test(detail)) {
    return {
      code: "PROCESSING_TIMEOUT",
      retryable: true,
      message: "PDF processing took longer than expected.",
      status: 504,
    };
  }
  if (/no structured content/i.test(detail)) {
    return {
      code: "UNKNOWN",
      retryable: false,
      message: "The PDF could not be converted into usable lesson material.",
      status: 422,
    };
  }
  return {
    code: "UNKNOWN",
    retryable: false,
    message: "The PDF could not be processed.",
    status: 500,
  };
}

async function preprocessWithModel(
  client: GoogleGenAI,
  model: (typeof PDF_PROCESSING_MODELS)[number],
  bytes: ArrayBuffer,
  filename: string,
  abortSignal: AbortSignal,
) {
  const response = await client.models.generateContent({
    model,
    contents: [
      { text: buildPreprocessingPrompt(filename) },
      {
        inlineData: {
          mimeType: "application/pdf",
          data: Buffer.from(bytes).toString("base64"),
        },
      },
    ],
    config: {
      abortSignal,
      maxOutputTokens: 32_768,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          structuredSource: { type: "string" },
          lessonTree: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                parentId: { type: ["string", "null"] },
                order: { type: "integer" },
                sourceReference: { type: "string" },
                teaching: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["overview", "concept", "definition", "procedure", "worked-example", "comparison", "summary"],
                    },
                    importance: {
                      type: "string",
                      enum: ["core", "supporting", "optional"],
                    },
                    objective: { type: "string" },
                    teachingPoints: { type: "array", items: { type: "string" } },
                    completionCriteria: { type: "array", items: { type: "string" } },
                    sourceReferences: { type: "array", items: { type: "string" } },
                    keyTerms: { type: "array", items: { type: "string" } },
                    notation: { type: "array", items: { type: "string" } },
                    sourceConfidence: { type: "string", enum: ["clear", "uncertain"] },
                    uncertaintyNote: { type: "string" },
                  },
                  required: ["type", "importance", "objective", "teachingPoints", "completionCriteria"],
                  additionalProperties: false,
                },
              },
              required: ["id", "title", "parentId", "order"],
              additionalProperties: false,
            },
          },
        },
        required: ["structuredSource", "lessonTree"],
        additionalProperties: false,
      },
    },
  });
  const parsed = JSON.parse(response.text || "{}") as {
    structuredSource?: unknown;
    lessonTree?: unknown;
  };
  const structuredText =
    typeof parsed.structuredSource === "string"
      ? parsed.structuredSource.trim()
      : "";
  const lessonTree = normalizeLessonTree(parsed.lessonTree);
  if (!structuredText || lessonTree.length === 0) {
    throw new Error("The document model returned no structured content");
  }
  return { structuredText, lessonTree };
}

function buildPreprocessingPrompt(filename: string) {
  return `You are converting an educational PDF into a faithful structured representation for another AI tutor.

Do NOT produce a short summary. Preserve enough detail for a realtime tutor to teach the document accurately and answer detailed learner questions.

Source filename: ${filename}

Preserve, in source order:
- page or slide ordering and identifiable page/slide numbers
- document title and main topics
- headings, subheadings, and important bullet points
- definitions and lecturer-specific terminology
- equations and notation exactly as shown, including symbol definitions
- worked examples and their steps
- warnings, assumptions, exceptions, and conclusions
- important table row/column relationships
- diagrams, graphs, charts, and meaningful slide layout

For every meaningful diagram or visual, describe the objects, labels, arrows, axes, directions, spatial relationships, and the concept being communicated. For tables, preserve important row/column relationships rather than merely noting that a table exists.

Do not silently rewrite mathematical notation. Do not invent unreadable content. Mark uncertain interpretations explicitly.

Use this structure where applicable:

DOCUMENT
Title:
Filename: ${filename}
Main topic(s):

[Page/Slide <identifier>]
Title:
Section/topic:
Important text:
Key concepts:
Definitions:
Equations and symbol definitions:
Examples and worked steps:
Tables and relationships:
Diagram/visual description:
Warnings/exceptions:
Teaching significance:

Continue through all relevant material.

Return JSON with exactly two fields:
- structuredSource: the complete faithful representation described above
- lessonTree: a concise hierarchical tree represented as a flat node array. Each node has id, title, parentId (null for roots), sibling order, and optional sourceReference. Include meaningful teachable units, not every bullet. Parent IDs must reference another node ID. Preserve arbitrary source depth.

Every atomic node (a node with no children) MUST have a compact teaching contract. Structural parents must not have a teaching contract. If a parent has substantial introductory teaching content, add a real atomic Overview child; do not create meaningless Overview nodes.

Each teaching contract must contain:
- type: overview, concept, definition, procedure, worked-example, comparison, or summary
- importance: core, supporting, or optional
- one short objective describing what the tutor should explain, never learner understanding
- 3-7 source-derived teachingPoints where appropriate
- 2-5 completionCriteria describing what the tutor must have covered, never what the learner understands
- concise sourceReferences, keyTerms, and notation only when useful
- sourceConfidence clear or uncertain; add uncertaintyNote only for genuinely unclear source material

Contracts are compact teaching plans, not summaries or mini-textbooks. Core completion criteria must not be blocked by optional enrichment. Preserve source terminology and notation exactly. Do not invent page/slide references or unreadable content.`;
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return errorResponse("UNKNOWN", false, "PDF processing is unavailable.", 500);
  }

  try {
    const formData = await request.formData();
    const source = formData.get("source");
    if (!(source instanceof File)) {
      return errorResponse("INVALID_SOURCE", false, "Select a PDF to process.", 400);
    }
    if (source.type !== "application/pdf") {
      return errorResponse("INVALID_SOURCE", false, "Choose a PDF file.", 415);
    }
    if (source.size === 0) {
      return errorResponse("INVALID_SOURCE", false, "The selected PDF is empty.", 400);
    }
    if (source.size > MAX_SOURCE_BYTES) {
      return errorResponse(
        "INVALID_SOURCE",
        false,
        "This file can't be processed because it exceeds the 20 MB source limit.",
        413,
      );
    }

    const bytes = await source.arrayBuffer();
    const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
    if (signature !== "%PDF-") {
      return errorResponse("INVALID_SOURCE", false, "The selected file is not a valid PDF.", 400);
    }

    const filename =
      source.name.split(/[\\/]/).at(-1)?.slice(0, 200) || "Uploaded source.pdf";
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: {
        timeout: PDF_PREPROCESSING_TIMEOUT_MS,
        retryOptions: { attempts: 1 },
      },
    });
    const operationController = new AbortController();
    const operationTimeout = setTimeout(
      () => operationController.abort(),
      PDF_PROCESSING_OPERATION_TIMEOUT_MS,
    );
    const cancelForDisconnectedClient = () => operationController.abort();
    request.signal.addEventListener("abort", cancelForDisconnectedClient, { once: true });
    let lastFailure: ReturnType<typeof classifyProviderFailure> | null = null;
    let modelsTried = 0;
    try {
      for (const [index, model] of PDF_PROCESSING_MODELS.entries()) {
        if (operationController.signal.aborted) break;
        modelsTried += 1;
        console.info(
          `PDF preprocessing model attempt: model=${model}, ` +
          `attempt=${index + 1}/${PDF_PROCESSING_MODELS.length}`,
        );
        try {
          const prepared = await preprocessWithModel(
            client,
            model,
            bytes,
            filename,
            operationController.signal,
          );
          console.info(
            `PDF preprocessing completed: model=${model}, ` +
            `attempt=${index + 1}/${PDF_PROCESSING_MODELS.length}`,
          );
          return NextResponse.json(
            { ...prepared, model },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          if (request.signal.aborted) throw error;
          const classified = classifyProviderFailure(error);
          lastFailure = classified;
          const nextModel = PDF_PROCESSING_MODELS[index + 1];
          const fallback = classified.retryable && Boolean(nextModel) &&
            !operationController.signal.aborted;
          console.warn(
            `PDF preprocessing model failed: model=${model}, ` +
            `type=${classified.code.toLowerCase().replaceAll("_", "-")}, ` +
            `fallback=${fallback ? "yes" : "no"}` +
            (classified.retryDelayMs ? `, retryDelayMs=${classified.retryDelayMs}` : ""),
          );
          if (!fallback) throw error;
          console.info(`PDF preprocessing fallback: from=${model}, to=${nextModel}`);
        }
      }
      throw new Error("PDF processing operation timed out");
    } catch (error) {
      if (request.signal.aborted) throw error;
      if (lastFailure?.retryable) {
        console.warn(
          `PDF preprocessing fallback pool exhausted: modelsTried=${modelsTried}`,
        );
        return errorResponse(
          lastFailure.code,
          true,
          "We couldn't process this source right now. Gemini is temporarily busy or the available processing capacity has been reached.",
          lastFailure.status,
        );
      }
      throw error;
    } finally {
      clearTimeout(operationTimeout);
      request.signal.removeEventListener("abort", cancelForDisconnectedClient);
    }
  } catch (error) {
    const message = describeError(error);
    const classified = classifyProviderFailure(error);
    console.error(
      "Gemini PDF preprocessing failed:",
      message,
    );
    return errorResponse(
      classified.code,
      classified.retryable,
      classified.message,
      classified.status,
    );
  }
}
