"use client";

import { useEffect, useState } from "react";

export type AppearancePreference = "system" | "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "ai-tutor-appearance";

export function parseStoredAppearance(saved: string | null): AppearancePreference {
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<AppearancePreference>("system");
  const [appearanceReady, setAppearanceReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
      setAppearance(parseStoredAppearance(saved));
    } catch {
      setAppearance("system");
    }
    setAppearanceReady(true);
  }, []);

  useEffect(() => {
    if (!appearanceReady) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolved = appearance === "system"
        ? media.matches ? "dark" : "light"
        : appearance;
      document.documentElement.dataset.theme = resolved;
    };
    try {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
    } catch {
      // Appearance still applies for this session when browser storage is unavailable.
    }
    applyAppearance();
    if (appearance !== "system") return;
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [appearance, appearanceReady]);

  return { appearance, setAppearance };
}
