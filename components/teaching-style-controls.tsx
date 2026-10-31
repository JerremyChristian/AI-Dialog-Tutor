"use client";

import {
  EXPLANATION_DEPTHS,
  SPEAKING_SPEEDS,
  type TeachingPreferences,
} from "../lib/teaching-preferences";

export function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function TeachingStyleControls({
  preferences,
  disabled,
  onChange,
}: {
  preferences: TeachingPreferences;
  disabled?: boolean;
  onChange: (update: Partial<TeachingPreferences>) => void;
}) {
  return (
    <div className="teaching-style-controls">
      <fieldset disabled={disabled}>
        <legend>Explanation depth</legend>
        <div className="preference-segments">
          {EXPLANATION_DEPTHS.map((depth) => (
            <button
              key={depth}
              type="button"
              className={preferences.explanationDepth === depth ? "selected" : undefined}
              aria-label={`${capitalize(depth)} explanation depth`}
              aria-pressed={preferences.explanationDepth === depth}
              onClick={() => onChange({ explanationDepth: depth })}
            >
              {capitalize(depth)}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={disabled}>
        <legend>
          Speaking speed
          <small>How fast the tutor talks</small>
        </legend>
        <div className="preference-segments">
          {SPEAKING_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className={preferences.speakingSpeed === speed ? "selected" : undefined}
              aria-label={`${capitalize(speed)} speaking speed`}
              aria-pressed={preferences.speakingSpeed === speed}
              onClick={() => onChange({ speakingSpeed: speed })}
            >
              {capitalize(speed)}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
