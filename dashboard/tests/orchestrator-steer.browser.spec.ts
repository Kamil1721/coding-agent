import { expect, test, type Page, type Route } from "@playwright/test";

import { FINISHED_RUN_ID, RUN_ID } from "./fixtures/config";
import { MODEL_ID, RUN_DETAIL } from "./fixtures/run-fixture";
import type { ModelOption } from "../src/lib/api-types";

interface PostedMessage {
  readonly text?: string;
  readonly images?: readonly string[];
  readonly intent?: string;
  readonly clientMessageId?: string;
  readonly continuationModelId?: string;
}

const ALTERNATE_MODEL_ID = "claude-haiku-live-catalogue";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const MODELS: readonly ModelOption[] = [
  {
    id: MODEL_ID,
    label: "Sonnet source model",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
  {
    id: ALTERNATE_MODEL_ID,
    label: "Haiku continuation model",
    provider: "anthropic",
    tier: "included",
    available: true,
    reason: null,
  },
  {
    id: "claude-unavailable-live-catalogue",
    label: "Unavailable catalogue model",
    provider: "anthropic",
    tier: "included",
    available: false,
    reason: "The provider is not authenticated.",
  },
];

async function serveModels(page: Page, models: readonly ModelOption[]): Promise<void> {
  await page.route("**/api/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(models),
    });
  });
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
  await expect(page.getByRole("combobox", { name: "Continuation model" })).toHaveCount(0);
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
  expect(posted).not.toHaveProperty("continuationModelId");
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
  let posted: PostedMessage | null = null;
  let finishPost: (() => void) | null = null;
  await serveModels(page, MODELS);
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posted = route.request().postDataJSON() as PostedMessage;
    await new Promise<void>((resolve) => {
      finishPost = resolve;
    });
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
        continuationModelId: ALTERNATE_MODEL_ID,
      }),
    });
  });

  await openChat(page, FINISHED_RUN_ID);
  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  await expect(modelPicker).toBeVisible();
  await expect(modelPicker).toHaveValue(MODEL_ID);
  await expect(modelPicker.getByRole("option")).toHaveCount(2);
  await expect(
    modelPicker.getByRole("option", { name: /Unavailable catalogue model/ }),
  ).toHaveCount(0);
  await expect(page.getByText(/Your next message starts a linked continuation/)).toContainText(
    "Sonnet source model",
  );

  await modelPicker.selectOption(ALTERNATE_MODEL_ID);

  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("Pick up from this correction");
  // Draft changes re-render the composer; the explicit model choice must survive.
  await expect(modelPicker).toHaveValue(ALTERNATE_MODEL_ID);
  await page.getByRole("button", { name: "steer", exact: true }).click();

  expect(posted).toMatchObject({ continuationModelId: ALTERNATE_MODEL_ID });
  await expect(page.getByRole("button", { name: "steering…" })).toBeDisabled();
  await expect(modelPicker).toBeDisabled();
  const release = finishPost as (() => void) | null;
  if (release === null) throw new Error("the continuation POST did not reach the route handler");
  release();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("message-disposition")).toContainText(
    `Continued with Haiku continuation model (${ALTERNATE_MODEL_ID}) in a new run. The finished source stays unchanged.`,
  );
  await expect(page.getByRole("link", { name: `Open run ${continuationId}` })).toHaveAttribute(
    "href",
    `/runs/${continuationId}`,
  );
});

test("a lost committed response retries the pinned model and request id after catalogue refresh", async ({
  page,
}) => {
  const continuationId = "one-durable-continuation";
  const posts: PostedMessage[] = [];
  let availableModels = MODELS;
  let modelReads = 0;

  await page.route("**/api/models", async (route) => {
    modelReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(availableModels),
    });
  });
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const posted = route.request().postDataJSON() as PostedMessage;
    posts.push(posted);
    if (posts.length <= 2) {
      // The server observed and committed this request; only its response is lost.
      availableModels = [MODELS[0]!];
      await route.abort("connectionreset");
      return;
    }
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
        continuationModelId: MODEL_ID,
      }),
    });
  });

  await openChat(page, FINISHED_RUN_ID);
  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await modelPicker.selectOption(ALTERNATE_MODEL_ID);
  await composer.fill("Retry this exact continuation safely");
  await page.getByRole("button", { name: "steer", exact: true }).click();
  await expect(page.getByRole("button", { name: "steer", exact: true })).toBeEnabled();
  expect(posts).toHaveLength(1);

  // SWR throttles focus revalidation for five seconds. Cross that boundary and
  // deliver the same focus signal a reader returning to the tab produces.
  await page.waitForTimeout(5_100);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await expect.poll(() => modelReads).toBeGreaterThan(1);

  await expect(modelPicker).toHaveValue(ALTERNATE_MODEL_ID);
  await expect(
    modelPicker.getByRole("option", { name: /no longer available, retry only/ }),
  ).toHaveCount(1);
  await expect(page.getByText(/Steer retries Haiku continuation model/)).toContainText(
    "Choose an available model",
  );
  const send = page.getByRole("button", { name: "send", exact: true });
  const steer = page.getByRole("button", { name: "steer", exact: true });
  await expect(send).toBeDisabled();
  await expect(steer).toBeEnabled();
  await composer.press("Enter");
  expect(posts).toHaveLength(1);
  await expect(page.getByText(/Steer is the only safe retry/)).toBeVisible();

  await steer.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]?.clientMessageId).toBe(posts[0]?.clientMessageId);
  expect(posts[1]?.continuationModelId).toBe(ALTERNATE_MODEL_ID);
  await expect(steer).toBeEnabled();

  await modelPicker.selectOption(MODEL_ID);
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]?.clientMessageId).not.toBe(posts[0]?.clientMessageId);
  expect(posts[2]?.continuationModelId).toBe(MODEL_ID);

  const receipt = page.getByTestId("message-disposition");
  await expect(receipt).toHaveCount(1);
  await expect(receipt).toContainText(`Continued with Sonnet source model (${MODEL_ID})`);
  await expect(receipt.getByRole("link", { name: `Open run ${continuationId}` })).toHaveCount(1);
});

test("an active lost response replays without a model when the run becomes terminal", async ({
  page,
}) => {
  const continuationId = "continued-from-active-replay";
  const posts: PostedMessage[] = [];
  let terminal = false;
  let releaseTerminal: (() => void) | null = null;

  await serveModels(page, MODELS);
  await page.route(`**/api/runs/${RUN_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...RUN_DETAIL,
        status: terminal ? "failed" : "running",
        endedAt: terminal ? "2026-08-21T12:00:00.000Z" : null,
      }),
    });
  });
  await page.route(`**/api/runs/${RUN_ID}/events`, async (route) => {
    await new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body:
        "id: 999\n" +
        "event: status\n" +
        `data: ${JSON.stringify({ type: "status", status: "failed", at: "2026-08-21T12:00:00.000Z" })}\n\n`,
    });
  });
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const posted = route.request().postDataJSON() as PostedMessage;
    posts.push(posted);
    if (posts.length <= 2) {
      await route.abort("connectionreset");
      return;
    }
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        disposition: "continuation_created",
        message: message(posted.text ?? ""),
        documents: [],
        targetRunId: continuationId,
        sourceRunId: RUN_ID,
        sourceMessageSeq: 17,
        continuationModelId: MODEL_ID,
      }),
    });
  });

  await openChat(page, RUN_ID);
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  await composer.fill("Preserve this active request");
  const send = page.getByRole("button", { name: "send", exact: true });
  const steer = page.getByRole("button", { name: "steer", exact: true });
  await steer.click();
  await expect(steer).toBeEnabled();
  expect(posts[0]).not.toHaveProperty("continuationModelId");

  terminal = true;
  const finishRun = releaseTerminal as (() => void) | null;
  if (finishRun === null) throw new Error("the run event stream did not connect");
  finishRun();

  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  await expect(modelPicker).toBeVisible();
  await expect(modelPicker).toHaveValue("");
  await expect(
    modelPicker.getByRole("option", {
      name: "Original active request · retry without model override",
    }),
  ).toHaveCount(1);
  await expect(send).toBeDisabled();
  await expect(steer).toBeEnabled();
  await expect(page.getByText(/Steer retries the original request/)).toContainText(
    "no model override",
  );
  await composer.press("Enter");
  expect(posts).toHaveLength(1);
  await expect(page.getByText(/Steer is the only safe retry/)).toBeVisible();

  await steer.click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]?.clientMessageId).toBe(posts[0]?.clientMessageId);
  expect(posts[1]).not.toHaveProperty("continuationModelId");

  await expect(steer).toBeEnabled();
  await modelPicker.selectOption(MODEL_ID);
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts[2]?.clientMessageId).not.toBe(posts[0]?.clientMessageId);
  expect(posts[2]?.continuationModelId).toBe(MODEL_ID);
  await expect(page.getByTestId("message-disposition")).toContainText(
    `Continued with Sonnet source model (${MODEL_ID}) in a new run.`,
  );
  await expect(page.getByRole("link", { name: `Open run ${continuationId}` })).toHaveCount(1);
});

test("retry identity follows canonical bytes while real payload or model changes replace it", async ({
  page,
}) => {
  const posts: PostedMessage[] = [];
  await serveModels(page, MODELS);
  await page.route("**/api/runs/*/messages", async (route: Route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posts.push(route.request().postDataJSON() as PostedMessage);
    await route.abort("connectionreset");
  });

  await openChat(page, FINISHED_RUN_ID);
  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  const composer = page.getByRole("textbox", { name: "Message the orchestrator" });
  const steer = page.getByRole("button", { name: "steer", exact: true });
  const original = "Keep these canonical bytes";
  await modelPicker.selectOption(ALTERNATE_MODEL_ID);
  await composer.fill(original);
  await steer.click();
  await expect(steer).toBeEnabled();
  const originalId = posts[0]?.clientMessageId;

  // UI events fire, but the outgoing trim and ordered attachment arrays return
  // to exactly the first request before the retry.
  await composer.fill("temporary different text");
  await composer.fill(`${original}   `);
  await modelPicker.selectOption(MODEL_ID);
  await modelPicker.selectOption(ALTERNATE_MODEL_ID);
  await page.locator('input[type="file"]').setInputFiles({
    name: "retry-noop.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(page.getByTitle("retry-noop.png")).toBeVisible();
  await page.getByRole("button", { name: "remove retry-noop.png" }).click();
  await expect(page.getByTitle("retry-noop.png")).toHaveCount(0);

  await steer.click();
  await expect.poll(() => posts.length).toBe(2);
  await expect(steer).toBeEnabled();
  expect(posts[1]?.clientMessageId).toBe(originalId);
  expect(posts[1]?.continuationModelId).toBe(ALTERNATE_MODEL_ID);

  await composer.fill("Genuinely changed canonical bytes");
  await steer.click();
  await expect.poll(() => posts.length).toBe(3);
  await expect(steer).toBeEnabled();
  expect(posts[2]?.clientMessageId).not.toBe(originalId);

  const changedPayloadId = posts[2]?.clientMessageId;
  await modelPicker.selectOption(MODEL_ID);
  await steer.click();
  await expect.poll(() => posts.length).toBe(4);
  expect(posts[3]?.clientMessageId).not.toBe(changedPayloadId);
  expect(posts[3]?.continuationModelId).toBe(MODEL_ID);
});

test("a terminal source model that is unavailable falls back to a selectable catalogue row", async ({
  page,
}) => {
  await serveModels(page, [
    { ...MODELS[0]!, available: false, reason: "This source model is unavailable." },
    MODELS[1]!,
    MODELS[2]!,
  ]);

  await openChat(page, FINISHED_RUN_ID);
  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  await expect(modelPicker).toHaveValue(ALTERNATE_MODEL_ID);
  await expect(modelPicker.getByRole("option")).toHaveCount(1);
  await expect(page.getByText(/The source model is unavailable/)).toContainText(
    "Haiku continuation model will be used instead.",
  );
});

test("no available continuation model disables both terminal actions", async ({ page }) => {
  await serveModels(
    page,
    MODELS.map((model) => ({ ...model, available: false, reason: "Not available." })),
  );

  await openChat(page, FINISHED_RUN_ID);
  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  await expect(modelPicker).toBeDisabled();
  await expect(modelPicker).toHaveValue("");
  await expect(page.getByText("No available model can start a continuation.")).toBeVisible();
  await expect(page.getByRole("button", { name: "send", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "steer", exact: true })).toBeDisabled();
});

test("the terminal model control stays contained at 320px and 200 percent zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await serveModels(page, [
    MODELS[0]!,
    {
      ...MODELS[1]!,
      id: "model-".repeat(40),
      label: "A deliberately long live catalogue label ".repeat(8),
    },
  ]);
  await openChat(page, FINISHED_RUN_ID);

  const modelPicker = page.getByRole("combobox", { name: "Continuation model" });
  await expect(modelPicker).toBeVisible();
  await modelPicker.focus();
  await expect(modelPicker).toBeFocused();
  await modelPicker.selectOption("model-".repeat(40));
  await expect(modelPicker).toHaveValue("model-".repeat(40));
  await page.evaluate(() => {
    document.body.style.zoom = "2";
  });
  expect(
    await modelPicker.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
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
