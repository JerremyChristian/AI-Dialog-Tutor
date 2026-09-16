import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function safeDestination(value: string | null): string {
  return value === "/reset-password" ? value : "/";
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const destination = safeDestination(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    const unavailableUrl = new URL(destination, url.origin);
    unavailableUrl.searchParams.set("cloud", "not-configured");
    return NextResponse.redirect(unavailableUrl);
  }

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const confirmedUrl = new URL(destination, url.origin);
      confirmedUrl.searchParams.set("cloud", "confirmed");
      return NextResponse.redirect(confirmedUrl);
    }
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) {
      const confirmedUrl = new URL(destination, url.origin);
      confirmedUrl.searchParams.set("cloud", "confirmed");
      return NextResponse.redirect(confirmedUrl);
    }
  }

  const errorUrl = new URL(destination, url.origin);
  errorUrl.searchParams.set("cloud", "auth-error");
  return NextResponse.redirect(errorUrl);
}
