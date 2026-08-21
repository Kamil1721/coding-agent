import { expect, test, type Page, type Route } from "@playwright/test";

import { FINISHED_RUN_ID, RUN_ID } from "./fixtures/config";

interface PostedMessage {
  readonly text?: string;
  readonly images?: readonly string[];
  readonly intent?: string;
  readonly clientMessageId?: string;
}

function message(text: string) {
  return {
    seq: 17,
    at: "2026-08-20T10:00:00.000Z",
    role: "owner",
    text,
    images: [],
    deliveredAt: null,
  } as const;
}

async function openChat(page: Page, runId: string): Promise<void> {
  await page.goto(`/runs/${runId}`);
  await page.getByTestId("rail-chat").click();
  await expect(page.getByRole("textbox", { name: "Message the orchestrator" })).toBeVisible();
}

test("Steer posts an explicit next-turn intent and renders the server disposition", async ({
  page,
}) => {
  let posted: PostedMessage | null = null;
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posted = route.request().postDataJSON() as PostedMessage;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        disposition: "queued_boundary",
        message: message(posted.text ?? ""),
        documents: [],
        targetRunId: RUN_ID,
      }),
    });
  });

  await openChat(page, RUN_ID);
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("Use the latest owner direction next");
  await page.getByRole("button", { name: "steer", exact: true }).click();

  await expect(page.getByTestId("message-disposition")).toHaveText(
    "Queued for the next work boundary.",
  );
  expect(posted).toMatchObject({
    text: "Use the latest owner direction next",
    images: [],
    intent: "steer",
  });
  const postedMessage = posted as PostedMessage | null;
  expect(postedMessage?.clientMessageId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await expect(composer).toHaveValue("");
});

test("Enter remains ordinary Send and feedback follows the receipt, not run phase", async ({
  page,
}) => {
  let posted: PostedMessage | null = null;
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posted = route.request().postDataJSON() as PostedMessage;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        disposition: "delivered_live",
        message: { ...message(posted.text ?? ""), deliveredAt: "2026-08-20T10:00:01.000Z" },
        documents: [],
        targetRunId: RUN_ID,
      }),
    });
  });

  await openChat(page, RUN_ID);
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("Keep going with this detail");
  await composer.press("Enter");

  expect(posted).toMatchObject({ intent: "send", text: "Keep going with this detail" });
  await expect(page.getByTestId("message-disposition")).toHaveText(
    "Delivered live. The run will take this at its next step.",
  );
  await expect(page.getByTestId("explain-delivery")).toHaveCount(0);
});

test("a finished run accepts a message and offers its immutable linked continuation", async ({
  page,
}) => {
  const continuationId = "continued-from-finished-run";
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const posted = route.request().postDataJSON() as PostedMessage;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        disposition: "continuation_created",
        message: message(posted.text ?? ""),
        documents: [],
        targetRunId: continuationId,
        sourceRunId: FINISHED_RUN_ID,
        sourceMessageSeq: 17,
      }),
    });
  });

  await openChat(page, FINISHED_RUN_ID);
  await expect(page.getByText(/Your next message starts a linked continuation/)).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("Pick up from this correction");
  await page.getByRole("button", { name: "steer", exact: true }).click();

  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("message-disposition")).toContainText(
    "The finished source stays unchanged.",
  );
  await expect(page.getByRole("link", { name: `Open run ${continuationId}` })).toHaveAttribute(
    "href",
    `/runs/${continuationId}`,
  );
});

test("a refused disposition keeps the draft and reports the server reason", async ({ page }) => {
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        disposition: "refused",
        reason: "The continuation limit has been reached.",
        targetRunId: null,
      }),
    });
  });

  await openChat(page, FINISHED_RUN_ID);
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("Do not lose this draft");
  await page.getByRole("button", { name: "send", exact: true }).click();

  await expect(page.getByTestId("message-disposition")).toHaveText(
    "Not sent — The continuation limit has been reached.",
  );
  await expect(composer).toHaveValue("Do not lose this draft");
});

test("text typed while a message is in flight remains the next draft", async ({ page }) => {
  let release: (() => void) | null = null;
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const posted = route.request().postDataJSON() as PostedMessage;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        disposition: "delivered_live",
        message: { ...message(posted.text ?? ""), deliveredAt: "2026-08-20T10:00:01.000Z" },
        documents: [],
        targetRunId: RUN_ID,
      }),
    });
  });

  await openChat(page, RUN_ID);
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("the message being sent");
  await page.getByRole("button", { name: "send", exact: true }).click();
  await expect(page.getByRole("button", { name: "sending…" })).toBeVisible();

  await composer.fill("the next draft");
  const finish = release as (() => void) | null;
  if (finish === null) throw new Error("the POST did not reach the route handler");
  finish();

  await expect(page.getByRole("button", { name: "send", exact: true })).toBeVisible();
  await expect(composer).toHaveValue("the next draft");
});
