/**
 * subscription-caller.live.test.ts — the one test that actually talks to the
 * subscription.
 *
 * IT IS OFF BY DEFAULT. `npm test` must never spend the owner's quota, so this
 * file no-ops unless DASHBOARD_LIVE_SMOKE=1. Run it deliberately:
 *
 *   DASHBOARD_LIVE_SMOKE=1 npm test
 *
 * WHAT IT PROVES, WHICH NOTHING ELSE CAN. Every other test stubs the model. The
 * claim this module rests on is that the EXISTING spec agent's seat-call path
 * can be driven with NO API KEY, over the CLI's subscription login, and that
 * the placeholder credential never reaches the network. That is only knowable
 * by running it: a passing type-check proves the subclass compiles, not that
 * the base class's HTTP client stayed unused.
 *
 * It is deliberately the SMALLEST call that can prove it — a five-word prompt
 * at the lowest effort rung — rather than a full suite authoring pass, because
 * the point is the wiring, not the output.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { AnthropicSeat } from "bakeoff/dist/contracts.js";
import { SPEC_SEAT } from "bakeoff/dist/config.js";
import { DASHBOARD_BUDGET } from "./orchestrator.js";
import { SubscriptionSeatCaller, seatImagesFor } from "./subscription-caller.js";

const LIVE = (process.env["DASHBOARD_LIVE_SMOKE"] ?? "") === "1";

test(
  "the spec seat runs over the subscription with no API key in the environment",
  { skip: LIVE ? false : "set DASHBOARD_LIVE_SMOKE=1 to spend a small amount of quota on this" },
  async () => {
    // The lowest rung this seat's ladder allows, and the CLI's own default
    // model. Both chosen to make the call cheap; neither is what a real spec
    // seat uses (doc 03 section 7.4 pins Opus-class xhigh).
    const seat: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };

    // The environment handed to the caller has NO Anthropic key. If the
    // subscription path were not working, the base class's client would be the
    // only way out, and it holds nothing but the sentinel.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    delete env["ANTHROPIC_BASE_URL"];

    const caller = new SubscriptionSeatCaller(seat, {
      budget: DASHBOARD_BUDGET,
      cwd: tmpdir(),
      env,
    });

    const result = await caller.call({
      system: "Reply with the single word: ready. Nothing else.",
      userTurns: ["Are you there?"],
      maxOutputTokens: 64,
      jsonSchema: null,
      purpose: "dashboard live smoke",
    });

    assert.match(result.text.toLowerCase(), /ready/, `unexpected reply: ${result.text.slice(0, 200)}`);
    assert.ok(result.usage.outputTokens > 0, "the subscription reported no output tokens");
    assert.equal(result.usage.costUsd, 0, "a subscription call has no dollar cost");
    assert.equal(caller.tokens.callCount, 1);
    assert.ok(caller.tokens.inputTokens > 0, "input tokens should be reported");

    // THE LOAD-BEARING ASSERTION: the base class recorded no usage, which means
    // its API-key client was never dispatched. Only the overridden call() ran.
    assert.doesNotThrow(() => caller.assertUnused());
    assert.equal(caller.hasUsage, false);
  },
);

test(
  "a SeatCallRequest's jsonSchema is APPLIED, not silently dropped",
  { skip: LIVE ? false : "set DASHBOARD_LIVE_SMOKE=1 to spend a small amount of quota on this" },
  async () => {
    // spec-agent sends `AUTHORING_JSON_SCHEMA` on every authoring call. If the
    // override quietly ignored it, the failure would present three layers up as
    // "the model keeps returning unparseable suites" — the most expensive way
    // possible to discover a dropped option. STATUS section 4 names this exact
    // parameter combination as the one that could not be verified without a
    // live credential; this verifies it over the subscription instead.
    const seat: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];

    const caller = new SubscriptionSeatCaller(seat, { budget: DASHBOARD_BUDGET, cwd: tmpdir(), env });
    const result = await caller.call({
      system: "You answer with structured data only.",
      userTurns: ["The colour is blue and the count is 3."],
      maxOutputTokens: 256,
      jsonSchema: {
        type: "object",
        properties: { colour: { type: "string" }, count: { type: "integer" } },
        required: ["colour", "count"],
        additionalProperties: false,
      },
      purpose: "dashboard schema smoke",
    });

    const parsed = JSON.parse(result.text) as { colour: string; count: number };
    assert.equal(parsed.colour.toLowerCase(), "blue");
    assert.equal(parsed.count, 3);
    assert.doesNotThrow(() => caller.assertUnused());
  },
);

/* -------------------------------------------------------------------------
 * The image probe — the ONE combination nothing else has ever run
 * ---------------------------------------------------------------------- */

/**
 * A PNG built here rather than committed as a fixture.
 *
 * WHY GENERATED: a binary in the tree is a thing nobody can review, and the
 * assertion below depends on knowing EXACTLY what is in the picture. This writes
 * the left half red (255,0,0) and the right half blue (0,0,255), so a model that
 * merely detects "an image is present" cannot pass — it has to read WHERE the
 * colours are, which is the image analogue of the PDF probe's table-row test.
 *
 * MEASURED: 193 bytes at 128x64, verified with file(1) ("PNG image data, 128 x
 * 64, 8-bit/color RGB, non-interlaced") and sips(1) before this test was written.
 * Truecolour, no palette, filter 0 on every scanline — the simplest encoding that
 * is still a valid PNG.
 */
function halfRedHalfBluePng(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([length, typed, checksum]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter type 0 for this scanline
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      const left = x < width / 2;
      raw[at] = left ? 255 : 0;
      raw[at + 1] = 0;
      raw[at + 2] = left ? 0 : 255;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "AN IMAGE BLOCK REACHES THE SEAT AND IS READ — streaming input + image + json_schema together",
  { skip: LIVE ? false : "set DASHBOARD_LIVE_SMOKE=1 to spend a small amount of quota on this" },
  async () => {
    /*
     * THE GAP THIS CLOSES, NAMED BY `subscription-caller.ts`'s OWN HEADER. The
     * document measurement asked a FREE-FORM question, so streaming input +
     * content block + `outputFormat: {type:"json_schema"}` had never been run
     * together — and every real authoring call this seat makes carries that
     * output format. If the combination were rejected, the document path would
     * have failed on the first live ticket carrying a PDF and the image path
     * would have failed on the first one carrying a mockup.
     *
     * IT ALSO PROVES `tools: []` DOES NOT BLOCK AN IMAGE. The seat has no Read
     * tool and cannot open the file this test wrote; the only way it can answer
     * is from the content block. If the picture did not arrive, the model has
     * nothing to describe and the assertion fails rather than passing vacuously.
     *
     * THAT LAST CLAIM IS MEASURED, NOT ASSUMED. Run 2026-08-02 with `images: []`
     * and every other argument identical, this test FAILED with left = "blue"
     * ('blue' !== 'red'). So the green version is reading the picture rather than
     * inferring red-then-blue from the wording of the question. Anyone changing
     * this test should re-run that control: swap `images` for `[]`, watch it go
     * red, and put it back.
     */
    const seat: AnthropicSeat = { ...SPEC_SEAT, modelId: "default", effort: "low" };
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["ANTHROPIC_API_KEY"];
    delete env["ANTHROPIC_AUTH_TOKEN"];
    delete env["ANTHROPIC_BASE_URL"];

    const dir = mkdtempSync(join(tmpdir(), "seat-image-live-"));
    const path = join(dir, "halves.png");
    const png = halfRedHalfBluePng(128, 64);
    writeFileSync(path, png);

    const images = seatImagesFor([{ path }]);
    const carried = images[0];
    assert.ok(carried !== undefined);
    assert.notEqual(carried.block, null, `the probe image was refused: ${String(carried.declined)}`);

    const caller = new SubscriptionSeatCaller(seat, {
      budget: DASHBOARD_BUDGET,
      cwd: tmpdir(),
      env,
      images,
    });

    const result = await caller.call({
      system:
        "You are shown one image. Report the dominant colour of its left half and of its right half, " +
        "each as a single lowercase English colour word.",
      userTurns: ["Which colour is on the left half, and which is on the right?"],
      maxOutputTokens: 256,
      // THE THIRD LEG OF THE COMBINATION. Without this the probe would only
      // repeat what the PDF measurement already established.
      jsonSchema: {
        type: "object",
        properties: { left: { type: "string" }, right: { type: "string" } },
        required: ["left", "right"],
        additionalProperties: false,
      },
      purpose: "dashboard image smoke",
    });

    const parsed = JSON.parse(result.text) as { left: string; right: string };
    assert.equal(parsed.left.toLowerCase(), "red", `left half read as "${parsed.left}"`);
    assert.equal(parsed.right.toLowerCase(), "blue", `right half read as "${parsed.right}"`);

    assert.equal(caller.imageCalls, 1);
    assert.equal(caller.imagePlan.blocks.length, 1);
    assert.equal(caller.imagePlan.base64Chars, png.toString("base64").length);
    // The base class's API-key client stayed unused: this went over the
    // subscription, like every other call this seat makes.
    assert.doesNotThrow(() => caller.assertUnused());
  },
);
