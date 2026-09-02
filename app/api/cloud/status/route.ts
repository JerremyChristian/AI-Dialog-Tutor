import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json({ configured: false, authenticated: false });
  }

  const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !claimsData?.claims?.sub) {
    return NextResponse.json(
      { configured: true, authenticated: false },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const { count, error } = await supabase
    .from("lessons")
    .select("id", { count: "exact", head: true });

  if (error) {
    console.warn("Cloud unavailable: lessons-query-failed");
    return NextResponse.json(
      {
        configured: true,
        authenticated: true,
        connected: false,
        error: "cloud-unavailable",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      configured: true,
      authenticated: true,
      connected: true,
      cloudLessonCount: count ?? 0,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
