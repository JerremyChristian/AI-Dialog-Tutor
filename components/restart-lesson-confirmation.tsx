"use client";

type Props = {
  idPrefix: "active-restart-lesson" | "restart-lesson";
  restartPending: boolean;
  onCancel: () => void;
  onRestart: () => void;
};

export function RestartLessonConfirmation({ idPrefix, restartPending, onCancel, onRestart }: Props) {
  return (
    <section className="restart-lesson-confirmation" role="alertdialog" aria-labelledby={`${idPrefix}-title`} aria-describedby={`${idPrefix}-description`}>
      <h2 id={`${idPrefix}-title`}>Restart this lesson?</h2>
      <p id={`${idPrefix}-description`}>This will clear all teaching progress for this lesson and start it again from the beginning. Your materials and lesson content will not be deleted.</p>
      <div><button className="button-secondary" type="button" disabled={restartPending} onClick={onCancel}>Cancel</button><button className="button-danger" type="button" disabled={restartPending} onClick={onRestart}>{restartPending ? "Restarting…" : "Restart"}</button></div>
    </section>
  );
}
