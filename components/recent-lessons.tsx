"use client";

import { isTeachableLessonNode } from "../lib/lesson-state";
import type { SavedLesson } from "../lib/local-persistence";

type Props = {
  lessons: SavedLesson[];
  activeLessonId: string | null;
  busyLessonId: string | null;
  onContinue: (id: string) => void;
  onDelete: (lesson: SavedLesson) => void;
  onNewLesson: () => void;
};

export function RecentLessons({
  lessons,
  activeLessonId,
  busyLessonId,
  onContinue,
  onDelete,
  onNewLesson,
}: Props) {
  const recentLessons = lessons.filter((lesson) => lesson.id !== activeLessonId);
  const activeLesson = activeLessonId
    ? lessons.find((lesson) => lesson.id === activeLessonId)
    : undefined;

  return (
    <section className="recent-lessons" aria-labelledby="recent-lessons-title">
      <div className="recent-lessons-heading">
        <div>
          <h2 id="recent-lessons-title">Recent Lessons</h2>
          <p>Saved on this device</p>
        </div>
        <button type="button" className="new-lesson-button" onClick={onNewLesson}>
          + New Lesson
        </button>
      </div>

      {activeLesson && (
        <div className="current-saved-lesson">
          <span>Current saved lesson: <strong>{activeLesson.title}</strong></span>
          <button
            type="button"
            className="recent-lesson-delete"
            disabled={busyLessonId !== null}
            onClick={() => onDelete(activeLesson)}
            aria-label={`Delete current saved lesson ${activeLesson.title}`}
          >
            Delete
          </button>
        </div>
      )}

      {recentLessons.length > 0 && (
        <ol className="recent-lesson-list">
          {recentLessons.map((lesson) => {
            const nodes = Object.values(lesson.lessonState.nodes);
            const teachable = nodes.filter(isTeachableLessonNode);
            const covered = teachable.filter((node) => node.status === "taught").length;
            const partial = teachable.filter((node) => node.status === "partial").length;
            const skipped = teachable.filter((node) => node.status === "skipped").length;
            const current = lesson.lessonState.currentNodeId
              ? lesson.lessonState.nodes[lesson.lessonState.currentNodeId]
              : undefined;
            const busy = busyLessonId === lesson.id;

            return (
              <li key={lesson.id} className="recent-lesson-card">
                <h3>{lesson.title}</h3>
                <p>{lesson.sources.length} source{lesson.sources.length === 1 ? "" : "s"}</p>
                <p>{covered} of {teachable.length} concepts covered</p>
                {(partial > 0 || skipped > 0) && (
                  <p className="recent-lesson-secondary">
                    {partial > 0 ? `${partial} partial` : null}
                    {partial > 0 && skipped > 0 ? " · " : null}
                    {skipped > 0 ? `${skipped} skipped` : null}
                  </p>
                )}
                {current?.title && <p>Current: {current.title}</p>}
                <p>
                  {capitalize(lesson.teachingPreferences.explanationDepth)} ·{" "}
                  {capitalize(lesson.teachingPreferences.speakingSpeed)} speech
                </p>
                <p className="recent-lesson-time">Last studied {formatRelativeDate(lesson.updatedAt)}</p>
                <div className="recent-lesson-actions">
                  <button
                    type="button"
                    className="recent-lesson-continue"
                    disabled={busyLessonId !== null}
                    onClick={() => onContinue(lesson.id)}
                  >
                    {busy ? "Opening…" : "Continue"}
                  </button>
                  <button
                    type="button"
                    className="recent-lesson-delete"
                    disabled={busyLessonId !== null}
                    onClick={() => onDelete(lesson)}
                    aria-label={`Delete ${lesson.title}`}
                  >
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatRelativeDate(value: string) {
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
      .format(new Date(value));
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const days = Math.floor(elapsedMs / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
    .format(new Date(value));
}
