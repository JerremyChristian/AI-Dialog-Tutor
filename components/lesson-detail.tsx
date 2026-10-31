"use client";

import type { SavedLesson } from "../lib/local-persistence";
import { lessonProgress } from "./lesson-library";
import { LessonRoadmap } from "./lesson-roadmap";
import { RestartLessonConfirmation } from "./restart-lesson-confirmation";

type Props = {
  lesson: SavedLesson | undefined;
  topicInput: string;
  requestingPermission: boolean;
  learningSourceReady: boolean;
  resumeExistingLesson: boolean;
  restartable: boolean;
  restartPending: boolean;
  restartConfirmationOpen: boolean;
  libraryBusy: boolean;
  userError: string;
  onBack: () => void;
  onTopicInputChange: (value: string) => void;
  onStart: () => void;
  onRequestRestart: () => void;
  onCancelRestart: () => void;
  onRestart: () => void;
  onDelete: (lesson: SavedLesson) => void;
};

export function LessonDetail({
  lesson,
  topicInput,
  requestingPermission,
  learningSourceReady,
  resumeExistingLesson,
  restartable,
  restartPending,
  restartConfirmationOpen,
  libraryBusy,
  userError,
  onBack,
  onTopicInputChange,
  onStart,
  onRequestRestart,
  onCancelRestart,
  onRestart,
  onDelete,
}: Props) {
  return (
    <section className="product-view lesson-detail-view" aria-labelledby="lesson-detail-title">
      <button className="back-button" type="button" onClick={onBack}>← Back to Library</button>
      {lesson ? <>
        <div className="focused-view-heading"><p className="eyebrow">Lesson</p><h1 id="lesson-detail-title">{lesson.title}</h1></div>
        <section className="lesson-detail-card" aria-label="Lesson details"><dl>
          <div><dt>Progress</dt><dd>{lessonProgress(lesson)}%</dd></div>
          <div><dt>Current topic</dt><dd>{lesson.lessonState.currentNodeId ? lesson.lessonState.nodes[lesson.lessonState.currentNodeId]?.title || "Ready to begin" : "Ready to begin"}</dd></div>
          <div><dt>Sources</dt><dd>{lesson.sources.length}</dd></div>
        </dl></section>
        <label className="topic-field setup-only"><span>Lesson topic or focus (optional)</span><input type="text" value={topicInput} onChange={(event) => onTopicInputChange(event.target.value)} placeholder="Teach the source's main topics" maxLength={160} disabled={requestingPermission} /></label>
        <div className="lesson-detail-actions"><button className="button-primary" type="button" onClick={onStart} disabled={requestingPermission || !learningSourceReady || restartPending}>{requestingPermission ? "Connecting…" : resumeExistingLesson ? "Continue Lesson" : "Start Lesson"}</button>{restartable && <button className="button-secondary" type="button" disabled={restartPending || libraryBusy} onClick={onRequestRestart}>Restart Lesson</button>}<button className="button-danger" type="button" disabled={restartPending || libraryBusy} onClick={() => onDelete(lesson)}>Delete Lesson</button></div>
        {restartable && restartConfirmationOpen && <RestartLessonConfirmation idPrefix="restart-lesson" restartPending={restartPending} onCancel={onCancelRestart} onRestart={onRestart} />}
        <div className="lesson-detail-progress"><LessonRoadmap lessonState={lesson.lessonState} lessonActive={false} readOnly navigationPending={false} onNavigate={() => undefined} /></div>
        {userError && <p className="session-error" role="alert">{userError}</p>}
      </> : <div className="empty-state compact"><h1 id="lesson-detail-title">Lesson unavailable</h1><p>This lesson could not be loaded.</p></div>}
    </section>
  );
}
