"use client";

import { useMemo, useState } from "react";
import { isTeachableLessonNode } from "../lib/lesson-state";
import type { SavedLesson } from "../lib/local-persistence";

type Props = { lessons: SavedLesson[]; busyLessonId: string | null; onOpen: (lesson: SavedLesson) => void; onDelete: (lesson: SavedLesson) => void; onNewLesson: () => void };

export function LessonLibrary({ lessons, busyLessonId, onOpen, onDelete, onNewLesson }: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => { const q = query.trim().toLowerCase(); return q ? lessons.filter((lesson) => lesson.title.toLowerCase().includes(q)) : lessons; }, [lessons, query]);
  return <section className="product-view library-view" aria-labelledby="library-title">
    <div className="view-heading"><div><p className="eyebrow">Your learning</p><h1 id="library-title">Library</h1><p>Open a lesson when you are ready to learn.</p></div><button className="button-primary" type="button" onClick={onNewLesson}>+ New Lesson</button></div>
    {lessons.length === 0 ? <div className="empty-state"><h2>No lessons yet</h2><p>Add slides, notes, or a transcript to create your first lesson.</p><button className="button-primary" type="button" onClick={onNewLesson}>+ New Lesson</button></div> : <>
      <label className="library-search"><span>Search lessons</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by title" /></label>
      {filtered.length === 0 ? <div className="empty-state compact"><h2>No matching lessons</h2><p>Try a different title.</p></div> : <ol className="library-grid">{filtered.map((lesson) => {
        const progress = lessonProgress(lesson); const current = lesson.lessonState.currentNodeId ? lesson.lessonState.nodes[lesson.lessonState.currentNodeId] : undefined; const busy = busyLessonId === lesson.id;
        return <li className="lesson-card" key={lesson.id}><div><span className="lesson-status">{lesson.hasStarted ? `${progress}% complete` : "Ready to start"}</span><h2>{lesson.title}</h2><p>{lesson.sources.length} source{lesson.sources.length === 1 ? "" : "s"}{current?.title ? ` · ${current.title}` : ""}</p></div><div className="progress-track" aria-label={`${progress}% complete`}><span style={{ width: `${progress}%` }} /></div><p className="lesson-date">{lesson.hasStarted ? "Last studied" : "Created"} {formatDate(lesson.updatedAt)}</p><div className="lesson-card-actions"><button className="button-primary" type="button" disabled={busyLessonId !== null} onClick={() => onOpen(lesson)}>{busy ? "Opening…" : lesson.hasStarted ? "Continue" : "Start"}</button><button className="button-danger" type="button" disabled={busyLessonId !== null} onClick={() => onDelete(lesson)}>Delete</button></div></li>;
      })}</ol>}
    </>}
  </section>;
}

export function lessonProgress(lesson: SavedLesson) { const teachable = Object.values(lesson.lessonState.nodes).filter(isTeachableLessonNode); const covered = teachable.filter((node) => node.status === "taught").length; return teachable.length ? Math.round((covered / teachable.length) * 100) : 0; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "recently" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date); }
