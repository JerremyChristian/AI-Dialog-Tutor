import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { NextResponse } from "next/server";
import { MAX_SOURCE_BYTES } from "../../../lib/learning-source";
import { normalizeLessonTree } from "../../../lib/lesson-outline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PDF_PREPROCESSING_MODEL = "gemini-3.6-flash";
const PDF_PREPROCESSING_TIMEOUT_MS = 120_000;

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
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  try {
    const formData = await request.formData();
    const source = formData.get("source");
    if (!(source instanceof File)) {
      return NextResponse.json({ error: "Select a PDF to process" }, { status: 400 });
    }
    if (source.type !== "application/pdf") {
      return NextResponse.json(
        { error: "PDF preprocessing accepts application/pdf only" },
        { status: 415 },
      );
    }
    if (source.size === 0) {
      return NextResponse.json({ error: "The selected PDF is empty" }, { status: 400 });
    }
    if (source.size > MAX_SOURCE_BYTES) {
      return NextResponse.json(
        { error: "The selected PDF exceeds the 20 MB proof-of-concept limit" },
        { status: 413 },
      );
    }

    const bytes = await source.arrayBuffer();
    const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
    if (signature !== "%PDF-") {
      return NextResponse.json(
        { error: "The selected file is not a valid PDF" },
        { status: 400 },
      );
    }

    const filename =
      source.name.split(/[\\/]/).at(-1)?.slice(0, 200) || "Uploaded source.pdf";
    const client = new GoogleGenAI({
      apiKey,
      httpOptions: { timeout: PDF_PREPROCESSING_TIMEOUT_MS },
    });
    const response = await client.models.generateContent({
      model: PDF_PREPROCESSING_MODEL,
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

    return NextResponse.json(
      { structuredText, lessonTree, model: PDF_PREPROCESSING_MODEL },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(
      "Gemini PDF preprocessing failed:",
      message,
    );
    return NextResponse.json(
      {
        error: /timeout|timed out|deadline/i.test(message)
          ? "PDF preprocessing timed out. Try again or use a smaller PDF."
          : "Gemini could not preprocess the PDF learning material",
      },
      { status: 502 },
    );
  }
}
