import { describe, expect, it } from "vitest";
import { APPEARANCE_STORAGE_KEY, parseStoredAppearance } from "../../lib/use-appearance";

describe("appearance preference storage", () => {
  it("keeps the existing localStorage key", () => {
    expect(APPEARANCE_STORAGE_KEY).toBe("ai-tutor-appearance");
  });

  it("restores explicit light and dark preferences", () => {
    expect(parseStoredAppearance("light")).toBe("light");
    expect(parseStoredAppearance("dark")).toBe("dark");
  });

  it("falls back to system for missing or unknown values", () => {
    expect(parseStoredAppearance(null)).toBe("system");
    expect(parseStoredAppearance("system")).toBe("system");
    expect(parseStoredAppearance("Dark")).toBe("system");
    expect(parseStoredAppearance("")).toBe("system");
  });
});
