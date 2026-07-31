/**
 * messages.test.ts — THE REPLY CHANNEL, and the silence it must not fill.
 *
 * WHAT WAS BROKEN, MEASURED ON THIS MACHINE. `dashboard/data/runs.db` holds one
 * chat message: the owner asked run `run-2026-07-30T20-16-40-242Z-052c6e02` "Give
 * me the link to the website", and the row carries
 * `delivered_at = 2026-07-31T05:49:32.721Z` — it reached the agent and was stamped
 * read. Nothing came back, because no code path anywhere turned what the agent
 * said into a `messages` row. The `run` direction has existed in the column, in
 * `ChatRole` and in the client's mirror since the table was created; it had no
 * producer. He noticed, and said so.
 *
 * THE PROPERTY THESE TESTS DEFEND IS NOT "A REPLY CAN BE STORED". It is that a
 * reply is stored ONLY when the agent actually produced one — that the absence of
 * an answer stays visible instead of being papered over with a sentence the run
 * never said. So the central test here asserts an ABSENCE, and carries a positive
 * control in the same test, because an absence assertion passes just as well
 * against a watch that reads nothing at all. A check that can only observe success
 * is the defect this repository keeps finding; it is not going to be introduced by
 * the file that closes the chat.
 *
 * WHAT THIS FILE CANNOT DO. It drives `AgentReplyWatch` against a real `RunStore`,
 * which is the whole mechanism from a raw transcript chunk to a durable row — but
 * it does NOT start a build, so it cannot prove `orchestrator.ts` calls any of it.
 * The last test reads that file as TEXT and is labelled a wiring check rather than
 * an execution test, because that is exactly what it is: it goes red if the call
 * is deleted, and it would stay green if the call were moved somewhere it never
 * runs.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { RunStore } from "./db.js";
import {
  AgentReplyWatch,
  ASSISTANT_RAW_PREFIX,
  REPLY_MAX_CHARS,
  REPLY_TRUNCATION_NOTE,
} from "./owner-message.js";

/**
 * This package's own sources, from the COMPILED location of this file.
 *
 * `import.meta.dirname` is `dashboard/server/dist` at run time, so `src` is one
 * directory up — the same depth argument `contract-parity.test.ts` makes and the
 * same failure mode if it is wrong: a source read that quietly finds nothing is a
 * check that can only pass, so `readSource` ASSERTS the file is there.
 */
const SRC = join(import.meta.dirname, "..", "src");
const CLAUDE_BUILDER = join(SRC, "builders", "claude-builder.ts");
const CODEX_BUILDER = join(SRC, "builders", "codex-builder.ts");
const ORCHESTRATOR = join(SRC, "orchestrator.ts");

function readSource(file: string): string {
  assert.ok(
    existsSync(file),
    `this check reads ${file} and it is not there. The file moved, or this test is ` +
      `running from an outDir that is not directly under dashboard/server.`,
  );
  return readFileSync(file, "utf8");
}

/** A run row, so the fixtures look like the thing they stand in for. */
function seed(store: RunStore, runId: string): void {
  store.createRun({
    runId,
    ticketId: `t-${runId}`,
    ticketTitle: runId,
    ticketText: "a landing page for a small studio",
    ticketSha256: "d".repeat(64),
    modelId: "default",
    provider: "anthropic",
    deploy: false,
    startedAt: new Date().toISOString(),
    queuePosition: 1,
  });
}

/**
 * One raw chunk, spelled the way the two drivers spell it.
 *
 * BUILT FROM THE EXPORTED CONSTANT rather than from a literal, so this helper
 * cannot be the thing that keeps the tests green after the constant changes. What
 * pins the constant to the drivers is the source-parity test at the bottom.
 */
function assistantChunk(text: string): string {
  return `${ASSISTANT_RAW_PREFIX}${text}\n`;
}

/** The other tags on the same seam. None of them is an assistant turn. */
const NOT_ASSISTANT = [
  "\n[command] npm run build\n> build succeeded\n",
  "\n[patch completed] index.html\n",
  "\n[reasoning]\nthinking about the hero image\n",
  "\n[result] success after 12 turn(s)\n",
];

/* ==================================================================
 * 1. THE ROUND TRIP
 * ================================================================== */

test("an owner message and a run reply round-trip with their directions intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-roundtrip-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-reply");

    // The owner asks, exactly as `postMessage` records it.
    const asked = store.appendMessage("run-reply", {
      role: "owner",
      text: "Give me the link to the website",
      images: [],
    });
    assert.equal(asked.role, "owner");

    // The segment opens its window BEFORE the drain — see the comment on
    // `segmentWindowStart` in orchestrator.ts — and the drain then stamps.
    const window = new Date().toISOString();
    store.markMessagesDelivered("run-reply", [asked.seq]);
    assert.equal(
      store.ownerMessagesDeliveredSince("run-reply", window),
      1,
      "a message stamped after the window opened is this segment's question",
    );

    // The segment runs. Only one of these chunks is a turn the agent took.
    const watch = new AgentReplyWatch();
    for (const chunk of NOT_ASSISTANT) watch.observe(chunk);
    watch.observe(assistantChunk("It is not deployed yet, so there is no link to give you."));

    const stored = watch.record(
      store,
      "run-reply",
      store.ownerMessagesDeliveredSince("run-reply", window),
    );
    assert.ok(stored !== null, "the agent spoke and the owner had asked, so there is a reply");
    assert.equal(stored.role, "run");
    assert.equal(stored.text, "It is not deployed yet, so there is no link to give you.");
    assert.equal(
      stored.deliveredAt,
      null,
      "delivery is an owner-row property; nothing here knows whether the owner read it",
    );

    // BOTH DIRECTIONS, IN ONE SEQUENCE — which is what `GET /api/runs/:id/messages`
    // serves and what makes a reply readable as a reply.
    const all = store.messages("run-reply");
    assert.equal(all.length, 2);
    const [first, second] = all;
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.role, "owner");
    assert.equal(first.text, "Give me the link to the website");
    assert.equal(second.role, "run");
    assert.ok(second.seq > first.seq, "seq orders the two directions against each other");

    // AND THE REPLY IS NOT AN INSTRUCTION. Without the `role = 'owner'` filter in
    // `pendingMessages` the run's own words would be folded back into its next
    // prompt and it would spend a segment answering itself.
    assert.equal(store.pendingMessages("run-reply").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
 * 2. THE FAILURE WATCHER — the test this feature exists to be constrained by
 * ================================================================== */

test("a turn that produced no summary stores NO reply row", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-silence-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-silent");
    const asked = store.appendMessage("run-silent", {
      role: "owner",
      text: "make the hero warmer",
      images: [],
    });
    const window = new Date().toISOString();
    store.markMessagesDelivered("run-silent", [asked.seq]);
    const spokenTo = store.ownerMessagesDeliveredSince("run-silent", window);
    assert.equal(spokenTo, 1, "the owner did speak — the gate is not what is being tested here");

    // A whole segment of transcript with no assistant turn in it. The last chunk
    // is the empty block the Codex driver emits for an item with no text: it is
    // tagged, and it is still not something the agent said.
    const silent = new AgentReplyWatch();
    for (const chunk of NOT_ASSISTANT) silent.observe(chunk);
    silent.observe(assistantChunk(""));
    silent.observe(`${ASSISTANT_RAW_PREFIX}   \n`);

    assert.equal(silent.lastSaid, null, "an empty block is not a message");
    assert.equal(
      silent.record(store, "run-silent", spokenTo),
      null,
      "no summary must produce no row — never a synthesised one",
    );

    // THE ASSERTION THAT MATTERS: nothing was written. Not "Working on it…", not
    // an acknowledgement, not an empty row. The UI is then free to say the run did
    // not answer, which is TRUE.
    assert.equal(
      store.messages("run-silent").filter((message) => message.role === "run").length,
      0,
      "a fabricated reply in a channel the owner trusts is worse than silence",
    );
    assert.equal(store.messages("run-silent").length, 1, "the owner's own message is untouched");

    /*
     * THE POSITIVE CONTROL, IN THE SAME TEST AND AGAINST THE SAME STORE.
     *
     * Every assertion above would also pass against an `AgentReplyWatch` that read
     * its input and threw it away, or one whose `record` returned null
     * unconditionally. This is the negative control for the negative: the ONLY
     * difference is that the transcript contains a turn.
     */
    const speaking = new AgentReplyWatch();
    for (const chunk of NOT_ASSISTANT) speaking.observe(chunk);
    speaking.observe(assistantChunk("Done — the hero is warmer and the copy is unchanged."));
    const row = speaking.record(store, "run-silent", spokenTo);
    assert.ok(row !== null, "the absence above must be the watch reading its input, not an inert watch");
    assert.equal(
      store.messages("run-silent").filter((message) => message.role === "run").length,
      1,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
 * 3. THE GATE — a reply answers a question, or it is not a reply
 * ================================================================== */

test("a segment the owner never spoke to stores no reply, however much the agent said", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-gate-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-quiet");
    const window = new Date().toISOString();

    // The agent finishes a segment and wraps up, as it does on every run.
    const watch = new AgentReplyWatch();
    watch.observe(assistantChunk("Built the page: hero, three cards, a contact form."));
    assert.ok(watch.lastSaid !== null, "it did say something");

    assert.equal(
      store.ownerMessagesDeliveredSince("run-quiet", window),
      0,
      "nobody asked this run anything",
    );
    assert.equal(
      watch.record(store, "run-quiet", store.ownerMessagesDeliveredSince("run-quiet", window)),
      null,
      "an unprompted wrap-up belongs in the log, not in a conversation with no question in it",
    );
    assert.equal(store.messages("run-quiet").length, 0);

    /*
     * POSITIVE CONTROL, ON THE SAME WATCH — which is only possible because the
     * gate does NOT consume the reply. The single variable between the null above
     * and the row below is the count.
     */
    const asked = store.appendMessage("run-quiet", { role: "owner", text: "any news?", images: [] });
    store.markMessagesDelivered("run-quiet", [asked.seq]);
    const row = watch.record(
      store,
      "run-quiet",
      store.ownerMessagesDeliveredSince("run-quiet", window),
    );
    assert.ok(row !== null, "the same words, once there is something to answer");
    assert.equal(row.role, "run");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a message taken up by an EARLIER segment is not this segment's question", () => {
  /*
   * THE WINDOW IS THE WHOLE GATE. Without the `>= since` comparison, every segment
   * after the first would count an instruction the previous segment already
   * answered, and a two-segment run would reply twice to one question — the second
   * time with words about something else entirely.
   *
   * The later instant is constructed rather than measured: two `toISOString()`
   * calls in one test can land in the same millisecond, and a comparison that is
   * `>=` would then be right and the test would still be flaky.
   */
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-window-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-window");
    const asked = store.appendMessage("run-window", {
      role: "owner",
      text: "use the blue reference",
      images: [],
    });
    store.markMessagesDelivered("run-window", [asked.seq]);

    const nextSegment = new Date(Date.now() + 60_000).toISOString();
    assert.equal(store.ownerMessagesDeliveredSince("run-window", nextSegment), 0);

    // The control: the same row, counted from before it was taken up.
    const earlier = new Date(Date.now() - 60_000).toISOString();
    assert.equal(store.ownerMessagesDeliveredSince("run-window", earlier), 1);

    // And an UNDELIVERED message is never counted from any instant: there is
    // nothing for the agent to have answered.
    store.appendMessage("run-window", { role: "owner", text: "and warmer", images: [] });
    assert.equal(store.ownerMessagesDeliveredSince("run-window", earlier), 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
 * 4. THE CAP, AND THE ROW THAT MUST NOT BE WRITTEN TWICE
 * ================================================================== */

test("a long reply is cut at the cap and says so; a short one is stored whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-cap-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-cap");

    const long = "the hero is warmer and the cards are aligned. ".repeat(80).trim();
    assert.ok(long.length > REPLY_MAX_CHARS, "the fixture must actually exceed the cap");

    const watch = new AgentReplyWatch();
    watch.observe(assistantChunk(long));
    const row = watch.record(store, "run-cap", 1);
    assert.ok(row !== null);
    assert.ok(row.text.length < long.length, "it was cut");
    assert.ok(
      row.text.endsWith(REPLY_TRUNCATION_NOTE),
      "a clipped reply must read as clipped, not as an answer that stopped mid-sentence",
    );
    assert.equal(row.text.length, REPLY_MAX_CHARS + REPLY_TRUNCATION_NOTE.length);
    assert.ok(row.text.startsWith(long.slice(0, 200)), "the kept part is the agent's own words");

    // RECORDING TWICE IS A NO-OP. The reply is consumed on the way out, so a
    // caller that ran the end-of-segment path twice cannot duplicate a row in the
    // owner's chat.
    assert.equal(watch.record(store, "run-cap", 1), null);
    assert.equal(store.messages("run-cap").filter((m) => m.role === "run").length, 1);

    // THE CONTROL FOR THE CAP: an ordinary reply is not touched at all, so a
    // truncation note can never appear on a message that was not truncated.
    const short = new AgentReplyWatch();
    short.observe(assistantChunk("Deployed at http://127.0.0.1:4321 — it dies with the run."));
    const plain = short.record(store, "run-cap", 1);
    assert.ok(plain !== null);
    assert.equal(plain.text, "Deployed at http://127.0.0.1:4321 — it dies with the run.");
    assert.ok(!plain.text.includes(REPLY_TRUNCATION_NOTE));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
 * 5. THE MIGRATION — an older database must OPEN, not throw
 * ================================================================== */

test("a database written before the direction column opens, and its rows read as owner", () => {
  /*
   * REPRODUCED, NOT ASSUMED. Every test in this repo opens a store under `mkdtemp`,
   * where `CREATE TABLE IF NOT EXISTS` always includes the newest column and the
   * migration path is never taken — so the old shape is recreated with
   * `ALTER TABLE ... DROP COLUMN` (a real statement in the SQLite Node 24 ships)
   * and the drop is ASSERTED before the reopen, exactly as `db.test.ts` does for
   * the `runs` table. Without that assertion the fixture could silently stop
   * reproducing anything and this test would still be green.
   *
   * WHAT IT DOES NOT CLAIM: that such a database exists. `messages` and its `role`
   * column shipped in the same commit, and the owner's `runs.db` has the column.
   * `ADDED_MESSAGE_COLUMNS` in db.ts says so at length. This test proves the hook
   * works, so that the NEXT column added to this table is not the one that throws
   * on his machine and nowhere else.
   */
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-migrate-"));
  const file = join(dir, "runs.db");
  const before = RunStore.open(file);
  seed(before, "run-old");
  before.appendMessage("run-old", { role: "owner", text: "make the hero warmer", images: [] });
  before.close();

  const raw = new DatabaseSync(file);
  raw.exec("ALTER TABLE messages DROP COLUMN role");
  const columns = raw
    .prepare("PRAGMA table_info(messages)")
    .all()
    .map((column) => String(column["name"]));
  assert.ok(!columns.includes("role"), "the fixture must actually reproduce the pre-direction schema");
  assert.ok(columns.includes("text"), "…and must not have destroyed the rest of the table");
  raw.close();

  const after = RunStore.open(file);
  try {
    // 1. IT OPENED. On its own this proves little — `RunStore.open` would not have
    //    thrown either way, because the missing column is only reached by a query.
    //    It is asserted because "the owner's dashboard starts" is the outcome.
    assert.ok(after.getRun("run-old") !== null);

    // 2. THE READ THAT WOULD THROW `no such column: role` WITHOUT THE MIGRATION.
    const all = after.messages("run-old");
    assert.equal(all.length, 1, "the historical row survived the migration");
    const only = all[0];
    assert.ok(only !== undefined);
    assert.equal(only.role, "owner", "a row written before the column existed was the owner's");
    assert.equal(
      after.pendingMessages("run-old").length,
      1,
      "and an unstamped historical row is still an instruction, not a reply",
    );

    // 3. THE MIGRATED TABLE TAKES BOTH DIRECTIONS.
    after.appendMessage("run-old", { role: "run", text: "warmer now", images: [] });
    assert.deepEqual(
      after.messages("run-old").map((message) => message.role),
      ["owner", "run"],
    );
  } finally {
    after.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ==================================================================
 * 6. THE TWO SOURCE READS — drift, and wiring
 * ================================================================== */

test("both builders still tag an assistant turn the way the reply watch reads it", () => {
  /*
   * THE DRIFT THIS CATCHES, AND WHY IT NEEDS A TEST AT ALL. `ASSISTANT_RAW_PREFIX`
   * is a THIRD spelling of a literal that lives in two driver files, and neither
   * driver can import it today. A driver that renamed its tag would stop producing
   * replies with every other test green — the watch would simply never find a
   * turn, and "the run did not answer" is exactly what the UI says for that,
   * which is the failure mode that hides best.
   *
   * The searched string is DERIVED from the constant, so changing the constant
   * changes what is looked for and this cannot become a third hardcode of its own.
   */
  const sourceSpelling = ASSISTANT_RAW_PREFIX.replaceAll("\n", "\\n");
  assert.equal(sourceSpelling, "\\n[assistant]\\n");

  for (const file of [CLAUDE_BUILDER, CODEX_BUILDER]) {
    const source = readSource(file);
    assert.ok(
      source.includes(`sink.raw(\`${sourceSpelling}`),
      `${file} no longer writes ${sourceSpelling} to the raw seam, so the reply channel ` +
        `silently captures nothing from it. Update ASSISTANT_RAW_PREFIX in owner-message.ts, ` +
        `or give the driver back its tag.`,
    );
  }
});

test("orchestrator.ts still feeds the raw seam into the reply watch (A WIRING READ, NOT AN EXECUTION TEST)", () => {
  /*
   * SAID IN THE TITLE BECAUSE IT IS THE LIMIT OF THIS CHECK. Nothing here starts a
   * build. It reads the file and asserts the three calls that connect the tested
   * mechanism to the running system are present, which goes red if one is deleted
   * and stays green if one is moved somewhere it never executes. The honest cover
   * for that gap is a live run, which costs subscription quota and is the
   * orchestrating session's to spend.
   */
  const source = readSource(ORCHESTRATOR);
  assert.match(
    source,
    /raw:\s*\(text\)\s*=>\s*\{[\s\S]{0,800}?reply\.observe\(text\)/,
    "the raw seam no longer reaches the reply watch, so no reply can ever be captured",
  );
  assert.match(source, /new AgentReplyWatch\(\)/);
  assert.match(
    source,
    /reply\.record\(/,
    "nothing stores the reply, so the watch observes a whole segment and drops it",
  );
  assert.match(
    source,
    /ownerMessagesDeliveredSince\(runId, segmentWindowStart\)/,
    "the gate no longer reads the segment's own window, so replies are counted against the wrong one",
  );
});

/**
 * THE RECEIPT PROBLEM: A REPLY THAT ARRIVES WHEN THE SEGMENT ENDS IS NOT A REPLY.
 *
 * MEASURED, ON THE OWNER'S OWN RUN. He asked "Give me the link to the website",
 * the message was delivered and stamped `read at 10:09:53`, and the chat showed
 * "no reply has been recorded yet" — because `record()` only wrote at the segment
 * boundary and a build segment runs for tens of minutes. He asked where his reply
 * was, and he was right to.
 *
 * The text was in hand the whole time: `observe()` sees every assistant turn as it
 * happens. Only the WRITE was deferred. So the first substantive turn after a
 * delivered question is now written immediately.
 */
test("a question delivered mid-segment is answered when the agent SPEAKS, not when the segment ends", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-now-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-x");
    const watch = new AgentReplyWatch();
    watch.expectReply(store, "run-x");

    // Not a reply: the raw seam carries other records too.
    for (const chunk of NOT_ASSISTANT) watch.observe(chunk);
    assert.equal(store.messages("run-x").length, 0, "a command echo is not the agent answering");

    watch.observe(assistantChunk("The site is served at /api/runs/run-x/preview/"));
    const said = store.messages("run-x").filter((m: { role: string }) => m.role === "run");
    assert.equal(said.length, 1, "the agent spoke and the owner was owed an answer — it must be stored NOW");
    assert.match(said[0]?.text ?? "", /preview/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unasked segment stores nothing, however much the agent says", () => {
  // The failure watcher. Without `expectReply`, every wrap-up sentence in every
  // run would land in a chat that has no question in it.
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-unasked-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-x");
    const watch = new AgentReplyWatch();
    watch.observe(assistantChunk("I have finished the build."));
    assert.equal(
      store.messages("run-x").filter((m: { role: string }) => m.role === "run").length,
      0,
      "nobody asked, so nothing belongs in the conversation",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the boundary record does NOT duplicate a reply already written", () => {
  const dir = mkdtempSync(join(tmpdir(), "dash-msg-nodup-"));
  const store = RunStore.open(join(dir, "runs.db"));
  try {
    seed(store, "run-x");
    const watch = new AgentReplyWatch();
    watch.expectReply(store, "run-x");
    watch.observe(assistantChunk("Here is the link."));
    watch.record(store, "run-x", 1);
    assert.equal(
      store.messages("run-x").filter((m: { role: string }) => m.role === "run").length,
      1,
      "answering immediately and then recording again would show the owner the same reply twice",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
