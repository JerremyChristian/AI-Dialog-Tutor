"use client";

import type { User } from "@supabase/supabase-js";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudSyncState } from "../lib/cloud-sync";
import { createSupabaseBrowserClient } from "../lib/supabase/client";

type CloudStatus = { connected: boolean; cloudLessonCount?: number };
type Props = {
  onDebug?: (message: string) => void;
  onAuthResolved?: (user: User | null) => void;
  onBeforeSignOut?: () => Promise<void>;
  syncState?: CloudSyncState;
  cloudLessonCount?: number;
  localOnlyLessonCount?: number;
  onSyncNow?: () => void;
  onImportLocalLessons?: () => void;
};

function friendlyAuthError(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("invalid login credentials")) return "The email or password is incorrect.";
  if (value.includes("email not confirmed")) return "Confirm your email before signing in.";
  if (value.includes("already registered")) return "An account already exists for this email.";
  if (value.includes("password")) return message;
  return "Cloud authentication is unavailable right now. Local learning still works.";
}

function friendlyPasswordResetRequestError(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("rate") || value.includes("too many")) return "Please wait before requesting another reset link.";
  if (value.includes("email")) return "Enter a valid email address.";
  return "We couldn't send a reset link right now. Please try again.";
}

export default function CloudAccount({
  onDebug,
  onAuthResolved,
  onBeforeSignOut,
  syncState = "local-only",
  cloudLessonCount,
  localOnlyLessonCount = 0,
  onSyncNow,
  onImportLocalLessons,
}: Props) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const debugRef = useRef(onDebug);
  const authResolvedRef = useRef(onAuthResolved);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(supabase));
  const [mode, setMode] = useState<"signin" | "signup" | "forgot" | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CloudStatus | null>(null);

  useEffect(() => {
    debugRef.current = onDebug;
    authResolvedRef.current = onAuthResolved;
  }, [onAuthResolved, onDebug]);

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/cloud/status", { cache: "no-store" });
      const payload = await response.json() as CloudStatus;
      if (!response.ok || !payload.connected) throw new Error("unavailable");
      setStatus(payload);
      debugRef.current?.(`Cloud lesson count loaded: ${payload.cloudLessonCount ?? 0}`);
      debugRef.current?.("Cloud connection verified");
    } catch {
      setStatus({ connected: false });
      debugRef.current?.("Cloud unavailable: connection-check-failed");
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    debugRef.current?.("Supabase configuration detected");
    debugRef.current?.("Supabase authentication initialized");
    let active = true;
    void supabase.auth.getUser().then(({ data, error: authError }) => {
      if (!active) return;
      setUser(data.user ?? null);
      authResolvedRef.current?.(data.user ?? null);
      setChecking(false);
      if (authError) debugRef.current?.("Cloud unavailable: auth-check-failed");
      if (data.user) {
        debugRef.current?.("Cloud user authenticated");
        void loadStatus();
      }
    }).catch(() => {
      if (!active) return;
      setChecking(false);
      setUser(null);
      authResolvedRef.current?.(null);
      debugRef.current?.("Cloud unavailable: auth-check-failed");
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
      authResolvedRef.current?.(session?.user ?? null);
      setChecking(false);
      if (session?.user) {
        debugRef.current?.("Cloud user authenticated");
        void loadStatus();
      } else setStatus(null);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadStatus, supabase]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !mode) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    if (mode === "forgot") {
      try {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password`,
        });
        if (authError) setError(friendlyPasswordResetRequestError(authError.message));
        else setMessage("If an account exists for that email, a password reset link has been sent.");
      } catch {
        setError("We couldn't send a reset link right now. Please try again.");
      }
    } else if (mode === "signup") {
      const { data, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: `${window.location.origin}/auth/confirm` },
      });
      if (authError) setError(friendlyAuthError(authError.message));
      else if (!data.session) setMessage("Check your email to confirm your account, then sign in.");
      else {
        setMessage("Account created and signed in.");
        setMode(null);
      }
    } else {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) setError(friendlyAuthError(authError.message));
      else {
        setMessage("Signed in. Local lessons remain stored on this device.");
        setMode(null);
      }
    }
    setBusy(false);
  };

  const signOut = async () => {
    if (!supabase) return;
    setBusy(true);
    await onBeforeSignOut?.().catch(() => undefined);
    const { error: authError } = await supabase.auth.signOut();
    setBusy(false);
    if (authError) setError("Cloud sign-out failed. Please try again.");
    else {
      setMessage("Signed out. Your local lessons are unchanged.");
      debugRef.current?.("Cloud user signed out");
    }
  };

  const statusText = !supabase
    ? "Not configured"
    : checking
      ? "Checking…"
      : user && syncState === "syncing"
        ? "Syncing…"
        : user && syncState === "synced"
          ? "Synced"
          : user && (syncState === "pending" || syncState === "error")
            ? "Cloud pending"
            : user && status?.connected
              ? "Connected"
              : user
                ? "Connection issue"
                : "Not signed in";

  return (
    <section className="cloud-account setup-only" aria-labelledby="cloud-account-title">
      <div className="cloud-account-heading">
        <div><p className="cloud-kicker">Account</p><h2 id="cloud-account-title">Sign-in and sync</h2></div>
        <span className={`cloud-status ${user && status?.connected ? "connected" : ""}`}>{statusText}</span>
      </div>
      {!supabase && <p className="cloud-note">Local learning is available. Cloud setup is optional.</p>}
      {supabase && !checking && user && (
        <div className="cloud-user">
          <p>Signed in as <strong>{user.email ?? "authenticated user"}</strong></p>
          <p className="cloud-note">
            {status?.connected
              ? `${cloudLessonCount ?? status.cloudLessonCount ?? 0} cloud lessons · ${
                syncState === "pending" || syncState === "error"
                  ? "Saved locally · Cloud pending."
                  : "Local cache is synchronized."
              }`
              : "Cloud status is unavailable. Local lessons are unaffected."}
          </p>
          {localOnlyLessonCount > 0 && (
            <div className="cloud-import">
              <p>{localOnlyLessonCount} local {localOnlyLessonCount === 1 ? "lesson is" : "lessons are"} stored on this device.</p>
              <button type="button" onClick={onImportLocalLessons} disabled={busy || syncState === "syncing"}>
                Sync local lessons to this account
              </button>
            </div>
          )}
          <div className="cloud-actions">
            <button type="button" onClick={onSyncNow} disabled={busy || syncState === "syncing"}>Sync now</button>
            <button type="button" className="secondary" onClick={() => void signOut()} disabled={busy}>Sign out</button>
          </div>
        </div>
      )}
      {supabase && !checking && !user && (
        <>
          <p className="cloud-note">Sign in to sync lessons across devices, upload larger source bundles, and keep in-progress uploads available for recovery. You can still create local lessons without an account.</p>
          {!mode ? (
            <div className="cloud-actions">
              <button type="button" onClick={() => setMode("signin")}>Sign in</button>
              <button type="button" className="secondary" onClick={() => setMode("signup")}>Sign up</button>
            </div>
          ) : (
            <form className="cloud-auth-form" onSubmit={(event) => void submit(event)}>
              <h3>{mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Reset password"}</h3>
              <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
              {mode !== "forgot" && <label>
                Password
                <input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>}
              {mode === "signin" && <button type="button" className="cloud-auth-link" onClick={() => { setMode("forgot"); setError(null); setMessage(null); }} disabled={busy}>Forgot password?</button>}
              <div className="cloud-actions">
                <button type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : mode === "signup" ? "Sign up" : "Send reset link"}</button>
                <button type="button" className="secondary" onClick={() => { setMode(mode === "forgot" ? "signin" : null); setError(null); setMessage(null); }} disabled={busy}>{mode === "forgot" ? "Back to sign in" : "Cancel"}</button>
              </div>
            </form>
          )}
        </>
      )}
      {message && <p className="cloud-message" role="status">{message}</p>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </section>
  );
}
