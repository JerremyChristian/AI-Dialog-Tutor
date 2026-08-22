import { GoogleGenAI, Modality } from "@google/genai";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "gemini-3.1-flash-live-preview";
const SYSTEM_INSTRUCTION =
  "You are a friendly conversational tutor. Have a natural spoken conversation with the learner. Keep responses concise and conversational. Do not start teaching a structured course yet.";

export async function POST() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  try {
    const client = new GoogleGenAI({ apiKey });
    const now = Date.now();
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        newSessionExpireTime: new Date(now + 60_000).toISOString(),
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: SYSTEM_INSTRUCTION,
          },
        },
      },
    });

    if (!token.name) {
      throw new Error("Gemini did not return an ephemeral token");
    }

    return NextResponse.json(
      { token: token.name },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Failed to create a Gemini ephemeral token", error);
    return NextResponse.json(
      { error: "Unable to create a Gemini Live token" },
      { status: 502 },
    );
  }
}
