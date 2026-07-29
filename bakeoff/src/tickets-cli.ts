#!/usr/bin/env node
/**
 * tickets-cli.ts — the freeze tool.
 *
 * A separate entry point from cli.ts on purpose: this one WRITES
 * `tickets/FROZEN.json`, and the preflight CLI is read-only by design.
 *
 *   node dist/tickets-cli.js list      digests and sizes, never the brief text
 *   node dist/tickets-cli.js freeze    seal the set (idempotent; refuses on drift)
 *   node dist/tickets-cli.js verify    the check every run, score and report owes
 *
 * Everything written to stdout passes through the redaction chokepoint, for the
 * same reason cli.ts does it: a chokepoint with an exception is not a chokepoint.
 */

import { BakeoffError } from "./contracts.js";
import { redactForPersistence } from "./redact.js";
import {
  FROZEN_BASENAME,
  TICKETS_DIR,
  TicketFreezeError,
  formatTicketSummary,
  freezeTickets,
  loadTickets,
  verifyFrozen,
} from "./tickets.js";

const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;

function emit(text: string): void {
  process.stdout.write(`${redactForPersistence(text)}\n`);
}

function usage(): string {
  return [
    "bakeoff tickets — the six frozen reference briefs (doc 03 section 7.1)",
    "",
    "usage: npm run build && node dist/tickets-cli.js <command>",
    "",
    "commands:",
    "  list      id, tier, digest, size and title for each ticket (never the brief)",
    `  freeze    write tickets/${FROZEN_BASENAME}; idempotent, refuses to overwrite on drift`,
    "  verify    fail loudly if any brief changed since the freeze (default)",
    "  help      this text",
    "",
    "exit codes:",
    "  0  the set on disk matches the freeze",
    "  1  the set drifted, or was never frozen — DO NOT RUN, SCORE OR REPORT",
    "  2  usage error, or a ticket file is malformed",
    "",
    `tickets directory: ${TICKETS_DIR}`,
  ].join("\n");
}

function cmdList(): number {
  emit(formatTicketSummary(loadTickets()));
  return EXIT_OK;
}

function cmdFreeze(): number {
  const freeze = freezeTickets();
  const out: string[] = [];
  out.push(`frozen ${Object.keys(freeze.tickets).length} ticket(s) at ${freeze.frozenAt}`);
  for (const [id, digest] of Object.entries(freeze.tickets).sort()) out.push(`  ${id}  ${digest}`);
  out.push(`  set digest: ${freeze.setDigest}`);
  out.push("");
  out.push(`Record the set digest in the experiment log. From here the brief text is FROZEN:`);
  out.push("editing one invalidates every comparison, and verify will refuse to let a run start.");
  emit(out.join("\n"));
  return EXIT_OK;
}

function cmdVerify(): number {
  const { freeze, tickets } = verifyFrozen();
  emit(
    [
      `ticket set verified against ${FROZEN_BASENAME} (frozen ${freeze.frozenAt})`,
      formatTicketSummary(tickets),
    ].join("\n"),
  );
  return EXIT_OK;
}

function main(argv: readonly string[]): number {
  const command = argv[0] ?? "verify";
  switch (command) {
    case "list":
      return cmdList();
    case "freeze":
      return cmdFreeze();
    case "verify":
      return cmdVerify();
    case "help":
    case "--help":
    case "-h":
      emit(usage());
      return EXIT_OK;
    default:
      emit(`unknown command "${command}"\n\n${usage()}`);
      return EXIT_USAGE;
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof BakeoffError) {
    // Fail clean: a named code, the problem, and the exact action that clears it.
    emit(`error [${error.code}]: ${error.message}\nfix: ${error.remediation}`);
    // Drift and "never frozen" are the blocked outcome (1). A malformed ticket
    // file is an operator error (2). Both are loud; only one means the
    // experiment's inputs moved.
    process.exitCode = error instanceof TicketFreezeError ? EXIT_BLOCKED : EXIT_USAGE;
  } else {
    throw error;
  }
}
