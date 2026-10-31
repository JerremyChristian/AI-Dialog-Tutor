"use client";

import type { LessonSource } from "../lib/learning-source";
import type { EngagementState } from "../lib/engagement";
import type { LiveTransportState } from "../lib/live-transport-manager";
import {
  getCurrentConcept,
  getLessonTreeRows,
  type LessonState,
} from "../lib/lesson-state";

export type DebugMessage = {
  id: number;
  timestamp: string;
  text: string;
};

type Props = {
  lessonState: LessonState;
  lessonSources: LessonSource[];
  transportState: LiveTransportState;
  engagementState: EngagementState;
  lessonActive: boolean;
  debugMessages: DebugMessage[];
  onForceSafeRollover: () => void;
  onForceImmediateRollover: () => void;
  onTestRecoveryFallback: () => void;
  onTestIdleConfirmation: () => void;
  onTestInvalidLessonId: () => void;
};

export function DeveloperDebugPanel({
  lessonState,
  lessonSources,
  transportState,
  engagementState,
  lessonActive,
  debugMessages,
  onForceSafeRollover,
  onForceImmediateRollover,
  onTestRecoveryFallback,
  onTestIdleConfirmation,
  onTestInvalidLessonId,
}: Props) {
  const currentTeachingContract = getCurrentConcept(lessonState)?.teaching;

  return (
    <details className="developer-debug"><summary>Developer Debug</summary><section className="lesson-state" aria-labelledby="lesson-state-title">
      <div className="panel-heading">
        <h2 id="lesson-state-title">Lesson State</h2>
        <span>Development</span>
      </div>
      <dl className="engineering-state">
        <div>
          <dt>Topic</dt>
          <dd>{lessonState.topic}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{lessonState.status}</dd>
        </div>
        <div>
          <dt>Current concept</dt>
          <dd>{getCurrentConcept(lessonState)?.title || "-"}</dd>
        </div>
        <div>
          <dt>Resume point</dt>
          <dd>{lessonState.resumePoint || "-"}</dd>
        </div>
        <div>
          <dt>Interruptions</dt>
          <dd>{lessonState.interruptionCount}</dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>{transportState}</dd>
        </div>
        <div>
          <dt>Engagement</dt>
          <dd>{engagementState}</dd>
        </div>
        <div>
          <dt>Latest learner transcript</dt>
          <dd>{lessonState.lastUserTranscript || "-"}</dd>
        </div>
        <div>
          <dt>Latest tutor transcript</dt>
          <dd>{lessonState.lastAssistantTranscript || "-"}</dd>
        </div>
      </dl>
      <div className="coverage-map">
        <h3>Lesson Coverage</h3>
        {lessonState.rootNodeIds.length === 0 ? (
          <p>No lesson tree loaded.</p>
        ) : (
          <ol>
            {getLessonTreeRows(lessonState).map(({ node, depth }) => (
              <li
                key={node.id}
                className={
                  node.id === lessonState.currentNodeId
                    ? "coverage-current"
                    : undefined
                }
                style={{ paddingLeft: `${Math.min(depth * 16, 48)}px` }}
              >
                <span aria-hidden="true">
                  {node.id === lessonState.currentNodeId
                    ? "▶"
                    : node.status === "taught"
                      ? "✓"
                      : node.status === "partial"
                        ? "◐"
                        : node.status === "skipped"
                          ? "○"
                          : "·"}
                </span>
                <strong>{node.title}</strong>
                <small>{node.status.replace("-", " ")}</small>
              </li>
            ))}
          </ol>
        )}
      </div>
      {currentTeachingContract && (
        <div className="teaching-contract">
          <h3>Current Teaching Contract</h3>
          <p className="contract-meta">
            {currentTeachingContract.type.replace("-", " ")} · {currentTeachingContract.importance}
            {currentTeachingContract.sourceConfidence
              ? ` · ${currentTeachingContract.sourceConfidence}`
              : ""}
          </p>
          <h4>Objective</h4>
          <p>{currentTeachingContract.objective}</p>
          <h4>Teaching points</h4>
          <ul>
            {currentTeachingContract.teachingPoints.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <h4>Completion criteria</h4>
          <ul>
            {currentTeachingContract.completionCriteria.map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
          {currentTeachingContract.sourceReferences?.length ? (
            <p><strong>Source:</strong> {currentTeachingContract.sourceReferences.map((reference) => {
              const sourceName = lessonSources.find((source) => source.id === reference.sourceId)?.name ?? reference.sourceId;
              return `${sourceName}${reference.page ? ` page ${reference.page}` : ""}${reference.section ? ` (${reference.section})` : ""}`;
            }).join(", ")}</p>
          ) : null}
          {currentTeachingContract.keyTerms?.length ? (
            <p><strong>Terms:</strong> {currentTeachingContract.keyTerms.join(", ")}</p>
          ) : null}
          {currentTeachingContract.notation?.length ? (
            <p><strong>Notation:</strong> {currentTeachingContract.notation.join(", ")}</p>
          ) : null}
          {currentTeachingContract.uncertaintyNote ? (
            <p><strong>Uncertainty:</strong> {currentTeachingContract.uncertaintyNote}</p>
          ) : null}
        </div>
      )}
    </section>

    <details className="transcript">
      <summary id="transcript-title">Show Debug</summary>
      <div className="transcript-body" role="log" aria-live="polite" aria-labelledby="transcript-title">
        {process.env.NODE_ENV === "development" && lessonActive && (
          <div className="debug-session-controls" aria-label="Development session controls">
            <button type="button" onClick={onForceSafeRollover}>
              Force safe rollover
            </button>
            <button type="button" onClick={onForceImmediateRollover}>
              Force immediate rollover
            </button>
            <button type="button" onClick={onTestRecoveryFallback}>
              Test recovery fallback
            </button>
            <button type="button" onClick={onTestIdleConfirmation}>
              Test idle confirmation
            </button>
            <button
              type="button"
              onClick={onTestInvalidLessonId}
            >
              Test invalid lesson ID
            </button>
          </div>
        )}
        {debugMessages.length === 0 ? (
          <p>Conversation events and transcript messages will appear here.</p>
        ) : (
          <ol className="debug-messages">
            {debugMessages.map((message) => (
              <li key={message.id}>
                <time>{message.timestamp}</time> {message.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    </details></details>
  );
}
