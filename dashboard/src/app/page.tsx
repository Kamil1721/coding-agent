"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { AttachmentChips } from "@/components/attachment-chips";
import { AuthPanel } from "@/components/auth-panel";
import { ModelPicker } from "@/components/model-picker";
import { FalseFinishBadge } from "@/components/outcome";
import { Badge, Button, Dot, Panel, cx } from "@/components/ui";
import { createRun, errorMessage } from "@/lib/api";
import {
  acceptAttribute,
  briefHasContent,
  dataUrlsOfKind,
  planAttachmentIntake,
  readAttachments,
  releaseAttachments,
  type HeldAttachment,
} from "@/lib/attachments";
import { formatRelative } from "@/lib/format";
import { useModels, useRuns } from "@/lib/hooks";
import { statusMeta } from "@/lib/presentation";
import { useNow } from "@/lib/use-run-stream";

/**
 * The last few runs, so that submitting a ticket and then getting back to a
 * run in progress are the same screen. Deliberately terse — the Runs tab is
 * the real history.
 */
function RecentRuns(): ReactNode {
  const { data: runs } = useRuns();
  const nowMs = useNow(5_000);
  const recent = (runs ?? []).slice(0, 5);
  if (recent.length === 0) return null;

  return (
    <Panel
      title="Recent"
      actions={
        <Link
          href="/runs"
          className="text-[11px] text-ink-faint underline-offset-2 hover:text-ink"
        >
          all runs
        </Link>
      }
      bodyClassName="p-0"
    >
      <ul className="divide-y divide-line">
        {recent.map((run) => {
          const meta = statusMeta(run.status);
          return (
            <li key={run.runId}>
              <Link
                href={`/runs/${encodeURIComponent(run.runId)}`}
                className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-surface-raised/60"
              >
                <Badge tone={meta.tone} title={meta.meaning}>
                  <Dot tone={meta.tone} pulse={meta.live} />
                  {meta.label}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-dim">
                  {run.ticketTitle === "" ? run.runId : run.ticketTitle}
                </span>
                <FalseFinishBadge falseFinish={run.falseFinish} />
                <span className="numeric shrink-0 text-[11px] text-ink-faint">
                  {formatRelative(run.startedAt, nowMs)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/**
 * The two answers to "who picks the mockup", in the order they are offered.
 *
 * THE VALUES ARE THE WIRE'S, not a local vocabulary. `CreateRunRequest.designLock`
 * is `"auto" | "ask" | null`, `server/src/http.ts:846` refuses anything else with a
 * 400, and `designLockPolicy` (`server/src/design-lock.ts:48-52`) compares against
 * those two literals BEFORE it falls back to the server's own interactivity guess —
 * which is the line that makes "auto" here a real opt-out rather than a label the
 * backend quietly overrides back to a park for every dashboard submission.
 *
 * `"ask"` IS FIRST AND IS THE DEFAULT because it is what this form already sent
 * before the row existed (`api.ts:205`); the row discloses that behaviour and adds
 * a way out of it, and was deliberately not the occasion to change it.
 *
 * THE LABELS LOST THE WORD "mockup" ON 2026-08-04, and only the labels: the values
 * are the wire's and are untouched, so `model-picker.browser.spec.ts:196`'s whole
 * body `toEqual` still sees `designLock: "ask"`. The row these render in is now
 * headed "Mockups", so the first choice was saying the noun twice within one line
 * of itself. No spec resolves either control by its label text (checked: the only
 * matches for "ui-designer pick" under `tests/` are in `design-park-clock` and the
 * run page's own deck, neither of which loads this screen).
 */
const DESIGN_CHOICES: readonly {
  readonly value: "ask" | "auto";
  readonly label: string;
}[] = [
  { value: "ask", label: "Ask me which to build" },
  { value: "auto", label: "Let ui-designer pick" },
];

/* -------------------------------------------------------------------------
 * REFERENCES AND DOCUMENTS — the ticket's second and third inputs
 *
 * THE HAND COPY THIS BLOCK USED TO ANNOUNCE IS GONE. `MAX_REFERENCE_IMAGES`,
 * `MAX_REFERENCE_IMAGE_BYTES`, `Attachment` and `readAsDataUrl` were declared
 * here and again in `components/canvas/orchestrator-chat.tsx` with nothing
 * keeping them in step; both files now import `@/lib/attachments`. The seam did
 * not disappear, it MOVED and got a guard: that module transcribes its caps and
 * media types from two server declarations it cannot import (they pull in
 * `node:fs`), and `tests/document-intake.browser.spec.ts` reads those server
 * files as text and fails when the transcription drifts.
 *
 * ONE INTAKE, TWO ARRAYS ON THE WIRE. Images go out as `references` and
 * documents as `documents`, with independent caps (6/8 MB and 4/12 MB) and
 * independent server-side decoders. They are ONE list in this component's state
 * because the owner drops a folder, not a category — the split happens at
 * submit, via `dataUrlsOfKind`.
 *
 * WHO READS AN ATTACHMENT IS NOT THIS FILE'S CLAIM TO MAKE, and the disclosure
 * below is worded so it does not make one. What is certain, and is what the
 * sentence says, is IDENTITY: the server folds every image and document digest
 * into the ticket id (`ticketWithReferences`), so the same words with a
 * different file address a different frozen suite. Which SEAT is then shown the
 * bytes is decided by the server's build and spec wiring and reported on the
 * run's own event stream — `api-types.ts#CreateRunRequest.documents` states that
 * split, and "attached" must not be rendered as "the run has read your scope".
 * ---------------------------------------------------------------------- */

/**
 * Does this brief link to a page the server will go and capture?
 *
 * PRESENCE ONLY, AND THAT IS THE WHOLE OF THE RULE THIS FILE MAY RESTATE. The
 * server scans for the FIRST http(s) URL (`site-capture.ts:211`) and then
 * refuses a whole list of hosts — localhost, 127/10/192.168/172.16-31/169.254,
 * private IPv6, and any hostname with no dot (`refuseHost`, `site-capture.ts:185`).
 * Copying that list here was considered and rejected: it is ~15 lines with no
 * mechanism keeping the copy honest, and a stale copy would make this form
 * PROMISE a capture the server declines.
 *
 * SO THE COST OF BEING WRONG IS ONE SENTENCE, NEVER A BEHAVIOUR. This client
 * never sends `captureUrl` — absent means "scan the ticket text", which is the
 * behaviour wanted — so the server's scan is the only thing that decides, and
 * this predicate only decides whether the disclosure is shown. It over-fires on
 * `http://localhost:3000`, which is why the sentence it gates describes the
 * policy and says what happens when the page cannot be reached, rather than
 * claiming a capture happened.
 */
function linksToAPage(text: string): boolean {
  return /https?:\/\//i.test(text);
}

function pickDefaultModel(
  models: readonly { id: string; tier: string; available: boolean }[],
): string | null {
  const included = models.find(
    (model) => model.tier === "included" && model.available,
  );
  if (included !== undefined) return included.id;
  const any = models.find((model) => model.available);
  return any?.id ?? null;
}

export default function NewTicketPage(): ReactNode {
  const router = useRouter();
  const { data: models, isLoading, error } = useModels();

  const [ticketText, setTicketText] = useState("");
  const [motionUrl, setMotionUrl] = useState("");
  const [chosenModelId, setChosenModelId] = useState<string | null>(null);
  const [deploy, setDeploy] = useState(false);
  const [designLock, setDesignLock] = useState<"ask" | "auto">("ask");
  const [attachments, setAttachments] = useState<readonly HeldAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  /**
   * THE OBJECT URLS DIE WITH THIS FORM, and this is the only path that can free
   * them: a successful submit navigates to the run page, so the component unmounts
   * with a full list of `blob:` URLs that no removal handler will ever see.
   *
   * TWO EFFECTS RATHER THAN A REF WRITTEN DURING RENDER. The sweep is keyed on `[]`
   * so it runs at unmount and NOT on every change — a cleanup keyed on
   * `[attachments]` would revoke the previous list on every add and blank the
   * thumbnails already on screen. It therefore cannot read `attachments` from its
   * own closure, which is what the mirror is for. Both are safe under React's
   * development double-mount: the first cleanup fires with the mirror still empty.
   */
  const held = useRef<readonly HeldAttachment[]>([]);
  useEffect(() => {
    held.current = attachments;
  }, [attachments]);
  useEffect(() => () => releaseAttachments(held.current), []);

  // The default is DERIVED, not written into state by an effect: an effect
  // here would render once with nothing selected and then again with a
  // selection, and would fight any explicit choice made before the list loads.
  const modelId: string | null =
    chosenModelId ?? (models === undefined ? null : pickDefaultModel(models));
  const setModelId = setChosenModelId;

  const selected = useMemo(
    () => models?.find((model) => model.id === modelId) ?? null,
    [models, modelId],
  );

  /**
   * Take files from any of the three intakes — paste, drop, file picker.
   *
   * THE DECISION IS `planAttachmentIntake`'S, NOT THIS COMPONENT'S. Everything
   * that can silently lose a file — the type filter, the two size caps, the two
   * COUNT caps — lives in `@/lib/attachments` so that it can be exercised without
   * a browser, which is where the specs for it are. What is left here is state.
   *
   * THE PLAN IS COMPUTED FROM THE CLOSURE, THE STATE IS SET FROM AN UPDATER, and
   * the split is intentional and imperfect. `attachments` is read at event time,
   * so two drops landing while a `FileReader` is still in flight compute their
   * room against the same list and can attach one over the cap — the MESSAGE and
   * the LIST would both be wrong for that instant. The server holds the real cap
   * and answers `too_many_documents`, so the failure is a refused submit with the
   * server's own sentence rather than a run graded against files nobody saw. A
   * functional updater cannot be used to compute the plan because the plan must
   * also produce a refusal string, and setState updaters must stay pure.
   */
  const addFiles = useCallback(
    (files: readonly File[]): void => {
      setAttachError(null);
      if (files.length === 0) return;
      const plan = planAttachmentIntake(files, attachments);
      setAttachError(plan.refusal);
      if (plan.take.length === 0) return;
      void readAttachments(plan.take)
        .then((read) => {
          setAttachments((previous) => [...previous, ...read]);
        })
        .catch((cause: unknown) => {
          setAttachError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [attachments],
  );

  /**
   * Drop one chip, and hand its object URL back before the render that forgets it.
   *
   * THE REVOKE IS OUTSIDE THE UPDATER ON PURPOSE — `releaseAttachments`' docblock
   * says why: React re-invokes updaters, and an impure one is how a thumbnail goes
   * blank for reasons nobody can reproduce. `attachments` is this render's list, so
   * the doomed entry is read from the closure and the updater stays a filter.
   */
  const removeAttachment = useCallback(
    (index: number): void => {
      const doomed = attachments[index];
      if (doomed !== undefined) releaseAttachments([doomed]);
      setAttachments((previous) => previous.filter((_unused, i) => i !== index));
    },
    [attachments],
  );

  // `briefHasContent`, NOT `.trim()`. Eight U+200B characters render as an empty
  // textarea and `trim()` reports eight, so this guard — the only thing standing
  // in front of a billed multi-hour build — went green over a field the owner
  // could see was blank. Demonstrated against this page on 2026-08-03; the
  // server's own copy of the predicate (`server/src/ticket.ts`) is the
  // authority, and this one only decides whether the button looks pressable.
  const hasBrief = briefHasContent(ticketText);
  const trimmed = ticketText.trim();
  const blockedReason: string | null =
    !hasBrief
      ? "Write the brief first."
      : modelId === null
        ? "Pick a model."
        : selected !== null && !selected.available
          ? (selected.reason ?? "That model is unavailable.")
          : null;

  /**
   * ONE SUBMIT PATH, REACHED TWO WAYS.
   *
   * Extracted from the form's `onSubmit` so the Cmd/Ctrl-Enter accelerator below
   * INHERITS the guard rather than restating it: the empty-brief and
   * unavailable-model refusals, and the double-submit lock, are checked here and
   * nowhere else. An accelerator wired straight to `createRun` would have been a
   * second door past `blockedReason`, and the failure would only show up as a run
   * queued against a model that cannot run.
   *
   * `form.requestSubmit()` from the keydown would also work and is not used: it
   * adds a synthetic event round trip for no behaviour this needs.
   */
  async function submit(): Promise<void> {
    if (blockedReason !== null || modelId === null || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      // `designLock` IS NOW ALWAYS STATED, which makes `api.ts:205`'s default
      // unreachable from the only caller this module has (`createRun` spreads the
      // body AFTER its default, so the form wins). The default is left where it is
      // rather than deleted from here: that file is not this change's to edit, and
      // its comment explains why the field must be stated rather than inferred
      // from a `Referer` the Next rewrite may not forward.
      //
      // `references` AND `documents` ARE OMITTED, NOT SENT EMPTY, when nothing
      // of that kind is attached, and that is load-bearing twice over.
      // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
      // optional field, so the spread is the only legal shape; and
      // `model-picker.browser.spec.ts:196` asserts the WHOLE request body with
      // `toEqual`, so an unconditional `references: []` would fail five specs
      // that have nothing to do with references — and a `documents: []` beside
      // it would fail the same five again. The server reads absent and `[]`
      // identically for both (`readReferenceImages` / `readReferenceDocuments`,
      // `http.ts:1195`), so the wire meaning is unchanged either way; the
      // absence is for the specs and the contract, not for the server.
      //
      // TWO SPREADS, NOT ONE ARRAY. `documents` has its own decoder, its own
      // caps and its own directory on disk (`runs/<id>/documents/` rather than
      // `references/`); sending a PDF in `references` would fail
      // `decodeReferenceDataUrl` and refuse the whole submission. `dataUrlsOfKind`
      // is the only place the split is made.
      //
      // NO `captureUrl` AT ALL. Absent means "scan the ticket text for the first
      // http(s) URL", which is exactly the behaviour this form discloses; `null`
      // would be the opt-out and there is no control for it (see the report).
      //
      // `motionUrl` FOLLOWS THE SAME SPREAD FOR THE SAME TWO REASONS, and it is a
      // SEPARATE field from `captureUrl` on purpose: the brief's own first URL
      // still means "copy this site" and still feeds the outline capture, while
      // this one means only "move like this". Merging them would make liking a
      // page's movement inherit its headings and its palette.
      //
      // IT CANNOT REFUSE A SUBMISSION EITHER WAY. `POST /api/runs` reads the body
      // by named key and rejects nothing unrecognised, so this key is carried
      // whether or not the reader for it is in the tree. The enumeration of which
      // keys that route validates is deliberately NOT copied here — this file has
      // no way to notice when that list changes, and the surrounding comments
      // record what a hand copy of a server fact is worth. What the run actually
      // did with the link is on the run's own event stream, not here.
      //
      // THE ORDER OF `attachments` IS THE ORDER ON DISK. `http.ts:1105` names
      // the files `reference-1`, `reference-2`… by index, so the chip order the
      // owner sees is the sequence the builder reads them in.
      const references = dataUrlsOfKind(attachments, "image");
      const documents = dataUrlsOfKind(attachments, "document");
      const { runId } = await createRun({
        ticketText: trimmed,
        modelId,
        deploy,
        designLock,
        ...(references.length === 0 ? {} : { references }),
        ...(documents.length === 0 ? {} : { documents }),
        ...(motionUrl.trim() === "" ? {} : { motionUrl: motionUrl.trim() }),
      });
      router.push(`/runs/${encodeURIComponent(runId)}`);
    } catch (cause) {
      setSubmitError(errorMessage(cause));
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]"
    >
      <div className="flex min-w-0 flex-col gap-4">
        <Panel
          title="Ticket"
          // KEPT, TRIMMED. "Plain prose" was obvious; how you will know it works is
          // not — that sentence is what the acceptance suite is authored from, so it
          // changes the output rather than describing the input.
          subtitle="Describe what you want built, and how you will know it works."
          bodyClassName="p-0"
        >
          <textarea
            value={ticketText}
            onChange={(event) => setTicketText(event.target.value)}
            /*
             * CMD/CTRL-ENTER SUBMITS. PLAIN ENTER DOES NOT, AND THAT IS THE
             * DIFFERENCE FROM THE CHAT BOX.
             *
             * The chat's 3-row composer sends on plain Enter, which is the right
             * convention for a message. This surface is 420px tall and its
             * placeholder is three paragraphs on purpose — a brief is written in
             * paragraphs, so plain Enter here would queue half-written tickets
             * against a frozen acceptance suite that cannot be edited afterwards.
             *
             * `preventDefault` ONLY ON THE MODIFIER HIT. Without the guard the
             * newline would be swallowed on every Enter; with it, the accelerator
             * is the only key this handler consumes.
             *
             * The accelerator is not announced on screen — it is on the button's
             * `title`. Named in the report as the thing a hover cannot teach a
             * touch or keyboard user.
             */
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
            onPaste={(event) => {
              // A pasted screenshot is the fastest way to hand over a reference,
              // and the paste is only intercepted when it actually carries files
              // — pasting TEXT into the brief must stay untouched.
              const files = [...event.clipboardData.files];
              if (files.length > 0) {
                event.preventDefault();
                addFiles(files);
              }
            }}
            onDrop={(event) => {
              // GUARDED THE SAME WAY THE PASTE IS, AND THE CHAT'S VERSION IS NOT.
              // `orchestrator-chat.tsx:281` calls `preventDefault` unconditionally,
              // which is harmless on a 3-row message box and is not harmless here:
              // this is the app's primary prose surface, and cancelling the default
              // on a TEXT drop means dragging a paragraph in from an editor
              // silently does nothing.
              const files = [...event.dataTransfer.files];
              if (files.length === 0) return;
              event.preventDefault();
              addFiles(files);
            }}
            onDragOver={(event) => {
              // Unconditional, and it has to be: cancelling dragover is what makes
              // an element a drop target at all. A textarea still takes text drops
              // regardless — that is `onDrop`'s decision above, not this one's.
              event.preventDefault();
            }}
            spellCheck
            placeholder={
              "A one-page site for a photographer.\n\nHero image, a grid of 12 photos that opens a lightbox, an about section, and a contact form that validates the email field.\n\nMust work at 1280px and on a phone."
            }
            className="h-[420px] w-full resize-y bg-transparent px-3 py-2.5 text-[13.5px] leading-relaxed text-ink placeholder:text-ink-faint/70 focus:outline-none"
          />

          {/*
            * REFERENCES — the visual half of a brief, which until now had no way in.
            *
            * THE ONLY IMAGE INTAKE THIS APP HAD WAS THE CHAT, and the chat mounts on
            * a graph node that does not exist for the first ~80 minutes of a run
            * (UX-GAPS item 5), by which time the suite is frozen and the design
            * lane has already invented its five references. So a picture of what
            * the owner wanted could not reach either of the two seats that can
            * read one.
            *
            * WHO ACTUALLY SEES AN IMAGE, since it is not obvious and it is the
            * reason the disclosure below is worded the way it is: the BUILDER and
            * the DESIGN lane get absolute paths in their prompts and are told to
            * read them. The SPEC seat does not — `ticket-refs.ts` is where that
            * split is made and says why: a criterion authored about an unseen
            * image grades green or red for reasons nothing can trace.
            *
            * THAT PARAGRAPH USED TO END "it is text-only BY CONSTRUCTION", citing
            * `tools: []` and `settingSources: []`. THAT REASONING IS WRONG AND THE
            * SERVER NOW CONTRADICTS IT: a document is CONTENT, not a tool call, so
            * `tools: []` does not stop the spec seat being handed one, and
            * `subscription-caller.ts` carries PDF document blocks into that seat's
            * first user message. Its own header is careful about how far that
            * goes — "wired and type-checked, not observed", never yet run end to
            * end against a real ticket with a real PDF — so this form claims
            * nothing about it. A DOCUMENT IS NOT AN IMAGE HERE: the seat split for
            * documents is the server's to make and to report, and it is not the
            * one stated above.
            *
            * THE SENTENCE IS A HAND COPY, LIKE THE GATE NOTE BELOW IT. The
            * canonical wording is the server's own `captureNotes`
            * (`server/src/http.ts:1250-1252`), which says the same thing on the
            * run's event stream after the fact. NOTHING KEEPS THEM IN SYNC — the
            * parity test covers SSE event NAMES, not prose — and this one is
            * shortened to a single sentence at the owner's request, so the two are
            * deliberately not identical strings.
            */}
          <div className="flex flex-col gap-1.5 border-t border-line px-3 py-2">
            {/*
              * THE CHIPS ARE A COMPONENT NOW, AND THE MARKUP THAT WAS HERE IS GONE
              * WITH ITS REASONING CORRECTED. It said the difference between a
              * document chip and an image chip was "the filename plus a tag, not an
              * icon", on the argument that a generic paperclip names no file. The
              * argument survives; the conclusion did not. An image chip renders the
              * IMAGE — from the `File` the paste already put in memory — which is
              * the strongest possible answer to "is that the right one", and a
              * document gets a drawn glyph beside a size and a word a person uses
              * ("Word", not `application/vnd.openxml…`). What was measured, and
              * what the chip existed to prevent, is in `components/attachment-chips.tsx`.
              */}
            <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

            {attachError !== null && (
              <p role="alert" className="text-[11px] text-fail">
                {attachError}
              </p>
            )}

            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="text-[11.5px] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
              >
                Attach images or documents
              </button>
              {/*
                * THE "or paste and drop them into the brief above" HINT IS CUT
                * (2026-08-04, the redundancy pass). It taught an affordance that
                * costs nothing to discover and refuses nothing when it is not
                * discovered: the picker below reaches the same intake, and the
                * paste and drop handlers on the textarea are unchanged. What it
                * cost was a line of permanent tutorial prose on the screen the
                * owner reads most, which is the complaint this pass answers.
                *
                * ONE INPUT FOR BOTH KINDS, NOT TWO, and the reason is a test
                * rather than tidiness: `ticket-references.browser.spec.ts:131`
                * attaches through `input[type="file"]` `.first()`, so a second
                * input added above this one would silently retarget an existing
                * spec at a control it was not written for. One input also
                * matches how the files arrive — a drop is a drop, and the
                * classification happens in `planAttachmentIntake` either way.
                */}
              <input
                ref={fileInput}
                type="file"
                accept={acceptAttribute()}
                multiple
                hidden
                onChange={(event) => {
                  addFiles([...(event.target.files ?? [])]);
                  // Cleared so that picking the SAME file twice still fires
                  // `change` the second time.
                  event.target.value = "";
                }}
              />
            </div>

            {/*
              * THE DISCLOSURE, WIDENED RATHER THAN DOUBLED. A document is part of
              * the ticket's identity on exactly the same terms as an image —
              * `ticketWithReferences` folds both digests into the id — so a
              * second near-identical sentence beside this one would cost the
              * owner (who has been cutting text off this form all week) a line to
              * learn nothing new. "File" is the word that covers both.
              *
              * WHAT IT DELIBERATELY DOES NOT SAY: that a seat READS the
              * attachment. That is decided server-side per seat and reported on
              * the run's own event stream, and no sentence on this form claims it
              * for images either.
              *
              * IT IS NOW CONDITIONAL ON THERE BEING A FILE, AND SHORTER (2026-08-04,
              * the redundancy pass). The RULE is load-bearing and was not cut: an
              * attached file changes the ticket id, so it changes which frozen
              * suite the build is graded against, and a person who does not know
              * that will attach a screenshot to a ticket they think they already
              * submitted. But it is a fact about ATTACHMENTS, and on the empty
              * form it was a paragraph about a thing that had not happened. It now
              * appears at the moment it starts applying, which is the first chip.
              * The wording lost "frozen acceptance suite" for "its own tests",
              * which is the vocabulary the rest of this pass moved to.
              */}
            {attachments.length > 0 && (
              <p className="text-[11px] leading-snug text-ink-faint">
                A different file makes this a different ticket, with its own tests.
              </p>
            )}

            {/*
              * THE CAPTURE SENTENCE, SHOWN ONLY WHEN THE BRIEF LINKS SOMEWHERE.
              *
              * It states the POLICY and never a result: `linksToAPage` is a
              * presence test that cannot know whether the server will refuse the
              * host or the page will time out, and both of those end with a `warn`
              * on the run's stream rather than a refused submission. The clause
              * about being unreachable is what keeps the sentence true on those
              * paths.
              *
              * IT USED TO PROMISE "NEVER A COMPARISON AGAINST THE LIVE PAGE", AND
              * THAT PROMISE IS THE ONE THING IT COULD NOT KEEP. The clause was
              * written to stop "capture the site" being read as fidelity grading,
              * and its reasoning — no visual diff, a sealed scorer with no network
              * — is still true and is still the substance. What broke it is the
              * motion reference above: a page is now read for numbers precisely so
              * a build can be held to them, and a blanket "never compared" would be
              * the form telling the owner the opposite of what he just asked for.
              *
              * SO THE SENTENCE STATES THE LIMIT INSTEAD OF THE PROMISE. "The live
              * page is never opened again" is a fact about the seal that holds
              * whatever gets compared later; it does not claim a comparison exists,
              * which is the other lie available here — nothing in this tree grades
              * a build against a captured reading, and a form that said so would be
              * describing work that has not shipped.
              *
              * THE UNREACHABLE CLAUSE STAYS, and it is not decoration:
              * `linksToAPage` is a presence test that cannot know whether the
              * server will refuse the host or the page will time out, and both of
              * those end with a `warn` on the run's stream rather than a refused
              * submission. Without the clause the sentence is false on exactly
              * those paths.
              *
              * COMPRESSED 2026-08-04 FROM FOUR LINES TO THREE SENTENCES, and one
              * thing was DELIBERATELY NOT COMPRESSED: the design spec for this
              * pass (`docs/superpowers/specs/2026-08-04-canvas-redesign.md`,
              * section 6.2 item 4) shortened this to two sentences by dropping the
              * unreachable clause while keeping the opening assertion that the
              * link IS captured. That is the exact combination the paragraph above
              * says goes false when `refuseHost` declines the host or the fetch
              * times out, so the clause was kept and the spec is reported as
              * corrected. What was cut instead is the parenthetical inventory of
              * WHAT the capture produces ("an outline into the ticket text and
              * screenshots for the builder"): it names an internal artefact split
              * the owner cannot act on while writing the brief, and the sentence
              * is true without it.
              */}
            {linksToAPage(ticketText) && (
              <p className="text-[11px] leading-snug text-ink-faint">
                The first link in this brief is captured before the tests are written.
                The live page is never opened again, so anything your build is measured
                against is what was taken then. If the page cannot be reached the run
                says so and the ticket is your words alone.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              {/*
               * THE CRITERIA SENTENCE THAT SAT HERE IS DELETED (2026-08-04, the
               * redundancy pass). It read "The acceptance criteria are authored
               * from this text before any code is written. Ambiguity here becomes
               * an untestable criterion later." Both halves are already on the
               * screen: the panel subtitle four inches above says "Describe what
               * you want built, and how you will know it works", which is the same
               * instruction in the imperative, and the note below states the one
               * consequence of ambiguity a person can actually act on. Two
               * paragraphs restating each other is the specific complaint this
               * pass answers, and this is the pair that was restating.
               */}
              {/*
               * THE GATE'S ONE LIMIT, SAID BEFORE THE TICKET IS WRITTEN rather than
               * discovered after the run. The sealed scorer runs `--network=none`
               * and `gateEnv` (`server/src/paths.ts:183-195`) builds its environment
               * from a fixed allowlist — two paths, two result directories and two
               * optional scorer settings, no credential among them, by construction
               * rather than by policy — so a story about payments, a hosted database
               * or third-party login is graded against whatever the builder stubbed.
               *
               * NOT "IT WILL FAIL". A stub that satisfies the criterion passes, and a
               * false pass is the worse outcome and the one worth naming — the run
               * reports green for something that was never verified. Saying "fail"
               * would also be a claim this file cannot support: nothing here knows
               * what the builder wrote.
               *
               * HAND-COPIED SUBSTANCE, NOT AN IMPORT, and that is a real seam: the
               * canonical wording is `GATE_LIMIT_NOTE` in
               * `server/src/secret-intake.ts:612-615`, which reaches the wire as
               * `SecretIntakeStatus.gateNote` on `GET /api/secrets`. This client has
               * no type, fetch or route for that endpoint (grep: zero hits for
               * `gateNote` under `src/`), and the two packages do not share code, so
               * this sentence is a restatement. NOTHING KEEPS THEM IN SYNC — the
               * parity test covers SSE event names, not prose — so an edit to the
               * server's note will not be reflected here by any mechanism.
               *
               * COMPRESSED FROM THREE LINES TO ONE, AND KEPT PERMANENT (2026-08-04,
               * the redundancy pass). Every other long note on this form either got
               * shorter or became conditional; this one had no condition available
               * to hang it on. Nothing on the client can tell whether a brief
               * implies a payment provider or a hosted database, and a keyword
               * sniff would be a guess that hides the note on the tickets that need
               * it most. Putting it behind a disclosure was considered and refused
               * for the same reason: it changes what a person WRITES, so it has to
               * be readable while they are writing. The named brands went — Stripe
               * is an example, not the rule — and the category survived, as did
               * "graded against a stub" rather than "fails", which is the half the
               * reasoning above exists to protect.
               */}
              <span>
                Grading runs with no network and no logins, so anything needing a real
                payment provider, database or login is graded against a stub.
              </span>
            </div>
            <span className="numeric shrink-0">{trimmed.length} chars</span>
          </div>
        </Panel>

        {/*
         * THREE PANELS BECAME ONE (2026-08-04, the redundancy pass).
         *
         * `Motion reference`, `Design` and `Delivery` were three `Panel`s, which
         * is three uppercase headers, three borders and three body paddings for
         * one URL field, one radio pair and one checkbox. Two of those headers
         * were also worse names than the controls under them: "Design" sat above
         * a question about who picks a mockup, and "Delivery" above a checkbox
         * that already said "when it passes". They are now three rows in ONE
         * panel, separated by the same hairline the recent-runs list uses, each
         * row carrying a plain-English label in place of its old header.
         *
         * THE ORDER IS UNCHANGED AND THE ORDER IS THE TEST. Motion stays first
         * inside the panel and the panel stays below the Ticket panel, because
         * `ticket-motion.browser.spec.ts:161` asserts `getByRole("textbox")
         * .first()` is still the brief's TEXTAREA. Moving this block above the
         * Ticket panel silently retargets four specs at a URL field.
         *
         * THE ROWS OWN THEIR PADDING, AND `bodyClassName="p-0"` IS NOT HOW YOU GET
         * THAT. `Panel` writes `px-3 py-2.5` on its body (`components/ui.tsx:54`)
         * and appends `bodyClassName` after it, but Tailwind v4 emits `padding`
         * before `padding-inline`, so `p-0` LOSES the cascade to `px-3` no matter
         * which order the class names are written in. Measured on this page
         * 2026-08-04: `getComputedStyle(body).padding` is `10px 12px` with
         * `p-0` applied, on this panel and on `RecentRuns`, which has carried the
         * same inert override since it was written. The negative margins below
         * cancel the real padding by the same amounts, so the divider runs the
         * full width of the panel and reads as a seam between two rows instead of
         * an underline on one. `RecentRuns` is left alone: its rows are links with
         * their own hover fill, and a full-bleed row there is a separate change.
         */}
        <Panel title="Options">
          <div className="-mx-3 -my-2.5 divide-y divide-line">
            {/*
             * A LINK WHOSE MOTION IS WANTED AND WHOSE CONTENT IS NOT. The brief's own
             * first URL still means "copy this site" and still feeds the outline
             * capture disclosed above; this one means only "move like this". Keeping
             * them apart is what lets the owner say he likes how something moves
             * without inheriting its headings and its palette.
             *
             * IT SITS BELOW THE BRIEF AND THAT IS LOAD-BEARING, for the same reason
             * the file input above carries its own ordering note:
             * `ticket-references.browser.spec.ts` drives the brief as
             * `getByRole("textbox").first()` and its two accelerator tests submit
             * through it, so a URL field placed ABOVE the Ticket panel would silently
             * retarget four existing specs at a control they were not written for.
             * `ticket-motion.browser.spec.ts` asserts the ordering rather than leaving
             * it to whoever next moves a panel.
             *
             * NO VALIDATION HERE, DELIBERATELY. The server owns the refusal list —
             * `site-capture.ts` refuses localhost, private and link-local ranges — and
             * a second copy on the client would drift from it. This field's job is to
             * carry the string; what the run did with it is on the run's own event
             * stream, which is the same rule every other disclosure on this form
             * follows.
             *
             * THE COPY DESCRIBES A READING, NEVER A GRADE. Nothing in this system
             * compares a build to the live page — the sealed scorer runs with no
             * network — so the sentence says what is taken and how coarsely, and stops
             * there.
             *
             * AND IT IS WRITTEN IN A TENSE THIS COMMIT CAN SUPPORT. An earlier draft
             * opened "Read once when the ticket is submitted", which asserts a
             * server-side behaviour that is not in the tree yet — the same defect as
             * the notice below, pointed at the owner from a different paragraph. The
             * note therefore states the LIMITS of any reading and hands the fact of
             * one to the run's own event stream, which is the rule the attachment
             * disclosure above already follows: sending a file is not the same as a
             * seat reading it, and the run's log is where the truth for a given run
             * is. `ticket-motion.browser.spec.ts` pins the deferring sentence, so a
             * rewrite back into the present tense has to delete a test to do it.
             */}
            <div className="px-3 py-3">
              <label className="flex flex-col gap-1.5">
                {/*
                  * THIS SENTENCE IS THE ROW'S LABEL NOW, and it is verbatim on
                  * purpose: `ticket-motion.browser.spec.ts:122` resolves the field
                  * with `getByLabel(/animation you want matched/i)` and four tests
                  * drive it. The deleted `Motion reference` panel header was the
                  * redundancy — it named the same thing twice, once in internal
                  * vocabulary and once in words a person uses.
                  */}
                <span className="text-[13px] font-medium text-ink">
                  A page whose animation you want matched
                </span>
                {/*
                  * `type="url"` FOR THE KEYBOARD, NOT FOR VALIDATION. It is not inside
                  * a field set this form validates and the submit path never reads
                  * `checkValidity`, so a malformed string still posts and the server
                  * still answers; what the type buys is the URL keyboard on a phone
                  * and the browser's own autofill behaviour.
                  */}
                <input
                  type="url"
                  inputMode="url"
                  placeholder="https://…"
                  value={motionUrl}
                  onChange={(event) => setMotionUrl(event.target.value)}
                  // The bordered-field idiom this app already has, copied from the
                  // plan dialogue's answer box rather than invented: `bg-canvas`
                  // against the panel's `bg-surface` is what makes a field read as a
                  // field, and `focus:border-line-strong` is the focus affordance
                  // every other input on this side of the app uses.
                  className="w-full rounded-sm border border-line bg-canvas px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                />
              </label>
              {/*
                * SHORTENED 2026-08-04. The rounding clause ("durations are rounded,
                * because two readings of the same page never agree exactly") is cut:
                * it described the precision of a reading rather than anything the
                * owner decides while pasting a URL, and the run's own event stream,
                * which the surviving sentence still points at, is where a specific
                * reading is reported. The two em-dashes went with it; the sentence is
                * a comma list now.
                */}
              <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">
                Only the movement is taken from this page, not its words, layout or
                colours. What the run made of the link is on the run&rsquo;s own event
                stream.
              </p>
            </div>

            {/*
             * THE RUN STOPS, AND UNTIL NOW THE FORM NEVER SAID SO. Every submission
             * from this page went out as `"ask"` and a dashboard submission is
             * interactive by both of the server's tests, so the DESIGN lane's mockups
             * park the run at `awaiting_input` mid-build (`orchestrator.ts:1505-1509`)
             * and it waits for a click the ticket form gave no warning about — on a run
             * the owner had every reason to leave unattended. The row discloses the
             * stop and, with `"auto"`, is the way past it.
             *
             * WHAT THIS ROW DOES NOT COVER, since it reads like a promise that every
             * run stops: the park needs the lane to have RUN and to have produced
             * mockups with none locked. `designLaneMode` returns "off" for a ticket
             * with no UI surface and "degraded" when the stills capability is missing,
             * and neither produces a mockup to choose between — so on those tickets
             * "Ask" changes nothing at all. This form cannot tell which it is: the
             * surface is classified server-side from the brief, after submit, and no
             * endpoint predicts it. The wording below therefore says what happens
             * "once the mockups exist" rather than "every run".
             *
             * NO DURATION IS NAMED, DELIBERATELY. The wait is
             * `DASHBOARD_DESIGN_LOCK_TIMEOUT_MIN` minutes
             * (`design-lock.ts:54-57`), the env var overrides the built-in default,
             * and no route on this API exposes the resolved value — so any number
             * printed here would be a guess that goes silently wrong the day the
             * variable is set. "The window closes" is the phrase the mockup deck
             * already uses for the same event (`design-lock.tsx`'s `SUBTITLE.pending`),
             * kept identical so the two screens are one vocabulary.
             *
             * THAT LAST TIE IS DELIBERATELY BROKEN AS OF 2026-08-04. "The window
             * closes" is the phrase the mockup deck uses, and it is also a phrase that
             * means nothing until you have already seen a run park, which is the exact
             * class of vocabulary this whole pass exists to remove. The note now says
             * "if you do not answer in time". The two screens are no longer one string
             * for this event; they are one FACT, stated at the reading level each
             * screen's reader is at. The deck can be brought to this wording later.
             *
             * WHAT DID NOT GET SHORTENED IS "once the mockups exist", and that is not
             * an oversight: the paragraph above is the reason. Without it the sentence
             * promises that asking always stops the run, which is false for every
             * ticket `designLaneMode` classifies as "off" or "degraded". The design
             * spec for this pass dropped that clause; it is kept and the spec is
             * reported as corrected.
             */}
            <div className="px-3 py-3">
              {/*
                * THE ROW LABEL IS THE THING, NOT THE DEPARTMENT. "Design" was a panel
                * header above a question about who chooses a mockup, which is vaguer
                * than the control it introduced. With "Mockups" carrying the noun, the
                * first choice reads "Ask me which to build" rather than repeating the
                * word one line under itself.
                */}
              <p className="text-[13px] font-medium text-ink">Mockups</p>
              <div
                role="radiogroup"
                aria-label="Mockups"
                className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5"
              >
                {DESIGN_CHOICES.map((choice) => (
                  <label
                    key={choice.value}
                    className="flex cursor-pointer items-center gap-2"
                  >
                    <input
                      type="radio"
                      // A SHARED `name` IS THE GROUPING, which is what gives arrow-key
                      // navigation and one-tab-stop behaviour for free. It is never
                      // read off the form — the value goes to `createRun` from state —
                      // so it only has to be unique within this form.
                      name="designLock"
                      value={choice.value}
                      checked={designLock === choice.value}
                      onChange={() => setDesignLock(choice.value)}
                      className="size-3.5 shrink-0 accent-[var(--color-accent)]"
                    />
                    <span className="text-[13px] font-medium text-ink">{choice.label}</span>
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">
                Asking stops the run once the mockups exist and waits for your pick. If you
                do not answer in time, ui-designer picks and the run carries on.
              </p>
            </div>

            {/*
              * "Delivery" WAS THE WORST OF THE FOUR HEADERS. It named a department
              * above a checkbox whose own label already ended "when it passes", so the
              * screen said the same idea twice in two vocabularies, one of them
              * internal. The row label takes the condition and the checkbox keeps only
              * the action.
              *
              * "Off by default" WENT WITH IT. An unchecked checkbox states its own
              * default; a sentence restating it is the redundancy this pass is named
              * for. What survives is the half a person cannot see from the control:
              * where the build ends up when the box is off.
              */}
            <div className="px-3 py-3">
              <p className="text-[13px] font-medium text-ink">When it passes</p>
              <label className="mt-1.5 flex cursor-pointer items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={deploy}
                  onChange={(event) => setDeploy(event.target.checked)}
                  className="size-3.5 shrink-0 accent-[var(--color-accent)]"
                />
                <span className="text-[13px] text-ink">Deploy a preview</span>
              </label>
              <p className="mt-1.5 text-[11.5px] leading-snug text-ink-faint">
                When off, the build stays on this machine.
              </p>
            </div>
          </div>
        </Panel>

        <div className="flex flex-wrap items-center gap-3">
          {/*
            * `size="lg"` IS THE ONE CALL SITE THE AXIS WAS ADDED FOR — UX-GAPS
            * item 17's other half. `BUTTON_SIZE.lg` (`components/ui.tsx:179`)
            * takes this from ~28px to ~38px, which is what stops the submit
            * button of the page whose whole purpose is starting a run from being
            * the same size as `run detail` and the same size as a canvas filter
            * chip that happens to be on. The size axis is another agent's edit,
            * landed mid-pass; that file's comment states the convention nothing
            * enforces — at most one `lg` per screen — and this is that one.
            *
            * THE `title` IS THE ONLY PLACE THE ACCELERATOR IS NAMED. A hover
            * tooltip teaches nobody on a touch screen and nobody driving the form
            * from the keyboard, which is precisely the population the shortcut is
            * for. A visible hint was left out because the owner has been cutting
            * text off this form all week; that trade-off is his to reverse.
            */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            title="⌘ / Ctrl + Enter"
            disabled={blockedReason !== null || submitting}
          >
            {submitting ? "Submitting…" : "Start run"}
          </Button>
          {blockedReason !== null && (
            <span className="text-[12px] text-ink-faint">{blockedReason}</span>
          )}
          {/*
            * WHY THIS SUBMIT IS SLOW, SAID WHILE IT IS BEING SLOW.
            *
            * The capture runs INSIDE the POST (`http.ts:1136-1137`) because the
            * outline it produces decides the ticket id, and the route's own bounds
            * sum to roughly a minute in the worst case. No duration is printed —
            * same rule the design row follows — because nothing on this wire
            * exposes the resolved budget, and a number here would go quietly wrong
            * the day it changes. It is phrased as the policy rather than as
            * progress: this client cannot see whether a capture is actually
            * running, and on a refused host the answer is that none is.
            *
            * SHORTENED 2026-08-04. It is read while a disabled button says
            * "Submitting…", so the comparison to a submit without a link was
            * describing a run that is not happening. What a person waiting needs is
            * the cause and the expectation, which is what is left.
            */}
          {submitting && linksToAPage(ticketText) && (
            <span className="text-[12px] text-ink-faint">
              Capturing the link first, so this takes a moment.
            </span>
          )}
          {submitError !== null && (
            <span
              role="alert"
              className={cx(
                "rounded-sm border border-fail/40 bg-fail-dim px-2 py-1 text-[12px] text-fail",
              )}
            >
              {submitError}
            </span>
          )}
        </div>

        <RecentRuns />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <AuthPanel />
        <Panel
          title="Model"
          /*
           * SUBTITLE REMOVED 2026-07-30 — the third restatement of "this uses your
           * plan, not an API key" on one screen (the auth panel said it, its provider
           * row said it, this said it). The cost invariant is real and enforced in the
           * database; it did not need repeating above a dropdown.
           */
        >
          <ModelPicker
            models={models}
            isLoading={isLoading}
            errorText={error === undefined ? null : errorMessage(error)}
            value={modelId}
            onChange={setModelId}
          />
        </Panel>
      </div>
    </form>
  );
}
