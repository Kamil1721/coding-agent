/**
 * The canvas reducer — IMPORTED FROM THE SERVER, NOT COPIED.
 *
 * Phase 3's plan carried "client mirror of `foldGraph`, checked against
 * `graph-fixture.ts`" forward as an obligation. This file discharges it by
 * deleting the obligation instead of satisfying it: there is no second
 * implementation to keep in step, because the browser executes the exact module
 * `GET /api/runs/:id/graph` folds the snapshot with.
 *
 * WHY A RE-EXPORT AND NOT A COPY. The snapshot is folded server-side from
 * `store.eventsSince(runId, 0)` and the tail is folded client-side from the SSE
 * stream. Two implementations of one reducer diverge on exactly the inputs
 * nobody tests — the long run, the capped node, the terminal `status` — and the
 * symptom is a canvas that disagrees with itself only after an hour. A mirror
 * plus a fixture would catch the divergence the fixture happens to cover; an
 * import cannot diverge at all.
 *
 * WHY IT BUNDLES. `server/src/graph.ts` imports its types with `import type`,
 * so the statement is erased and the bundler never resolves the server's
 * `api-types` at runtime — the module Turbopack pulls in is pure arithmetic
 * over plain objects with no Node built-in anywhere in it. The client tsconfig's
 * `exclude: ["server"]` only trims the ROOT file set; a file reached through an
 * import still enters the program and is fully type-checked here.
 *
 * THE SPECIFIER IS EXTENSIONLESS, AND THAT IS NOT A STYLE CHOICE. This file
 * previously imported the same path with a `.js` extension, which is what the
 * SERVER's
 * `nodenext` resolution requires. `npx tsc --noEmit` passed on it, because this
 * package resolves with `moduleResolution: "bundler"`, which maps a `.js`
 * specifier onto the neighbouring `.ts` source. TURBOPACK DOES NOT. The first
 * browser load of the run page returned HTTP 500 with
 * `Module not found: Can't resolve '../../server/src/graph.js'` — the type check
 * had been green over an import that could never execute, which is precisely
 * the failure mode this repository keeps recording. Observed 2026-07-29, fixed
 * by dropping the extension, and re-observed green in the same browser.
 *
 * WHAT THIS BUYS BEYOND ONE IMPLEMENTATION. `foldGraph`'s parameters are typed
 * in the SERVER's `api-types.ts` and this package hands it values typed in the
 * CLIENT's. Phase 3 recorded server↔client union drift as unenforced — the two
 * files cannot import each other. It is now enforced AT THIS CALL SITE and
 * nowhere else, which is a real but partial guarantee and is stated as such:
 * mutual assignability of `GraphState` and one-way assignability of the event
 * union, not equivalence. A client member the server does not have, or a
 * nullability that stops matching, fails `npm run typecheck`.
 *
 * RE-RUN, NOT INHERITED. This paragraph previously cited a mutation against a
 * call site that did not exist in the tree — the file it named was never
 * committed — which in a repository with nine recorded instances of checks that
 * could only observe success is exactly the wrong thing to leave standing. The
 * call site now exists and the mutation was executed against it on 2026-07-29:
 * changing client `GraphNode.result` from `GraphResult | null` to
 * `GraphResult | undefined` failed `npx tsc --noEmit` at three sites in
 * `src/lib/use-run-graph.ts`, verbatim —
 *
 *   (103,3)  TS2322 server `GraphState` not assignable to client `GraphState`
 *            — the `emptyGraph()` seed;
 *   (135,30) TS2345 client `GraphState` not assignable to the parameter typed
 *            in the server's module — the `foldGraph` CALL, which is the one
 *            this file exists to protect;
 *   (142,26) TS2322 on `foldGraph`'s return.
 *
 * Restored, and clean again.
 */
export {
  PILL_KINDS_CAP,
  emptyGraph,
  foldGraph,
  foldGraphAll,
} from "../../server/src/graph";
