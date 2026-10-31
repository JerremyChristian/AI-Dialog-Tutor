"use client";

import type { FormEvent, RefObject } from "react";
import type { QuickResponse } from "../lib/idle-engagement";
import type { LiveTransportState } from "../lib/live-transport-manager";
import type { TeachingPreferences } from "../lib/teaching-preferences";
import { TeachingStyleControls, capitalize } from "./teaching-style-controls";

export function TeachingRoomHeader({
  title,
  restartDisabled,
  onRequestRestart,
  onEndLesson,
}: {
  title: string;
  restartDisabled: boolean;
  onRequestRestart: () => void;
  onEndLesson: () => void;
}) {
  return <header className="teaching-header"><div><p className="eyebrow">Teaching room</p><h1 id="page-title">{title}</h1></div><div className="teaching-header-actions"><button className="button-secondary" type="button" disabled={restartDisabled} onClick={onRequestRestart}>Restart Lesson</button><button className="button-danger end-lesson-top" type="button" aria-label="End lesson" onClick={onEndLesson}><span className="end-lesson-desktop">End Lesson</span><span className="end-lesson-mobile" aria-hidden="true">End</span></button></div></header>;
}

export function ActiveLessonSummary({
  sourceName,
  conceptTitle,
  teachingPreferences,
}: {
  sourceName: string;
  conceptTitle: string | undefined;
  teachingPreferences: TeachingPreferences;
}) {
  return (
    <section className="active-summary" aria-label="Active lesson overview">
      <p className="active-source" title={sourceName}>{sourceName}</p>
      <p className="active-label">Current concept</p>
      <h2>{conceptTitle || "Preparing lesson…"}</h2>
      <p className="active-teaching-style">
        Teaching: {capitalize(teachingPreferences.explanationDepth)} · Speech: {capitalize(teachingPreferences.speakingSpeed)}
      </p>
    </section>
  );
}

export function ActiveTeachingPreferences({
  preferences,
  updatePending,
  desktopExpanded,
  mobileExpanded,
  onToggleDesktopExpanded,
  onToggleMobileExpanded,
  onChange,
}: {
  preferences: TeachingPreferences;
  updatePending: boolean;
  desktopExpanded: boolean;
  mobileExpanded: boolean;
  onToggleDesktopExpanded: () => void;
  onToggleMobileExpanded: () => void;
  onChange: (update: Partial<TeachingPreferences>) => void;
}) {
  return (
    <section className={desktopExpanded ? "active-teaching-preferences" : "active-teaching-preferences desktop-collapsed"} aria-labelledby="active-teaching-style-title">
      <header className="mobile-disclosure-header">
        <h2 id="active-teaching-style-title">Teaching style</h2>
        <button type="button" aria-expanded={mobileExpanded} aria-controls="active-teaching-style-content" onClick={onToggleMobileExpanded}>Teaching style</button>
        <button className="desktop-teaching-style-toggle" type="button" aria-label={desktopExpanded ? "Collapse teaching style" : "Expand teaching style"} aria-expanded={desktopExpanded} aria-controls="active-teaching-style-content" onClick={onToggleDesktopExpanded}>
          <span aria-hidden="true">{desktopExpanded ? "▼" : "▶"}</span>
        </button>
      </header>
      <div id="active-teaching-style-content" className={mobileExpanded ? "mobile-disclosure-content mobile-expanded" : "mobile-disclosure-content"}>
      <TeachingStyleControls
        preferences={preferences}
        onChange={onChange}
      />
      {updatePending && (
        <p className="preference-pending" role="status">Updating teaching style…</p>
      )}
      </div>
    </section>
  );
}

export function ConversationTranscript({
  learnerReply,
  tutorTranscript,
  mobileExpanded,
  onToggleMobileExpanded,
}: {
  learnerReply: string;
  tutorTranscript: string;
  mobileExpanded: boolean;
  onToggleMobileExpanded: () => void;
}) {
  return (
    <section className="conversation-transcript" aria-labelledby="conversation-transcript-title">
      <header className="mobile-disclosure-header">
        <h2 id="conversation-transcript-title">Transcript</h2>
        <button type="button" aria-expanded={mobileExpanded} aria-controls="conversation-transcript-content" onClick={onToggleMobileExpanded}>Transcript</button>
      </header>
      <div id="conversation-transcript-content" className={mobileExpanded ? "conversation-transcript-body mobile-disclosure-content mobile-expanded" : "conversation-transcript-body mobile-disclosure-content"}><p><strong>You</strong>{learnerReply || "No learner transcript yet."}</p><p><strong>Tutor</strong>{tutorTranscript || "The tutor has not spoken yet."}</p></div>
    </section>
  );
}

export function ConversationStatusRow({
  microphoneActive,
  microphoneMuted,
  aiConnected,
  farewellFinishing,
  transportState,
  onToggleMute,
}: {
  microphoneActive: boolean;
  microphoneMuted: boolean;
  aiConnected: boolean;
  farewellFinishing: boolean;
  transportState: LiveTransportState;
  onToggleMute: () => void;
}) {
  return (
    <div className="status-row" aria-label="Conversation status">
      <div className="status-item" aria-live="polite">
        <span
          className={`status-dot${microphoneActive ? " status-dot-active" : ""}`}
          aria-hidden="true"
        />
        <span className="status-copy">
          <strong>{farewellFinishing ? "Finishing lesson…" : microphoneMuted ? "Muted" : "Listening"}</strong>
          <small>{farewellFinishing ? "Playing the tutor’s farewell" : microphoneMuted ? "Microphone is off" : "You can speak at any time"}</small>
        </span>
        <button className={`mute-button${microphoneMuted ? " mute-button-active" : ""}`} type="button" onClick={onToggleMute} aria-label={microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={microphoneMuted}>{microphoneMuted ? "Unmute" : "Mute"}</button>
      </div>
      <div className="status-item" aria-live="polite">
        <span
          className={`status-dot${aiConnected ? " status-dot-active" : ""}`}
          aria-hidden="true"
        />
        <span>
          <strong>{transportState === "recovering" || transportState === "handoff" || transportState === "synchronizing" ? "Reconnecting…" : aiConnected ? "Tutor ready" : "Connecting…"}</strong>
          <small>{aiConnected ? "Voice conversation is active" : "Starting your lesson"}</small>
        </span>
      </div>
    </div>
  );
}

export function LessonResponseControls({
  quickResponseFeedback,
  typedReply,
  typedReplyInputRef,
  onQuickResponse,
  onTypedReplyChange,
  onSubmitTypedReply,
}: {
  quickResponseFeedback: string;
  typedReply: string;
  typedReplyInputRef: RefObject<HTMLInputElement | null>;
  onQuickResponse: (response: QuickResponse) => void;
  onTypedReplyChange: (value: string) => void;
  onSubmitTypedReply: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <section className="lesson-controls" aria-label="Lesson response controls">
      <div className="quick-replies-group">
        <h3 className="quick-replies-heading" id="quick-replies-title">Quick Replies</h3>
        <div className="quick-responses" aria-labelledby="quick-replies-title">
          <button type="button" onClick={() => onQuickResponse("Yes")} aria-label="Yes">
            Yes
          </button>
          <button type="button" onClick={() => onQuickResponse("Repeat")} aria-label="Repeat explanation">
            Repeat
          </button>
          <button type="button" onClick={() => onQuickResponse("Continue")} aria-label="Continue lesson">
            Continue
          </button>
        </div>
        <p className="quick-response-feedback" role="status" aria-live="polite">
          {quickResponseFeedback}
        </p>
      </div>
      <form className="typed-reply-form" onSubmit={onSubmitTypedReply}>
        <label className="visually-hidden" htmlFor="typed-reply">Type a reply</label>
        <input ref={typedReplyInputRef} id="typed-reply" type="text" value={typedReply} onChange={(event) => onTypedReplyChange(event.target.value)} placeholder="Type a reply…" autoComplete="off" />
        <button type="submit" disabled={!typedReply.trim()}>Send</button>
      </form>
    </section>
  );
}
