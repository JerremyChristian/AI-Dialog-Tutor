"use client";

import type { AppearancePreference } from "../lib/use-appearance";
import { capitalize } from "./teaching-style-controls";

export function AppearanceSettings({
  appearance,
  onChange,
}: {
  appearance: AppearancePreference;
  onChange: (appearance: AppearancePreference) => void;
}) {
  return (
    <section className="appearance-settings" aria-labelledby="appearance-title">
      <p className="eyebrow">Appearance</p><h2 id="appearance-title">Choose your theme</h2>
      <div className="appearance-options">
        {(["system", "light", "dark"] as AppearancePreference[]).map((option) => <button key={option} type="button" className={appearance === option ? "selected" : undefined} aria-pressed={appearance === option} onClick={() => onChange(option)}><strong>{capitalize(option)}</strong><small>{option === "system" ? "Use your device appearance" : option === "light" ? "Always use light appearance" : "Always use dark appearance"}</small></button>)}
      </div>
    </section>
  );
}
