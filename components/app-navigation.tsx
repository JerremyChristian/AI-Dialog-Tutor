"use client";

export type AppView = "home" | "library" | "profile";

type Props = { activeView: AppView; onNavigate: (view: AppView) => void };
const destinations = [{ view: "home", label: "Home" }, { view: "library", label: "Library" }, { view: "profile", label: "Profile" }] as const;

export function AppNavigation({ activeView, onNavigate }: Props) {
  return <header className="app-header">
    <button className="app-brand" type="button" onClick={() => onNavigate("home")}><span aria-hidden="true">A</span><strong>AI Tutor</strong></button>
    <nav className="desktop-nav" aria-label="Primary navigation">
      {destinations.map(({ view, label }) => <button key={view} type="button" aria-current={activeView === view ? "page" : undefined} onClick={() => onNavigate(view)}>{label}</button>)}
    </nav>
    <nav className="mobile-nav" aria-label="Primary navigation">
      {destinations.map(({ view, label }) => <button key={view} type="button" aria-current={activeView === view ? "page" : undefined} onClick={() => onNavigate(view)}><span aria-hidden="true">{view === "home" ? "⌂" : view === "library" ? "▤" : "○"}</span>{label}</button>)}
    </nav>
  </header>;
}
