"use client";

import type { User } from "@supabase/supabase-js";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "../lib/supabase/client";

type CloudStatus = { connected: boolean; cloudLessonCount?: number };
type Props = { onDebug?: (message: string) => void };

function friendlyAuthError(message: string): string {
  const value = message.toLowerCase();
  if (value.includes("invalid login credentials")) return "The email or password is incorrect.";
  if (value.includes("email not confirmed")) return "Confirm your email before signing in.";
  if (value.includes("already registered")) return "An account already exists for this email.";
  if (value.includes("password")) return message;
  return "Cloud authentication is unavailable right now. Local learning still works.";
}

export default function CloudAccount({ onDebug }: Props) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const debugRef = useRef(onDebug);
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(supabase));
  const [mode, setMode] = useState<"signin" | "signup" | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<CloudStatus | null>(null);

  useEffect(() => {
    debugRef.current = onDebug;
  }, [onDebug]);

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
      setChecking(false);
      if (authError) debugRef.current?.("Cloud unavailable: auth-check-failed");
      if (data.user) {
        debugRef.current?.("Cloud user authenticated");
        void loadStatus();
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setUser(session?.user ?? null);
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
    if (mode === "signup") {
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
      : user && status?.connected
        ? "Connected"
        : user
          ? "Connection issue"
          : "Not signed in";

  return (
    <section className="cloud-account setup-only" aria-labelledby="cloud-account-title">
      <div className="cloud-account-heading">
        <div><p className="cloud-kicker">Account</p><h2 id="cloud-account-title">Cloud</h2></div>
        <span className={`cloud-status ${user && status?.connected ? "connected" : ""}`}>{statusText}</span>
      </div>
      {!supabase && <p className="cloud-note">Local learning is available. Cloud setup is optional.</p>}
      {supabase && !checking && user && (
        <div className="cloud-user">
          <p>Signed in as <strong>{user.email ?? "authenticated user"}</strong></p>
          <p className="cloud-note">
            {status?.connected
              ? `${status.cloudLessonCount ?? 0} cloud lessons · Synchronization is not enabled yet.`
              : "Cloud status is unavailable. Local lessons are unaffected."}
          </p>
          <button type="button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
        </div>
      )}
      {supabase && !checking && !user && (
        <>
          <p className="cloud-note">Sign in for the cloud foundation. Lessons remain local in this milestone.</p>
          {!mode ? (
            <div className="cloud-actions">
              <button type="button" onClick={() => setMode("signin")}>Sign in</button>
              <button type="button" className="secondary" onClick={() => setMode("signup")}>Sign up</button>
            </div>
          ) : (
            <form className="cloud-auth-form" onSubmit={(event) => void submit(event)}>
              <h3>{mode === "signin" ? "Sign in" : "Create account"}</h3>
              <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
              <label>
                Password
                <input type="password" autoComplete={mode === "signin" ? "current-password" : "new-password"} minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
              <div className="cloud-actions">
                <button type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Sign up"}</button>
                <button type="button" className="secondary" onClick={() => setMode(null)} disabled={busy}>Cancel</button>
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
