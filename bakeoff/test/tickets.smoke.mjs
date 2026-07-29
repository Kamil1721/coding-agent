/**
 * Freeze-behaviour smoke suite for src/tickets.ts.
 *
 *   npm run build && node test/tickets.smoke.mjs
 *
 * No test framework: it runs against the COMPILED `dist/` and asserts by hand,
 * so it works before any runner exists and cannot itself drift from the shipped
 * code. Every case operates on a scratch COPY of `tickets/`; the real directory
 * is never mutated.
 *
 * What it is actually checking is one claim: that a brief cannot change without
 * the harness stopping. `npx tsc --noEmit` cannot check that — it type-checks
 * nothing about digests.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const REAL = join(ROOT, "tickets");

if (!existsSync(join(DIST, "tickets.js"))) {
  console.error(`no build at ${DIST}. Run: npm run build`);
  process.exit(2);
}

const T = await import(`${DIST}/tickets.js`);
const H = await import(`${DIST}/hash.js`);

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function throws(name, fn, predicate) {
  try {
    fn();
    failures.push(`${name} — expected a throw, got none`);
  } catch (e) {
    if (predicate && !predicate(e)) {
      failures.push(`${name} — threw, but predicate failed: [${e.code}/${e.kind}] ${String(e.message).slice(0, 160)}`);
      return;
    }
    pass += 1;
  }
}

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), "bakeoff-tickets-"));
  cpSync(REAL, dir, { recursive: true });
  const frozen = join(dir, "FROZEN.json");
  if (existsSync(frozen)) rmSync(frozen);
  return dir;
}

// ---------------------------------------------------------------- 1. load
{
  const dir = freshDir();
  const tickets = T.loadTickets(dir);
  ok("loads six tickets", tickets.length === 6, `got ${tickets.length}`);
  ok("slot order", tickets.map((t) => t.id).join(",") === "T1,T2,T3,T4,T5,T6", tickets.map((t) => t.id).join(","));
  ok("tiers", tickets.map((t) => t.tier).join(",") === "trivial,trivial,medium,medium,hard,hard");
  ok("digests are sha256 hex", tickets.every((t) => /^[0-9a-f]{64}$/.test(t.sha256)));

  // The extraction rule: brief === bytes after the closing fence, byte-exact.
  const t5 = tickets.find((t) => t.id === "T5");
  const raw = readFileSync(t5.sourcePath, "utf8");
  const expected = raw.slice(raw.indexOf("\n---\n", 3) + 5);
  ok("brief is the verbatim tail", t5.brief === expected);
  ok("brief keeps its trailing newline", t5.brief.endsWith("\n"));
  ok("digest is over the raw brief", t5.sha256 === H.ticketDigest(expected));
  ok("briefForBuilder returns the brief only", T.briefForBuilder(t5) === expected);
  ok("brief carries no frontmatter", !t5.brief.includes("tier:") && !t5.brief.includes("title:"));
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------- 2. freeze lifecycle
{
  const dir = freshDir();
  throws("verify before freeze throws", () => T.verifyFrozen(dir), (e) => e.kind === "not_frozen");

  const first = T.freezeTickets(dir);
  ok("freeze wrote FROZEN.json", existsSync(join(dir, "FROZEN.json")));
  ok("freeze maps id -> sha256", Object.keys(first.tickets).sort().join(",") === "T1,T2,T3,T4,T5,T6");
  ok("freeze records the extraction rule", first.digestScope.includes("NO normalisation"));

  const second = T.freezeTickets(dir);
  ok("re-freeze is idempotent", second.frozenAt === first.frozenAt && second.setDigest === first.setDigest);

  const verified = T.verifyFrozen(dir);
  ok("verify passes on an untouched set", verified.tickets.length === 6);
  ok("set digest is stable", T.ticketSetDigest(verified.tickets) === first.setDigest);
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------ 3. one-byte brief mutation
{
  const dir = freshDir();
  T.freezeTickets(dir);
  const file = join(dir, "T3-job-tracker.md");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before.replace("there's four of us", "there are four of us"));

  throws("verify catches an edited brief", () => T.verifyFrozen(dir), (e) =>
    e.kind === "drift" && e.code === "suite_hash_mismatch" && e.drifts.length === 1 &&
    e.drifts[0].ticketId === "T3" && e.drifts[0].kind === "brief_changed" &&
    e.drifts[0].frozenSha256 !== e.drifts[0].actualSha256);
  throws("re-freeze refuses over drift", () => T.freezeTickets(dir), (e) => e.kind === "drift");

  let msg = "";
  try { T.verifyFrozen(dir); } catch (e) { msg = `${e.message}\n${e.remediation}`; }
  ok("drift message names the ticket", msg.includes("T3"));
  ok("drift message shows both digests in full", (msg.match(/[0-9a-f]{64}/g) ?? []).length >= 3);
  ok("drift message is unmissable", msg.includes("EVERY COMPARISON IN THE BAKE-OFF IS NOW INVALID"));
  ok("remediation forbids a force flag", msg.includes("no --force"));

  writeFileSync(file, before);
  ok("restoring the bytes clears the alarm", T.verifyFrozen(dir).tickets.length === 6);
  rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------- 4. whitespace-only change is drift
{
  const dir = freshDir();
  T.freezeTickets(dir);
  const file = join(dir, "T1-photography-portfolio.md");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before.replace(/\n$/, "")); // drop the trailing newline only
  throws("trailing-newline change is drift (no trimming)", () => T.verifyFrozen(dir), (e) => e.kind === "drift");
  writeFileSync(file, before);
  ok("restored", T.verifyFrozen(dir).tickets.length === 6);
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- 5. removed / added ticket
{
  const dir = freshDir();
  T.freezeTickets(dir);
  rmSync(join(dir, "T2-grooming-one-pager.md"));
  throws("a missing ticket file throws", () => T.verifyFrozen(dir), (e) => e.message.includes("T2"));
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = freshDir();
  writeFileSync(join(dir, "T7-extra.md"), `---\nid: T7\ntier: hard\ntitle: Extra\n---\n${"x ".repeat(80)}\n`);
  throws("a seventh ticket throws", () => T.loadTickets(dir), (e) => e.message.includes("T7"));
  rmSync(dir, { recursive: true, force: true });
}
{
  // The ticket_missing_from_disk drift kind is reachable only via a freeze that
  // records an id the loader does not see. Build one with a correct setDigest.
  const dir = freshDir();
  const real = T.freezeTickets(dir);
  const tickets = { ...real.tickets, T9: "a".repeat(64) };
  writeFileSync(join(dir, "FROZEN.json"), `${JSON.stringify({
    ...real,
    tickets,
    setDigest: H.canonicalJsonDigest({ digestVersion: 1, algorithm: "sha256", tickets }),
  }, null, 2)}\n`);
  throws("freeze naming an absent ticket throws", () => T.verifyFrozen(dir), (e) =>
    e.kind === "drift" && e.drifts.some((d) => d.ticketId === "T9" && d.kind === "ticket_missing_from_disk"));
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- 6. tampered freeze file
{
  const dir = freshDir();
  const real = T.freezeTickets(dir);
  const tampered = { ...real, tickets: { ...real.tickets, T4: "b".repeat(64) } };
  writeFileSync(join(dir, "FROZEN.json"), `${JSON.stringify(tampered, null, 2)}\n`);
  throws("hand-edited digest is caught by setDigest", () => T.verifyFrozen(dir), (e) => e.kind === "corrupt_freeze");

  writeFileSync(join(dir, "FROZEN.json"), "{not json");
  throws("corrupt JSON is caught", () => T.readFreeze(dir), (e) => e.kind === "corrupt_freeze");
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------- 7. hostile bytes / format
{
  const good = readFileSync(join(REAL, "T1-photography-portfolio.md"), "utf8");
  throws("CR is rejected", () => T.parseTicketFile(good.replaceAll("\n", "\r\n"), "x.md"),
    (e) => e.message.includes("carriage return"));
  throws("BOM is rejected", () => T.parseTicketFile(`﻿${good}`, "x.md"), (e) => e.message.includes("byte-order mark"));
  throws("no frontmatter", () => T.parseTicketFile("just a brief\n", "x.md"), (e) => e.message.includes("frontmatter fence"));
  throws("unclosed frontmatter", () => T.parseTicketFile("---\nid: T1\n", "x.md"), (e) => e.message.includes("closing"));
  throws("unknown key", () => T.parseTicketFile(good.replace("tier:", "priority:"), "x.md"),
    (e) => e.message.includes("unknown frontmatter key"));
  throws("duplicate key", () => T.parseTicketFile(good.replace("id: T1\n", "id: T1\nid: T1\n"), "x.md"),
    (e) => e.message.includes("appears twice"));
  throws("bad tier", () => T.parseTicketFile(good.replace("tier: trivial", "tier: easy"), "x.md"),
    (e) => e.message.includes("tier"));
  throws("bad id", () => T.parseTicketFile(good.replace("id: T1", "id: ticket-one"), "x.md"),
    (e) => e.message.includes("not of the form"));
  throws("empty brief", () => T.parseTicketFile("---\nid: T1\ntier: trivial\ntitle: X\n---\n\n", "x.md"),
    (e) => e.message.includes("near-empty"));
  throws("credential in a brief", () =>
    T.parseTicketFile(good.replace("hi -", "hi - my key is " + ["sk", "ant", "api03", "AAAAAAAAAAAAAAAAAAAAAAAA"].join("-") + " and"), "x.md"),
    (e) => e.message.includes("credential pattern"));

  const quoted = T.parseTicketFile(good.replace("title: Photographer portfolio site", 'title: "Photo: a site"'), "x.md");
  ok("double-quoted title parses", quoted.title === "Photo: a site", quoted.title);
  throws("unquoted colon is refused",
    () => T.parseTicketFile(good.replace("title: Photographer portfolio site", "title: Photo: a site"), "x.md"),
    (e) => e.message.includes("ambiguous unquoted YAML"));

  const dir = freshDir();
  const f = join(dir, "T1-photography-portfolio.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("tier: trivial", "tier: hard"));
  throws("tier must match the slot", () => T.loadTickets(dir), (e) => e.message.includes("REFERENCE_TICKET_SLOTS"));
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------- 8. reporting
{
  const dir = freshDir();
  const summary = T.formatTicketSummary(T.loadTickets(dir));
  ok("summary never prints a brief", !summary.includes("wedding fairs") && !summary.includes("golf app"));
  ok("summary carries the set digest", summary.includes("set digest:"));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`${pass} assertions passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exitCode = failures.length === 0 ? 0 : 1;
