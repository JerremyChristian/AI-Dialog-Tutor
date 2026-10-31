"use client";

import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function usePwaInstall() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [showIosInstallHint, setShowIosInstallHint] = useState(false);

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    setShowIosInstallHint(/iPad|iPhone|iPod/.test(navigator.userAgent) && !standalone);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);

    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
    };
  }, []);

  const requestInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  return { installPrompt, showIosInstallHint, requestInstall };
}
