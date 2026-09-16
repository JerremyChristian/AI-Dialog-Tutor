"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "../../lib/supabase/client";

type ResetState = "loading" | "valid" | "invalid" | "success";

function resetError(message: string) {
  const value = message.toLowerCase();
  if (value.includes("password")) return message;
  if (value.includes("session") || value.includes("jwt")) return "This password reset link is invalid or has expired.";
  return "We couldn't update your password. Please try again.";
}

function requestError(message: string) {
  const value = message.toLowerCase();
  if (value.includes("rate") || value.includes("too many")) return "Please wait before requesting another reset link.";
  if (value.includes("email")) return "Enter a valid email address.";
  return "We couldn't send a reset link right now. Please try again.";
}

export default function ResetPasswordPage() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [state, setState] = useState<ResetState>("loading");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [email, setEmail] = useState("");
  const [requestingNewLink, setRequestingNewLink] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) {
      setState("invalid");
      return;
    }
    const callbackStatus = new URLSearchParams(window.location.search).get("cloud");
    if (callbackStatus === "auth-error" || callbackStatus === "not-configured") {
      setState("invalid");
      return;
    }
    let active = true;
    let recoveryEventSeen = false;
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active || event !== "PASSWORD_RECOVERY") return;
      recoveryEventSeen = true;
      setState(session?.user ? "valid" : "invalid");
    });
    void supabase.auth.getUser().then(({ data, error: authError }) => {
      if (!active || recoveryEventSeen) return;
      setState(!authError && data.user && callbackStatus === "confirmed" ? "valid" : "invalid");
    }).catch(() => {
      if (active && !recoveryEventSeen) setState("invalid");
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  const updatePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!supabase || state !== "valid") {
      setState("invalid");
      return;
    }
    if (password.length < 6) {
      setError("Use at least 6 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    const { data: sessionData, error: sessionError } = await supabase.auth.getUser();
    if (sessionError || !sessionData.user) {
      setState("invalid");
      return;
    }
    setBusy(true);
    try {
      const { error: authError } = await supabase.auth.updateUser({ password });
      if (authError) setError(resetError(authError.message));
      else {
        setPassword("");
        setConfirmation("");
        setState("success");
        setMessage("Password updated successfully.");
      }
    } catch {
      setError("We couldn't update your password. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { error: authError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/confirm?next=/reset-password`,
      });
      if (authError) setError(requestError(authError.message));
      else setMessage("If an account exists for that email, a password reset link has been sent.");
    } catch {
      setError("We couldn't send a reset link right now. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return <main className="page-shell"><section className="tutor-card profile-view">
    <section className="cloud-account setup-only" aria-labelledby="reset-password-title">
      <div className="cloud-account-heading"><div><p className="cloud-kicker">Account</p><h1 id="reset-password-title">Reset password</h1></div></div>
      {state === "loading" && <p className="cloud-note" role="status">Checking password reset link…</p>}
      {state === "valid" && <form className="cloud-auth-form" onSubmit={(event) => void updatePassword(event)}>
        <label>New password<input type="password" autoComplete="new-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
        <label>Confirm new password<input type="password" autoComplete="new-password" minLength={6} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
        <div className="cloud-actions"><button type="submit" disabled={busy}>{busy ? "Updating…" : "Reset password"}</button></div>
      </form>}
      {state === "invalid" && <>
        <p className="cloud-error" role="alert">This password reset link is invalid or has expired.</p>
        {!requestingNewLink
          ? <button type="button" className="secondary" onClick={() => setRequestingNewLink(true)}>Request a new reset link</button>
          : <form className="cloud-auth-form" onSubmit={(event) => void requestReset(event)}>
            <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <div className="cloud-actions"><button type="submit" disabled={busy}>{busy ? "Please wait…" : "Send reset link"}</button></div>
          </form>}
      </>}
      {state === "success" && <p><a className="button-primary" href="/">Continue</a></p>}
      {message && <p className="cloud-message" role="status">{message}</p>}
      {error && <p className="cloud-error" role="alert">{error}</p>}
    </section>
  </section></main>;
}
