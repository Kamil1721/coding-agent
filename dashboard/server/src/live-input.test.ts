/**
 * live-input.test.ts — the generator must STAY OPEN.
 *
 * This is the one property whose failure is silent. The SDK ends a session when its
 * input iterable completes, so a queue that finishes on "no messages right now"
 * produces a run that stops after one turn with no error: the log shows a short run,
 * not a broken one. Asserting only on what was emitted cannot catch it — the first
 * yield is identical either way. So these tests assert on PENDING-ness.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { LiveInput, liveMessageText, userMessage } from "./live-input.js";

/** Resolves to `"pending"` if `promise` has not settled within a macrotask or two. */
async function settledOrPending<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
  ]);
}

test("the iterator PARKS after the first prompt instead of completing", async () => {
  /*
   * THE MUTATION THIS CATCHES: replacing the park with `return`, or writing the queue
   * as `async function*` over a snapshot array. Both yield the prompt correctly and
   * then end the session. Only the second `next()` tells them apart.
   */
  const input = new LiveInput("build the thing");
  const iterator = input[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.message.content, "build the thing");

  const second = await settledOrPending(iterator.next());
  assert.equal(
    second,
    "pending",
    "the iterator completed on an empty queue — the SDK would end the session here",
  );

  input.close();
});

test("a message pushed while parked wakes the iterator and is delivered", async () => {
  const input = new LiveInput("build the thing");
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();

  const waiting = iterator.next();
  // Pushed AFTER the iterator is already parked — the live case, not a pre-seeded one.
  input.push({ text: "make the hero warmer", images: [] });

  const delivered = await settledOrPending(waiting);
  assert.notEqual(delivered, "pending", "a push must wake a parked iterator");
  assert.equal(typeof delivered, "object");
  if (delivered === "pending") return;
  assert.equal(delivered.done, false);
  assert.match(String(delivered.value?.message.content), /make the hero warmer/);
});

test("close() is what ends the stream, and only close()", async () => {
  const input = new LiveInput("go");
  const iterator = input[Symbol.asyncIterator]();
  await iterator.next();

  const waiting = iterator.next();
  input.close();
  const ended = await settledOrPending(waiting);
  assert.notEqual(ended, "pending");
  if (ended === "pending") return;
  assert.equal(ended.done, true, "close() must end the iteration");
});

test("a push after close is refused rather than silently dropped", async () => {
  const input = new LiveInput("go");
  input.close();
  assert.equal(input.push({ text: "too late", images: [] }), false);
  assert.equal(input.closed, true);
});

test("the default delivery is `merge` — shouldQuery:false, the terminal's behaviour", () => {
  /*
   * `merge` cannot land mid-tool-call: the SDK folds it into the next user message
   * that queries. `next` runs it as its own turn instead. Getting the default wrong is
   * the difference between a message that waits politely and one that interrupts.
   */
  const merged = userMessage("hi", "merge");
  assert.equal(merged.shouldQuery, false);
  assert.equal(merged.priority, undefined);

  const queued = userMessage("hi", "next");
  assert.equal(queued.priority, "next");
  assert.equal(queued.shouldQuery, undefined);
});

test("attached images are named as absolute paths AND the agent is told to read them", () => {
  // A path in a prompt is what makes a Read happen; naming files without the
  // instruction produces a run that acknowledges an attachment it never opened.
  const text = liveMessageText({
    text: "use this reference",
    images: ["/runs/r1/chat/1-1.png", "/runs/r1/chat/1-2.png"],
  });
  assert.match(text, /Read each one before acting/);
  assert.match(text, /\/runs\/r1\/chat\/1-1\.png/);
  assert.match(text, /\/runs\/r1\/chat\/1-2\.png/);
});

test("the frozen-suite rule travels with every live message", () => {
  // The boundary path says this in `owner-message.ts`; the live path must not be the
  // quiet way around it.
  const text = liveMessageText({ text: "drop the booking form", images: [] });
  assert.match(text, /Never weaken a test/);
  assert.match(text, /keep the requirement working/);
});
