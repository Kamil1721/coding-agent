# Batch 2B prerequisites, 2026-09-08

Batch 2B is incomplete. The required preview-refusal correction is committed. Prompt baselines are committed and their actual producers passed mutation checks. T21 needs an owner decision because its exact-six-proof acceptance criterion conflicts with the historical fixture and resolver interface. T21 implementation and T22 through T26 have not started. G3 remains an owner-only run and was not started.

| Work | Current behavior | Next step |
|---|---|---|
| Required carried item 1: missing internal preview names | Complete in `aa724165d435c9a1174f59f2150520e0c2a8f4b4`; missing internal paths return `404 path_internal` | Controlled live activation remains separate |
| Prompt baselines | Nine branches covered, with three earlier captures reused unchanged and six new captures; 20 tests pass | Preserve the captures while changing prompt producers |
| T21: sentence facts and requirement-copy checks | Decision pending; no implementation | Resolve the fixture contradiction below |
| T22: app page kind and routing | Not started | Follows T21 |
| T23: decorative-control probe | Not started | Include the clinic module dependency in its future fixture |
| T24: critic with available captures | Not started | Implement after the decision boundary is cleared |
| T25: chooser evidence and departures | Not started | Preserve T16's contract while extending chooser checks |
| T26: hero amendment after choice | Not started | Follows T25; carry the deferred dial-format work |
| Carried items 2 through 5 | Not started | Apply on the relevant file touches; retained in BACKLOG.md |

## Preview refusal correction

The preview resolver now returns `path_internal` when workspace resolution returns `not_found` for an internal path. Existing refusal precedence and owner code-browser access remain covered by the targeted suite. The change includes no UI work or live API activation.

Root ran these commands from `dashboard/server`:

```sh
npm run build --silent
python3 /tmp/wave2b-preview-mutation.py
node --test dist/preview-route.test.js dist/code-files.test.js dist/code-files-route.test.js
```

The build and mutation runner exited 0. The restored suite reported **45 tests, 45 passed, 0 failed** in `/tmp/wave2b-preview-root-green.log`. The mutation removes only the compiled missing-internal guard. Its child Node command exits 1 through three named refusal-code assertions: `/.claude/missing.json`, `/design-refs/missing.json` and `/visible-acceptance/missing.spec.mjs` return actual `not_found`, expected `path_internal`. The runner restores the exact compiled bytes; `/tmp/wave2b-preview-mutation.log` records SHA-256 `e7e585f04e1e676b9c34fe41d761736a6cb5ae99de2fc89465e4400942b25477`.

The initial red log, `/tmp/wave2b-preview-red.log`, included an invalid expectation for `/ticket-missing.md`. Only its two genuine internal-path failures count as original red controls. The final mutation uses all three valid paths above. `STATIC_INTERNAL_ROOTS` names exact roots, including `TICKET.md`; it does not make `ticket-2.md` internal. The review example treating `/ticket-2.md` as internal contradicts the code.

The simplify pass exposed a typed-constant regression that was corrected. Root verified the subsequent low-depth debugfix security, logic and runtime-edge passes without further findings. This API fixture change did not require a UI adversary run.

## T21 decision required

The historical clinic contract is at `dashboard/runs/run-2026-09-04T15-54-06-323Z-131fd85f/results/creative-contract.json`. Its `p.reset`, `p.local` and `p.a11y` proofs have identical evidence references:

```json
{
  "kind": "owner_message",
  "locator": "ticket:t-822f12c1ba07308c:brief:2",
  "sha256": "822f12c1ba07308c9ff1496ec32adbe38f6e4a048840777e3fe4bb2cd8b26a20",
  "excerptSha256": "890cdaa4bed7381468e608af80037ad28d16effbb90b7fe19fb43c9a61727db2"
}
```

`CreativeEvidenceResolver.resolve(reference)` receives only that reference. It cannot classify identical references as a product goal for `p.reset` and requirements for `p.local` and `p.a11y` without introducing information outside the stated interface. Plan AC5(a) nevertheless requires exactly six requirement errors while explicitly excluding `p.reset`.

The recommended option is to preserve an unchanged historical fixture and add an explicitly derived fixture whose evidence references are rebound to sentences. The derived fixture can prove the exact-six criterion; the historical fixture records its actual legacy behavior. The alternative is to use only the original fixture and amend the expectation to accept rejection of `p.reset` too. Neither option has owner approval. The brief requires stopping for a decision outside D1 through D12, so implementation remains paused at this boundary.

A separate T23 fixture finding is already established: clinic `app/main.mjs` imports `./wizard.mjs`. The plan's fixture copy list omits that dependency. Include it when constructing the isolated fixture; do not alter the historical run.

## Prompt baseline evidence and remaining checks

The new test and fixture files are `dashboard/server/src/wave2b-prompt-goldens.test.ts`, `dashboard/server/src/test-fixtures/wave2b-prompt-inputs.ts` and `dashboard/server/src/test-fixtures/wave2b-prompt-goldens.ts`. They cover landing and degraded canvass, manual and automatic choice, expansion with and without video, and initial and repair author prompts. The test reuses three Batch 2A captures directly and checks six new captures.

Root's `/tmp/wave2b-goldens-root-green.log` reports **20 tests, 20 passed, 0 failed**, including nine one-byte comparison controls. Root also ran `python3 /tmp/verify-wave2b-prompt-runtime-mutations.py` from the repository root. The runner exited 0. Its design producer mutation caused seven runtime golden failures, and its author producer mutation caused two; each child exited 1 through `runtime Batch 2B bytes must match the captured hash`. Both compiled modules were restored byte for byte. The combined restored suite reported **42 tests, 42 passed, 0 failed** in `/tmp/wave2b-prompt-baseline-runtime-mutations.log`.

The restored design module SHA-256 was `1a5830e5293072246e9682d357f07200e0e8b3461d88595594bdc3a63e82f1f9`; the author module was `0597feffc2e9a3107347ac5d180bafbab38e1213d96c59dc106376ac7bea9fad`. Baselines are committed in `b88359b1a510e3b9ce3c1282fcc6d87897f06433`. Read-only simplify and logic review reported no findings. Author captures cover the SDK user prompt, including planned invariants, vocabulary and repair strings; they do not capture `options.systemPrompt` or the combined system/user envelope.

The final comparison against `/tmp/wave2-batch2b-protected-baseline.json` found 440 of 441 files unchanged. Only `docs/BACKLOG.md` changed, with its original 11,166-byte prefix preserved and this record appended. `docs/CAPABILITIES.md` remains unchanged at 5,545 bytes. Sentinel hook wiring and executable state were checked, but that does not establish runtime enforcement. No provider run, G3 run, UI change or live activation was performed for these prerequisites.

The four remaining corrective items are stale `judge.json` cleanup on the no-attempt path, `assert.doesNotReject` in the cleanup-failure test, borrow assertion ordering, and required `chosenDirectionReason` in both API type mirrors. Earlier deferred findings remain in the backlog, including Unicode filesystem folding, the video-policy decision, unmapped accessible-name text and the hue comment.
