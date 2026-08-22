export default function Home() {
  return (
    <main className="page-shell">
      <section className="tutor-card" aria-labelledby="page-title">
        <header className="hero">
          <p className="eyebrow">Learning workspace</p>
          <h1 id="page-title">Conversational AI Tutor</h1>
          <p className="intro">
            A simple workspace for future realtime, voice-guided lessons.
          </p>
        </header>

        <div className="status-row" aria-label="Conversation status">
          <div className="status-item">
            <span className="status-dot" aria-hidden="true" />
            <span>
              <strong>Microphone</strong>
              <small>Not active</small>
            </span>
          </div>
          <div className="status-item">
            <span className="status-dot" aria-hidden="true" />
            <span>
              <strong>AI connection</strong>
              <small>Not connected</small>
            </span>
          </div>
        </div>

        <button className="start-button" type="button">
          Start Conversation
        </button>

        <section className="transcript" aria-labelledby="transcript-title">
          <div className="panel-heading">
            <h2 id="transcript-title">Transcript / Debug</h2>
            <span>Idle</span>
          </div>
          <div className="transcript-body" role="log" aria-live="polite">
            <p>Conversation events and transcript messages will appear here.</p>
          </div>
        </section>
      </section>
    </main>
  );
}
