import { expect, test } from "@playwright/test";
import {
  getLiveSends,
  installFakeLive,
  openLessonAndStart,
  readTestState,
  textOf,
} from "../helpers/fake-live";

test("teaching room keeps its primary accessible surfaces after startup", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);

  await expect(page.getByText("Teaching room", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "plc-notes.txt" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Current lesson source visual" })).toBeVisible();
  await expect(page.getByText("No source visual for this topic.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Active lesson overview" })).toContainText("What is a PLC?");
  await expect(page.getByLabel("Conversation status")).toContainText("Tutor ready");
  await expect(page.getByRole("region", { name: "Lesson response controls" })).toBeVisible();
  await expect(page.getByRole("button", { name: "End lesson", exact: true })).toBeVisible();

  await expect(page.getByText("Developer Debug", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Source visual diagnostics" })).toHaveCount(0);
});

test("teaching controls and teaching-style state remain interactive", async ({ page }) => {
  await installFakeLive(page);
  await openLessonAndStart(page);

  const mute = page.getByRole("button", { name: "Mute microphone" });
  await expect(mute).toHaveAttribute("aria-pressed", "false");
  await mute.click();
  await expect(page.getByRole("button", { name: "Unmute microphone" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Unmute microphone" }).click();
  await expect(page.getByRole("button", { name: "Mute microphone" })).toHaveAttribute("aria-pressed", "false");

  const collapseTeachingStyle = page.getByRole("button", { name: "Collapse teaching style" });
  await expect(collapseTeachingStyle).toHaveAttribute("aria-expanded", "true");
  await collapseTeachingStyle.click();
  const expandTeachingStyle = page.getByRole("button", { name: "Expand teaching style" });
  await expect(expandTeachingStyle).toHaveAttribute("aria-expanded", "false");
  await expandTeachingStyle.click();
  await expect(page.getByRole("button", { name: "Collapse teaching style" })).toHaveAttribute("aria-expanded", "true");

  const normalDepth = page.getByRole("button", { name: "Normal explanation depth" });
  const detailedDepth = page.getByRole("button", { name: "Detailed explanation depth" });
  await expect(normalDepth).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Normal speaking speed" })).toHaveAttribute("aria-pressed", "true");
  await detailedDepth.click();
  await expect(detailedDepth).toHaveAttribute("aria-pressed", "true");
  await expect(normalDepth).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("status").filter({ hasText: "Updating teaching style" })).toBeVisible();
  await expect.poll(async () => (await getLiveSends(page)).some(({ message }) =>
    textOf(message).includes("Please use detailed explanations from now on."),
  )).toBe(true);

  await page.getByRole("button", { name: "Continue lesson" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Continue sent" })).toBeVisible();
  await page.getByLabel("Type a reply").fill("Could you give an example?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByLabel("Type a reply")).toHaveValue("");
  await expect.poll(async () => (await getLiveSends(page)).some(({ message }) =>
    textOf(message).includes("Could you give an example?"),
  )).toBe(true);
});

test("active lesson restart can be cancelled or confirmed provider-free", async ({ page }) => {
  await installFakeLive(page, { persisted: true });
  await openLessonAndStart(page, true);

  await page.getByRole("button", { name: "Restart Lesson" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Restart this lesson?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("clear all teaching progress");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Teaching room", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Restart Lesson" }).click();
  await page.getByRole("alertdialog", { name: "Restart this lesson?" })
    .getByRole("button", { name: "Restart", exact: true }).click();

  await expect(page.getByRole("alertdialog", { name: "Restart this lesson?" })).toHaveCount(0);
  await expect(page.getByText("Teaching room", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readTestState(page)).snapshot.deliveryCursor).toBe(0);
  await expect.poll(async () => new Set((await getLiveSends(page)).map(({ socketId }) => socketId)).size).toBe(2);
});
