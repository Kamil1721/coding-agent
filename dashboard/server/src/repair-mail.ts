/**
 * repair-mail.ts — the one component in this program that sends an email, and
 * the promise it makes is that it can never take anything down with it.
 *
 * ─── WHY IT EXISTS ───
 *
 * The owner's words, 2026-08-16: *"it sent an email to me on what went wrong and
 * what it's done to fix it, as a summary with natural human language that's easy
 * to understand."* {@link "./repair-report.js"} renders that summary; this file
 * is the delivery, and it is the SECOND half of a two-channel rule the owner
 * settled the same day:
 *
 *   1. the report is ALWAYS written to disk under the dashboard's results root,
 *      so a mail outage never loses a repair record;
 *   2. it is ADDITIONALLY sent over SMTP when {@link REPAIR_MAIL_ENV.smtpUrl} is
 *      set.
 *
 * Channel 2 is therefore a convenience over a record that already exists.
 * Nothing here may throw into a repair, and {@link sendRepairMail} is written so
 * that "never throws" is a property of its own body rather than a promise about
 * its callers: every failure — a bad URL, a refused connection, a 550 at RCPT, a
 * hung server, a bug in this file — comes back as a {@link RepairMailResult}
 * with a named code. `repair-mail.test.ts` proves it by injecting a transport
 * that throws synchronously and asserting the call resolves.
 *
 * ─── WHY node:net / node:tls AND NOT AN SMTP LIBRARY ───
 *
 * `dashboard/server/package.json` has three runtime dependencies (the two SDKs
 * and `sharp`) plus `bakeoff`. The protocol this file speaks is EHLO, optional
 * STARTTLS, optional AUTH, MAIL FROM, RCPT TO, DATA — a state machine of about
 * six replies, all of which are exercised below against a fake server built on
 * `node:net`. A dependency would add a supply-chain surface to a process that
 * holds the owner's subscription session, in exchange for code that would be
 * mostly unexercised anyway: this deployment sends one short text/plain message
 * to one address.
 *
 * ─── WHAT IS AND IS NOT MEASURED, STATED BEFORE THE CODE ───
 *
 * MEASURED: the full conversation against a fake SMTP server on 127.0.0.1
 * (greeting → EHLO → MAIL/RCPT/DATA → the base64 body the server received →
 * QUIT), the refusal arms (bad scheme, bad address, 550 at RCPT, a transport
 * that throws, a server that never answers), header-injection stripping, and
 * AUTH PLAIN over a transport that reports itself secure.
 *
 * UNVERIFIED, AND NAMED RATHER THAN IMPLIED: no message has ever been sent to a
 * REAL SMTP server from this machine. `tls.connect` and the STARTTLS upgrade are
 * therefore unexercised end to end — the state machine around them is tested
 * through the {@link SmtpConnect} seam, but node's TLS handshake against a real
 * MTA is not. The first live send is also the first proof that the credential
 * shape, the port and the server's capability set are what this file assumes.
 *
 * ─── THE CREDENTIAL RULE, AND THE ONE HOLE THIS LANE COULD NOT CLOSE ───
 *
 * `REPAIR_SMTP_URL` carries a password in its userinfo. Three consequences are
 * handled here: it is never written to a file (see {@link describeSmtpTarget},
 * which is the only renderable form of a target), it is never put in a
 * `RepairMailResult.detail` (transport errors are scrubbed by
 * {@link scrubUrlCredentials} before they are returned), and it is never sent
 * over a connection that is not encrypted ({@link SMTP_CODES.credentialOnPlaintext}).
 *
 * THE HOLE, MEASURED 2026-08-16 AND NOT FIXED HERE: `subprocess-env.ts`'s
 * `subscriptionSubprocessEnv` is a SUBTRACTION, not an allowlist — its own
 * docblock says so — so `REPAIR_SMTP_URL` is inherited by every SDK subprocess
 * this program spawns, including the builder, which has Bash. The one-line fix
 * is to add the name to `STRIPPED_ENV_NAMES`, and that file is outside this
 * lane. Carried forward, named, not closed.
 */

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";

/**
 * Non-secret configuration. NAMES ONLY — the same rule and the same shape as
 * `paths.ts#DASHBOARD_ENV`, which says *"Names only; no value here is ever a
 * credential."*
 *
 * WHY THESE NAMES ARE NOT IN `DASHBOARD_ENV`. That object is the dashboard's
 * path and process configuration and every member of it is read by
 * `resolvePaths`/`gateEnv`; `paths.ts` is also outside this lane's write set.
 * The convention it establishes — a frozen names-only object beside the code
 * that reads it, and functions that take `env: NodeJS.ProcessEnv` rather than
 * touching `process.env` in the middle of a call tree — is what is copied.
 */
export const REPAIR_MAIL_ENV = Object.freeze({
  /**
   * `smtp://user:password@host:port` or `smtps://…`. EMPTY BY DEFAULT, which
   * means no mail is sent at all and the disk report is the only copy. That is
   * a supported, silent-free state: the report says so in its own last section.
   */
  smtpUrl: "REPAIR_SMTP_URL",
  /** Where the report goes. Defaults to {@link DEFAULT_REPAIR_MAIL_TO}. */
  mailTo: "REPAIR_MAIL_TO",
  /**
   * The envelope sender. Defaults to the recipient, because the common setup
   * here is an account mailing itself and a `From` that the relay does not own
   * is the fastest way to be filed as spam.
   */
  mailFrom: "REPAIR_MAIL_FROM",
});

/**
 * The owner's address, chosen by him on 2026-08-16 and hard-defaulted so that a
 * dashboard with an SMTP URL and nothing else still reaches a human.
 *
 * AN ADDRESS IS NOT A CREDENTIAL. It is already in this repository's git
 * configuration (`git log --format=%ae`), so writing it here leaks nothing that
 * a clone does not already carry — unlike the password in `REPAIR_SMTP_URL`,
 * which has no default and no literal anywhere in this tree.
 */
export const DEFAULT_REPAIR_MAIL_TO = "borzeckikamil7@gmail.com";

/** Every named outcome this file can produce. One string, one meaning. */
export const SMTP_CODES = Object.freeze({
  sent: "MAIL_SENT",
  notConfigured: "MAIL_NOT_CONFIGURED",
  badUrl: "SMTP_URL_INVALID",
  badAddress: "MAIL_ADDRESS_INVALID",
  connectFailed: "SMTP_CONNECT_FAILED",
  protocol: "SMTP_PROTOCOL_ERROR",
  rejected: "SMTP_SERVER_REFUSED",
  authFailed: "SMTP_AUTH_FAILED",
  credentialOnPlaintext: "SMTP_CREDENTIAL_ON_PLAINTEXT",
  timedOut: "SMTP_TIMED_OUT",
  /** The catch of last resort. A bug in this file is still a mail outcome. */
  unexpected: "MAIL_SENDER_FAULT",
});

/** How long the whole conversation may take, greeting to QUIT. */
export const SMTP_TIMEOUT_MS = 20_000;

/** Longest base64 line in the body. RFC 2045 says 76 characters. */
const BASE64_LINE = 76;

/* =========================================================================
 * Configuration
 * ====================================================================== */

export interface SmtpTarget {
  readonly scheme: "smtp" | "smtps";
  readonly host: string;
  readonly port: number;
  /** Null when the URL carried no userinfo — an open relay on localhost. */
  readonly username: string | null;
  readonly password: string | null;
}

export type SmtpUrlParse =
  | { readonly ok: true; readonly target: SmtpTarget }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * Read `REPAIR_SMTP_URL` into a target.
 *
 * THE DETAIL STRING MAY NOT QUOTE THE URL, and that is why this returns a code
 * plus a sentence rather than `new Error(\`bad url: ${raw}\`)`. A malformed URL
 * is the case most likely to carry a correctly-typed password beside a typo'd
 * host, and the error text is the thing most likely to be written to a log.
 *
 * PORT DEFAULTS ARE THE SUBMISSION PORTS, not port 25: 587 for `smtp:`
 * (submission, STARTTLS) and 465 for `smtps:` (implicit TLS). Port 25 is
 * server-to-server relay and is blocked outbound by most networks.
 */
export function parseSmtpUrl(raw: string): SmtpUrlParse {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, code: SMTP_CODES.notConfigured, detail: "no SMTP server is configured, so no email was attempted" };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: SMTP_CODES.badUrl,
      detail: `${REPAIR_MAIL_ENV.smtpUrl} is not a URL. It has to look like smtp://user:password@host:587 or smtps://user:password@host:465. The value itself is not quoted here on purpose.`,
    };
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "smtp" && scheme !== "smtps") {
    return {
      ok: false,
      code: SMTP_CODES.badUrl,
      detail: `${REPAIR_MAIL_ENV.smtpUrl} uses the "${scheme}" scheme; only smtp and smtps are understood`,
    };
  }
  if (url.hostname === "") {
    return { ok: false, code: SMTP_CODES.badUrl, detail: `${REPAIR_MAIL_ENV.smtpUrl} names no host` };
  }
  const port = url.port === "" ? (scheme === "smtps" ? 465 : 587) : Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ok: false, code: SMTP_CODES.badUrl, detail: `${REPAIR_MAIL_ENV.smtpUrl} names port "${url.port}", which is not a port number` };
  }
  /*
   * `URL.username`/`URL.password` PERCENT-DECODE, and that is the whole reason
   * they are read here rather than sliced out of the raw string: a password
   * containing `/`, `@` or `%` must be written percent-encoded in the URL, and
   * the bytes the SMTP AUTH command needs are the decoded ones. It also means
   * the decoded form is a SECOND string that must never be printed — see
   * `scrubUrlCredentials`, which redacts both.
   */
  const username = url.username === "" ? null : decodeURIComponent(url.username);
  const password = url.password === "" ? null : decodeURIComponent(url.password);
  return { ok: true, target: { scheme: scheme === "smtps" ? "smtps" : "smtp", host: url.hostname, port, username, password } };
}

/**
 * The ONLY renderable form of a target: where mail went, never who it went as
 * and never the secret.
 *
 * Everything that writes a delivery record, a log line or an error detail calls
 * this. `repair-report.test.ts` and `repair-mail.test.ts` both assert that a
 * randomly generated password is absent from every byte those paths produce.
 */
export function describeSmtpTarget(target: SmtpTarget): string {
  const auth = target.username === null ? "no sign-in" : "signing in with the configured account";
  return `${target.scheme}://${target.host}:${String(target.port)} (${auth})`;
}

export interface RepairMailConfig {
  /** False means "no email will be attempted", which is a normal state. */
  readonly configured: boolean;
  readonly target: SmtpTarget | null;
  readonly to: string;
  readonly from: string;
  /**
   * One sentence for a human, safe to write to disk. When `configured` is
   * false it says WHY, because a report that silently never mails is
   * indistinguishable from a mailer that is broken.
   */
  readonly why: string;
}

/** Read the three variables. Never throws; a bad URL comes back unconfigured. */
export function resolveRepairMailConfig(env: NodeJS.ProcessEnv): RepairMailConfig {
  const to = (env[REPAIR_MAIL_ENV.mailTo] ?? "").trim() || DEFAULT_REPAIR_MAIL_TO;
  const from = (env[REPAIR_MAIL_ENV.mailFrom] ?? "").trim() || to;
  const parsed = parseSmtpUrl(env[REPAIR_MAIL_ENV.smtpUrl] ?? "");
  if (!parsed.ok) {
    return {
      configured: false,
      target: null,
      to,
      from,
      why:
        parsed.code === SMTP_CODES.notConfigured
          ? `No email was sent: no mail server is configured (${REPAIR_MAIL_ENV.smtpUrl} is empty), so this file is the only copy of this report.`
          : `No email was sent: ${parsed.detail}. This file is the only copy of this report.`,
    };
  }
  return {
    configured: true,
    target: parsed.target,
    to,
    from,
    why: `This report was also emailed to ${to} through ${describeSmtpTarget(parsed.target)}.`,
  };
}

/* =========================================================================
 * The message
 * ====================================================================== */

/**
 * An address, or null.
 *
 * CR AND LF ARE THE POINT. A `To:` built from an unchecked string is header
 * injection: one `\r\n` and the rest of the value becomes a `Bcc:`. The address
 * shape below excludes both by construction, and `repair-mail.test.ts` feeds a
 * `\r\nBcc:` address and asserts the message is refused rather than sent with an
 * extra header.
 */
const ADDRESS = /^[^\s<>,;@]{1,120}@[^\s<>,;@]{1,180}\.[^\s<>,;@]{1,40}$/;

export function validAddress(value: string): boolean {
  return ADDRESS.test(value.trim());
}

/**
 * A subject line that cannot inject a header and cannot need MIME encoding.
 *
 * Non-ASCII is TRANSLITERATED AWAY rather than RFC 2047 encoded, because this
 * repository's prose is full of em dashes and an encoded-word implementation is
 * a second thing to be wrong about for a line nobody reads twice. The body
 * keeps its UTF-8 (it is base64 MIME), so nothing the owner is meant to read is
 * degraded.
 */
export function safeSubject(raw: string): string {
  const flat = raw.replace(/[\r\n\t]+/g, " ").replace(/[‐-―]/g, "-").replace(/[^\x20-\x7E]/g, "");
  const collapsed = flat.replace(/\s{2,}/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}

/** `Sat, 16 Aug 2026 09:14:02 +0000`. RFC 5322 §3.3, always UTC. */
export function rfc5322Date(at: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const two = (n: number): string => String(n).padStart(2, "0");
  return (
    `${days[at.getUTCDay()] ?? "Mon"}, ${two(at.getUTCDate())} ${months[at.getUTCMonth()] ?? "Jan"} ${String(at.getUTCFullYear())} ` +
    `${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} +0000`
  );
}

export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly date: Date;
  readonly messageId: string;
}

/**
 * The RFC 5322 message, CRLF-terminated, ready for DATA.
 *
 * THE BODY IS BASE64 AND THAT IS A CORRECTNESS DECISION, NOT A STYLE ONE. Two
 * problems disappear at once: 8-bit UTF-8 in a body sent to a server that never
 * advertised 8BITMIME (this report is full of em dashes), and DOT-STUFFING — a
 * body line consisting of a single `.` terminates DATA early, and a report that
 * quoted a diff could produce one. Base64 output contains neither, so the
 * transmission path has no escaping rule to get wrong.
 */
export function renderMailMessage(message: MailMessage): string {
  const encoded = Buffer.from(message.body, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += BASE64_LINE) lines.push(encoded.slice(i, i + BASE64_LINE));
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${safeSubject(message.subject)}`,
    `Date: ${rfc5322Date(message.date)}`,
    `Message-ID: ${message.messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    /*
     * NOT A COURTESY HEADER. This message is generated by an unattended loop;
     * an autoresponder or an out-of-office reply bouncing back into the owner's
     * inbox for every repair is noise he did not ask for. RFC 3834 §5.
     */
    "Auto-Submitted: auto-generated",
  ];
  return [...headers, "", ...lines].join("\r\n");
}

/** `<repair-2026-08-16T09-14-02-000Z-1a2b3c4d@host>`, unique per report. */
export function messageIdFor(at: Date, nonce: string, from: string): string {
  const domain = from.split("@")[1] ?? "dashboard.localhost";
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  return `<repair-${stamp}-${nonce}@${domain}>`;
}

/* =========================================================================
 * Redaction
 * ====================================================================== */

/**
 * Redact the userinfo of every URL in a string, in BOTH the encoded and the
 * decoded form of the secret.
 *
 * WHY BOTH. A password with a `/` in it is written `%2F` in the URL and comes
 * back as `/` from `URL.password`; an error message built by this file could
 * carry either. The regex handles the encoded form (it never crosses an `@`);
 * `extra` handles the decoded values the caller knows about.
 *
 * THIS IS A BACKSTOP, NOT THE MECHANISM. The mechanism is that no code path
 * here interpolates a URL into a message at all — {@link describeSmtpTarget} is
 * the only renderer of a target. This exists because the strings this file
 * returns include `error.message` from `node:net`, which quotes whatever it was
 * given, and because a mechanism nobody can accidentally bypass is worth its
 * eight lines.
 */
export function scrubUrlCredentials(text: string, extra: readonly string[] = []): string {
  let out = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, "$1[redacted]@");
  for (const secret of extra) {
    if (secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
    /*
     * AND AGAIN, WHITESPACE-INSENSITIVELY, BECAUSE THE EXACT MATCH ABOVE IS NOT
     * ENOUGH. Corrected 2026-08-16 after an adversarial review demonstrated a
     * leak into BOTH the on-disk report and the emailed body.
     *
     * `renderRepairReport` folds prose to a column: `wrap` splits on `/\s+/` and
     * rejoins the words across line breaks. A credential containing a space —
     * a Gmail app-password is famously shown as four space-separated groups —
     * is therefore ALREADY broken across a newline by the time this function,
     * the only secrets-aware pass, runs on the whole document. `split(secret)`
     * then finds nothing and the credential ships.
     *
     * Matching any whitespace run in the secret against `\s+` in the text closes
     * it wherever the fold happened to land, and keeps working for anything
     * composed after this point — which the exact-match pass alone could not
     * promise. Redacting at every entry point instead would mean threading
     * `secrets` through `oneLine`, `wrap` and every caller, and any new
     * composition site added later would silently opt out of protection.
     */
    const folded = secret
      .trim()
      .split(/\s+/)
      .filter((part) => part !== "")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (folded.length > 1) {
      out = out.replace(new RegExp(folded.join("\\s+"), "g"), "[redacted]");
    }
  }
  return out;
}

/* =========================================================================
 * The transport seam
 * ====================================================================== */

export interface SmtpTransport {
  readonly stream: Duplex;
  /**
   * True when the bytes are encrypted. READ, NEVER ASSUMED: it is what gates
   * AUTH, so a transport that reports `false` cannot be made to send a
   * credential by any server response.
   */
  readonly secure: boolean;
  /** STARTTLS. Null when this transport cannot upgrade (a test double, mostly). */
  readonly upgrade: (() => Promise<SmtpTransport>) | null;
  readonly close: () => void;
}

/** How the conversation reaches a server. Injected so no test needs a network. */
export type SmtpConnect = (target: SmtpTarget, timeoutMs: number) => Promise<SmtpTransport>;

/**
 * The production transport: `tls.connect` for smtps, `net.connect` for smtp.
 *
 * `secure: true` IS ASSERTED ONLY BY A COMPLETED HANDSHAKE, never by a flag on
 * a socket. `tls.connect` defaults to `rejectUnauthorized: true` and this file
 * never overrides it, so reaching either callback below means the server
 * presented a certificate node's trust store accepts. Nothing here weakens that
 * — a mail path that skipped verification would make the encryption a formality
 * and the AUTH gate below a lie.
 *
 * UNVERIFIED: never executed against a real server. See the module docblock.
 */
export const netSmtpConnect: SmtpConnect = async (target, timeoutMs) =>
  new Promise<SmtpTransport>((resolve, reject) => {
    /*
     * A CONNECT THAT NEVER COMPLETES MUST DESTROY ITS SOCKET, NOT JUST REJECT.
     *
     * `net`/`tls` raise `timeout` and DO NOTHING ELSE — the socket stays open
     * and the handle keeps the event loop alive. `runSmtpConversation`'s
     * `finally` cannot help: on this path it never got a transport to close. In
     * a supervisor ticking every 30 s that is one leaked pending socket per
     * unreachable server, so the timeout handler destroys WITH an error, which
     * is also what settles this promise.
     *
     * `setTimeout(0)` once connected, because the option is an IDLE timer, not
     * a connect timer: left armed it would kill a live conversation with a slow
     * but healthy server. The conversation has its own deadline
     * (`runSmtpConversation`), and that is the one that should govern after
     * this point.
     *
     * UNVERIFIED BY TEST: exercising a connect timeout needs a host that drops
     * SYN, which is not something a unit test can rely on. Every test here
     * injects the transport seam instead.
     */
    const armConnectTimeout = (socket: { setTimeout: (ms: number, cb?: () => void) => unknown; destroy: (error?: Error) => unknown }): void => {
      socket.setTimeout(timeoutMs, () => {
        socket.destroy(new Error(`the mail server at ${target.host}:${String(target.port)} did not accept a connection in time`));
      });
    };
    if (target.scheme === "smtps") {
      const secureSocket = tlsConnect({ host: target.host, port: target.port, servername: target.host }, () => {
        secureSocket.setTimeout(0);
        resolve({ stream: secureSocket, secure: true, upgrade: null, close: () => { secureSocket.destroy(); } });
      });
      armConnectTimeout(secureSocket);
      secureSocket.once("error", reject);
      return;
    }
    const socket = netConnect({ host: target.host, port: target.port }, () => {
      socket.setTimeout(0);
      resolve({
        stream: socket,
        secure: false,
        upgrade: async (): Promise<SmtpTransport> =>
          new Promise<SmtpTransport>((ok, no) => {
            const upgraded = tlsConnect({ socket, servername: target.host }, () => {
              ok({ stream: upgraded, secure: true, upgrade: null, close: () => { upgraded.destroy(); } });
            });
            upgraded.once("error", no);
          }),
        close: () => { socket.destroy(); },
      });
    });
    armConnectTimeout(socket);
    socket.once("error", reject);
  });

/* =========================================================================
 * The conversation
 * ====================================================================== */

interface SmtpReply {
  readonly code: number;
  readonly text: string;
}

/**
 * A line reader over a stream that can be REPLACED mid-conversation, which is
 * what STARTTLS is.
 *
 * THE BUFFER IS ASSERTED EMPTY AT THE UPGRADE and that check is a security
 * control, not tidiness: bytes a server sent after its `220 Ready to start TLS`
 * but before the handshake are plaintext an attacker may have injected, and a
 * reader that kept them would let those bytes be read as if they had arrived
 * inside the tunnel (the STARTTLS command-injection class, CVE-2011-0411 and
 * its many descendants). The conversation aborts instead.
 */
class SmtpChannel {
  #stream: Duplex;
  #buffer = "";
  #lines: string[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #fault: string | null = null;

  constructor(stream: Duplex) {
    this.#stream = stream;
    this.#attach(stream);
  }

  #attach(stream: Duplex): void {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let at = this.#buffer.indexOf("\n");
      while (at >= 0) {
        this.#lines.push(this.#buffer.slice(0, at).replace(/\r$/, ""));
        this.#buffer = this.#buffer.slice(at + 1);
        at = this.#buffer.indexOf("\n");
      }
      this.#wake?.();
    });
    stream.on("end", () => { this.#ended = true; this.#wake?.(); });
    stream.on("close", () => { this.#ended = true; this.#wake?.(); });
    stream.on("error", (error: Error) => { this.#fault = error.message; this.#ended = true; this.#wake?.(); });
  }

  /** Swap in the TLS stream. Throws when plaintext was buffered behind it. */
  replaceStream(stream: Duplex): void {
    if (this.#lines.length > 0 || this.#buffer !== "") {
      throw new Error("the server sent data before the TLS handshake; those bytes are discarded and the session is abandoned");
    }
    this.#stream.removeAllListeners("data");
    this.#stream.removeAllListeners("end");
    this.#stream.removeAllListeners("close");
    this.#stream.removeAllListeners("error");
    this.#stream = stream;
    this.#ended = false;
    this.#attach(stream);
  }

  write(line: string): void {
    this.#stream.write(`${line}\r\n`);
  }

  /** One complete reply, following `250-` continuations. */
  async readReply(deadlineAt: number): Promise<SmtpReply> {
    const collected: string[] = [];
    for (;;) {
      const line = await this.#nextLine(deadlineAt);
      collected.push(line);
      if (!/^\d{3}-/.test(line)) break;
    }
    const last = collected[collected.length - 1] ?? "";
    const code = Number.parseInt(last.slice(0, 3), 10);
    if (!Number.isInteger(code)) throw new Error(`the server answered something that is not an SMTP reply: ${last.slice(0, 80)}`);
    return { code, text: collected.join("\n") };
  }

  async #nextLine(deadlineAt: number): Promise<string> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) return line;
      if (this.#fault !== null) throw new Error(this.#fault);
      if (this.#ended) throw new Error("the server closed the connection before answering");
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new Error("the server did not answer in time");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 1_000));
        timer.unref();
        this.#wake = () => { clearTimeout(timer); this.#wake = null; resolve(); };
      });
    }
  }
}

/** Capability tokens out of an EHLO reply, uppercased. `AUTH PLAIN LOGIN` → both. */
export function ehloCapabilities(reply: string): readonly string[] {
  return reply
    .split("\n")
    .slice(1)
    .map((line) => line.slice(4).trim().toUpperCase())
    .filter((line) => line !== "");
}

/** `AUTH PLAIN LOGIN` advertises both; `AUTH=PLAIN` is the old form some servers still send. */
export function supportsAuth(caps: readonly string[], mechanism: string): boolean {
  return caps.some((cap) => {
    if (!cap.startsWith("AUTH")) return false;
    return cap.slice(4).replace(/^=/, "").trim().split(/\s+/).includes(mechanism);
  });
}

export interface RepairMailRequest {
  readonly subject: string;
  readonly body: string;
}

export interface RepairMailResult {
  readonly ok: boolean;
  readonly code: string;
  /** A sentence for the delivery record. NEVER carries the credential. */
  readonly detail: string;
  /** `smtp://host:port (…)`, or null when nothing was attempted. */
  readonly target: string | null;
}

export interface SendRepairMailDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly connect?: SmtpConnect;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly nonce?: () => string;
}

/**
 * Send one report, and NEVER throw.
 *
 * THE OUTER TRY IS THE PRODUCT. Everything inside may throw — `new URL`, the
 * socket, a reply that is not a number, a bug written here next year — and the
 * caller is a repair cycle that must not die because a mail server was
 * unreachable at 3am. `repair-mail.test.ts` injects a `connect` that throws
 * synchronously and a `connect` that never settles, and asserts both resolve
 * with `ok:false` and a named code.
 *
 * IT IS ALSO NOT THE ONLY GUARD, DELIBERATELY. `deliverRepairReport`
 * (`repair-report.ts`) wraps this call in its own catch, so removing either one
 * leaves a live test: this one proves the sender converts a fault into a
 * result, that one proves the report survives a sender that broke its own
 * contract. Two mutations, two different reds.
 */
export async function sendRepairMail(request: RepairMailRequest, deps: SendRepairMailDeps): Promise<RepairMailResult> {
  const config = resolveRepairMailConfig(deps.env);
  const secrets: string[] = [];
  try {
    if (!config.configured || config.target === null) {
      return { ok: false, code: SMTP_CODES.notConfigured, detail: config.why, target: null };
    }
    const target = config.target;
    if (target.password !== null) secrets.push(target.password);
    if (target.username !== null) secrets.push(target.username);
    const where = describeSmtpTarget(target);
    for (const [label, address] of [["recipient", config.to], ["sender", config.from]] as const) {
      if (!validAddress(address)) {
        return {
          ok: false,
          code: SMTP_CODES.badAddress,
          detail: `the ${label} address is not a plain address this program will put in a header (${JSON.stringify(address.slice(0, 80))})`,
          target: where,
        };
      }
    }
    const timeoutMs = deps.timeoutMs ?? SMTP_TIMEOUT_MS;
    const now = deps.now ?? (() => new Date());
    const nonce = deps.nonce ?? (() => Math.random().toString(16).slice(2, 10));
    const at = now();
    const message = renderMailMessage({
      from: config.from,
      to: config.to,
      subject: request.subject,
      body: request.body,
      date: at,
      messageId: messageIdFor(at, nonce(), config.from),
    });
    const connect = deps.connect ?? netSmtpConnect;
    const outcome = await runSmtpConversation({ target, from: config.from, to: config.to, message, connect, timeoutMs });
    return { ...outcome, detail: scrubUrlCredentials(outcome.detail, secrets), target: where };
  } catch (error) {
    /*
     * A FAULT IN THIS FILE IS STILL A MAIL OUTCOME. Reached only if something
     * above throws outside `runSmtpConversation`'s own handling — which is the
     * definition of a bug here, so it is named as one rather than reported as a
     * server problem.
     */
    return {
      ok: false,
      code: SMTP_CODES.unexpected,
      detail: scrubUrlCredentials(
        `the mail sender itself failed and the email was abandoned: ${error instanceof Error ? error.message : String(error)}`,
        secrets,
      ),
      target: config.target === null ? null : describeSmtpTarget(config.target),
    };
  }
}

interface ConversationInput {
  readonly target: SmtpTarget;
  readonly from: string;
  readonly to: string;
  readonly message: string;
  readonly connect: SmtpConnect;
  readonly timeoutMs: number;
}

/**
 * Greeting → EHLO → (STARTTLS) → (AUTH) → MAIL → RCPT → DATA → QUIT.
 *
 * EVERY STEP NAMES ITSELF IN THE FAILURE. "the server refused the recipient
 * (550 …)" and "the server refused the message body" are different facts and
 * the owner's delivery record has to be able to tell them apart — a single
 * `SMTP_FAILED` would make a permanently wrong address look like a transient
 * outage for ever.
 */
async function runSmtpConversation(input: ConversationInput): Promise<{ ok: boolean; code: string; detail: string }> {
  const deadlineAt = Date.now() + input.timeoutMs;
  let transport: SmtpTransport;
  try {
    transport = await withDeadline(input.connect(input.target, input.timeoutMs), deadlineAt);
  } catch (error) {
    return {
      ok: false,
      code: SMTP_CODES.connectFailed,
      detail: `could not reach the mail server: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let channel: SmtpChannel;
  try {
    channel = new SmtpChannel(transport.stream);
  } catch (error) {
    transport.close();
    return { ok: false, code: SMTP_CODES.protocol, detail: `the connection could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  let secure = transport.secure;
  try {
    const greeting = await channel.readReply(deadlineAt);
    if (greeting.code !== 220) return refused("the mail server did not greet this connection", greeting.text);

    channel.write(`EHLO ${clientName(input.from)}`);
    let hello = await channel.readReply(deadlineAt);
    if (hello.code !== 250) return refused("the mail server refused the introduction (EHLO)", hello.text);

    let caps = ehloCapabilities(hello.text);
    if (!secure && caps.includes("STARTTLS") && transport.upgrade !== null) {
      channel.write("STARTTLS");
      const ready = await channel.readReply(deadlineAt);
      if (ready.code !== 220) return refused("the mail server offered encryption and then refused to start it", ready.text);
      const upgraded = await withDeadline(transport.upgrade(), deadlineAt);
      channel.replaceStream(upgraded.stream);
      transport = upgraded;
      secure = upgraded.secure;
      channel.write(`EHLO ${clientName(input.from)}`);
      hello = await channel.readReply(deadlineAt);
      if (hello.code !== 250) return refused("the mail server refused the introduction after encryption started", hello.text);
      caps = ehloCapabilities(hello.text);
    }

    if (input.target.username !== null && input.target.password !== null) {
      /*
       * NO CREDENTIAL OVER A CLEAR CHANNEL, EVER, AND NOT AS A PREFERENCE.
       * AUTH PLAIN is the password in base64 — an encoding, not encryption — so
       * sending it on an unencrypted socket hands it to anything on the path.
       * The email is a convenience over a report that is already on disk, so
       * the correct trade is obvious: no email, named reason, nothing leaked.
       */
      if (!secure) {
        return {
          ok: false,
          code: SMTP_CODES.credentialOnPlaintext,
          detail:
            "the mail server offers no encryption and the configured account needs a password, so no email was sent: a password on an " +
            "unencrypted connection is readable by anything between here and the server. Use an smtps:// URL, or a server that offers STARTTLS.",
        };
      }
      const authed = await authenticate(channel, caps, input.target.username, input.target.password, deadlineAt);
      if (authed !== null) return authed;
    }

    channel.write(`MAIL FROM:<${input.from}>`);
    const sender = await channel.readReply(deadlineAt);
    if (sender.code !== 250) return refused("the mail server refused the sender address", sender.text);

    channel.write(`RCPT TO:<${input.to}>`);
    const rcpt = await channel.readReply(deadlineAt);
    if (rcpt.code !== 250 && rcpt.code !== 251) return refused("the mail server refused the recipient address", rcpt.text);

    channel.write("DATA");
    const dataReady = await channel.readReply(deadlineAt);
    if (dataReady.code !== 354) return refused("the mail server refused to accept a message body", dataReady.text);

    channel.write(`${input.message}\r\n.`);
    const accepted = await channel.readReply(deadlineAt);
    if (accepted.code !== 250) return refused("the mail server rejected the message", accepted.text);

    /*
     * QUIT IS WAITED FOR, AND THAT IS NOT POLITENESS — MEASURED 2026-08-16.
     * The `finally` below calls `transport.close()`, which is `socket.destroy()`,
     * and destroying immediately after `write("QUIT")` discarded the bytes: the
     * fake server in `repair-mail.test.ts` recorded EHLO/MAIL/RCPT/DATA and NO
     * QUIT, so every send looked to the server like a client that dropped the
     * connection mid-session. Reading the `221` flushes the write and confirms
     * the server is done with us. A server that just hangs up instead is
     * behaving normally at this point, so the failure is swallowed — the message
     * is already accepted and re-reporting the send as failed here would be a
     * lie about a delivered email.
     */
    channel.write("QUIT");
    try {
      await channel.readReply(deadlineAt);
    } catch {
      /* the server hung up on the goodbye; the message was already accepted */
    }
    return { ok: true, code: SMTP_CODES.sent, detail: `the mail server accepted the message (${firstLine(accepted.text)})` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: /did not answer in time/.test(detail) ? SMTP_CODES.timedOut : SMTP_CODES.protocol,
      detail: `the conversation with the mail server failed: ${detail}`,
    };
  } finally {
    /* Closed on every path. A leaked socket keeps the event loop alive. */
    transport.close();
  }
}

function refused(what: string, reply: string): { ok: false; code: string; detail: string } {
  return { ok: false, code: SMTP_CODES.rejected, detail: `${what}: ${firstLine(reply)}` };
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").slice(0, 200);
}

/**
 * AUTH PLAIN, falling back to AUTH LOGIN.
 *
 * PLAIN FIRST because it is one round trip and one encoding; LOGIN exists
 * because some servers advertise nothing else. Returns null on success and a
 * result on failure — the failure text is the SERVER's line, never the
 * credential, and `sendRepairMail` scrubs it again on the way out.
 */
async function authenticate(
  channel: SmtpChannel,
  caps: readonly string[],
  username: string,
  password: string,
  deadlineAt: number,
): Promise<{ ok: false; code: string; detail: string } | null> {
  const b64 = (value: string): string => Buffer.from(value, "utf8").toString("base64");
  if (supportsAuth(caps, "PLAIN") || !supportsAuth(caps, "LOGIN")) {
    channel.write(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`);
    const reply = await channel.readReply(deadlineAt);
    if (reply.code === 235) return null;
    return { ok: false, code: SMTP_CODES.authFailed, detail: `the mail server rejected the sign-in: ${firstLine(reply.text)}` };
  }
  channel.write("AUTH LOGIN");
  const wantsUser = await channel.readReply(deadlineAt);
  if (wantsUser.code !== 334) return { ok: false, code: SMTP_CODES.authFailed, detail: `the mail server would not start a sign-in: ${firstLine(wantsUser.text)}` };
  channel.write(b64(username));
  const wantsPassword = await channel.readReply(deadlineAt);
  if (wantsPassword.code !== 334) return { ok: false, code: SMTP_CODES.authFailed, detail: `the mail server rejected the account name: ${firstLine(wantsPassword.text)}` };
  channel.write(b64(password));
  const done = await channel.readReply(deadlineAt);
  if (done.code === 235) return null;
  return { ok: false, code: SMTP_CODES.authFailed, detail: `the mail server rejected the sign-in: ${firstLine(done.text)}` };
}

/**
 * The name this client gives in EHLO.
 *
 * DERIVED FROM THE SENDER'S DOMAIN, NOT FROM `os.hostname()`. A laptop's
 * hostname is often a person's name ("kamils-macbook-pro.local"), and §3.6 item
 * 1 of the design makes anything naming a person leaving this machine an
 * owner-only decision. The sender's domain is already in the envelope.
 */
function clientName(from: string): string {
  const domain = (from.split("@")[1] ?? "").trim();
  return ADDRESS.test(from) && domain !== "" ? domain : "localhost";
}

/** Reject when the clock runs out, so a transport that never settles cannot hang a tick. */
async function withDeadline<T>(work: Promise<T>, deadlineAt: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error("the server did not answer in time")); }, Math.max(1, deadlineAt - Date.now()));
    timer.unref();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
