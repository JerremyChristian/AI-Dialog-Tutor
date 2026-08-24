import { GoogleGenAI, Modality } from "@google/genai";
import { NextResponse } from "next/server";
import {
  buildLessonInstruction,
  GEMINI_LIVE_MODEL,
} from "../../../lib/lesson-state";
import { SUPPORTED_SOURCE_TYPES } from "../../../lib/learning-source";

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
    const body = (await request.json()) as {
      topic?: unknown;
      source?: { name?: unknown; mimeType?: unknown };
    };
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (topic.length > 160) {
      return NextResponse.json(
        { error: "Lesson topic cannot exceed 160 characters" },
        { status: 400 },
      );
    }
    const sourceName = body.source?.name;
    const sourceMimeType = body.source?.mimeType;
    if (
      typeof sourceName !== "string" ||
      !sourceName.trim() ||
      sourceName.length > 200 ||
      typeof sourceMimeType !== "string" ||
      !SUPPORTED_SOURCE_TYPES.includes(
        sourceMimeType as (typeof SUPPORTED_SOURCE_TYPES)[number],
      )
    ) {
      return NextResponse.json(
        { error: "Valid learning source metadata is required" },
        { status: 400 },
      );
    }

    const client = new GoogleGenAI({ apiKey });
    const normalizedSourceName = sourceName.trim();
    const systemInstruction = buildLessonInstruction(topic, normalizedSourceName);
    const now = Date.now();
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        liveConnectConstraints: {
          model: GEMINI_LIVE_MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction,
          },
        },
        lockAdditionalFields: [],
      },
    });

    if (!token.name) {
      throw new Error("Gemini did not return an ephemeral token");
    }

    return NextResponse.json(
      {
        token: token.name,
        source: {
          name: normalizedSourceName,
          mimeType: sourceMimeType,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "Failed to create a Gemini ephemeral token:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "Unable to create a Gemini Live token" },
      { status: 502 },
    );
  }
}
