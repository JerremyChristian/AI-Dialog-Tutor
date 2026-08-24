import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { NextResponse } from "next/server";
import { normalizeLessonTree } from "../../../lib/lesson-outline";
import { MAX_SOURCE_BYTES } from "../../../lib/learning-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    if (!(source instanceof File) || source.type !== "text/plain") {
      return NextResponse.json({ error: "Select a plain text source" }, { status: 400 });
    }
    if (source.size === 0 || source.size > MAX_SOURCE_BYTES) {
      return NextResponse.json({ error: "Text source must be between 1 byte and 20 MB" }, { status: 400 });
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await source.arrayBuffer(),
    );
    const client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60_000 } });
    const response = await client.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: [{
        text: `Extract a concise hierarchical lesson tree from the educational text below. Return a flat node array where each node has id, title, parentId (null for roots), sibling order, and optional sourceReference. Preserve arbitrary source depth and the real teaching sequence. Return meaningful teachable concepts, not every heading, paragraph, or bullet.

Every atomic node must have a compact teaching contract containing: type (overview, concept, definition, procedure, worked-example, comparison, or summary), importance (core, supporting, or optional), one short objective, approximately 3-7 source-derived teachingPoints, and 2-5 completionCriteria describing what the tutor must cover rather than learner understanding. Include concise sourceReferences, keyTerms, notation, and sourceConfidence only as useful. Use uncertaintyNote only when source material is genuinely unclear. Structural parents must not have teaching contracts. Add an Overview child only when a parent has substantial introductory content. Contracts are teaching plans, not summaries. Do not invent topics, notation, or source references.\n\nSOURCE_FILENAME: ${source.name}\n\n${text}`,
      }],
      config: {
        maxOutputTokens: 8_192,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
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
          required: ["lessonTree"],
          additionalProperties: false,
        },
      },
    });
    const parsed = JSON.parse(response.text || "{}") as { lessonTree?: unknown };
    const lessonTree = normalizeLessonTree(parsed.lessonTree);
    if (lessonTree.length === 0) throw new Error("No lesson tree returned");
    return NextResponse.json({ lessonTree }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(
      "Gemini TXT outline extraction failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "Gemini could not create a lesson outline from the text source" },
      { status: 502 },
    );
  }
}
