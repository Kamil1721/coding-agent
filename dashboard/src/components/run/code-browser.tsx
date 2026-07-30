"use client";

/**
 * code-browser.tsx — the run's own code, in the browser: a file tree on the
 * left, the file beside it.
 *
 * WHY IT EXISTS. Everything else on this page describes the run. This shows what
 * the run PRODUCED. Until now the only pointer to that was
 * `RunDetail.artifactPath` — an absolute host path, rendered as text, openable
 * only in a terminal. The owner asked for the Cursor arrangement: structure on
 * the left, contents on the right.
 *
 * FIVE DECISIONS, EACH OF WHICH HAD AN EASIER WRONG ANSWER.
 *
 * 1. NO SYNTAX HIGHLIGHTER. Every option is a bundle in the hundreds of
 *    kilobytes for a panel that shows one file at a time. Monospace with a line
 *    gutter is a better read than a 300 KB dependency, so the only language
 *    awareness here is the extension shown on the eyebrow.
 *
 * 2. THE GUTTER IS ONE TEXT NODE, NOT ONE ELEMENT PER LINE. A 256 KB file is
 *    ~8,000 lines; 8,000 `<div>`s is a slow paint and a scroll that stutters.
 *    Two `<pre>`s side by side in one scroll container stay aligned because they
 *    share font size and line height, and each is a single text node.
 *
 * 3. `whitespace-pre`, NEVER `pre-wrap`. A wrapped line and a numbered gutter
 *    cannot both be right: the moment one line wraps, every number below it
 *    points at the wrong row. Horizontal scroll is the honest trade.
 *
 * 4. TRUNCATION IS STATED, NOT IMPLIED. The server caps a file at 256 KB and
 *    sends the real size; this panel says "showing the first 256 KB of 11.8 MB"
 *    above the text. A viewer that silently shows a prefix is lying about what
 *    the run wrote — the builder transcript on the run this was built against is
 *    12,369,476 bytes.
 *
 * 5. EXCLUSIONS ARE RENDERED. `.git`, `node_modules` and every credential file
 *    are refused by the server, and each refusal arrives with its reason and is
 *    listed under the tree. A viewer that silently drops them is
 *    indistinguishable from one that could not read the directory.
 *
 * KEYBOARD, AND NO FOCUS TRAP. The tree is nested `<ul>`/`<li>` with a real
 * `<button>` per row, so Tab reaches every row in document order and Tab leaves
 * again — no roving tabindex, no key handler that swallows arrows, nothing that
 * holds focus. Directories carry `aria-expanded`; the open file carries
 * `aria-current="true"`. This matches `AgentRoster`, which is this page's
 * established answer to "the picture is not the accessible representation".
 *
 * NO ANIMATION AT ALL, so there is nothing for `prefers-reduced-motion` to
 * still. The only moving thing is `Skeleton`, whose pulse globals.css already
 * stops under that query.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import useSWR from "swr";

import type {
  CodeFileResponse,
  CodeTreeEntry,
  CodeTreeResponse,
} from "@/lib/api-types";
import { KEY, errorMessage, swrFetcher } from "@/lib/api";
import {
  ancestorDirs,
  buildCodeTree,
  firstInterestingFile,
  formatBytes,
  initiallyOpen,
  languageOf,
  type CodeNode,
} from "@/lib/code-tree";
import { Button, EmptyState, MonoPath, Panel, Skeleton, cx } from "@/components/ui";

/** `+` / `−` rather than a chevron glyph: no icon set is loaded on this page. */
function Twisty({ open }: { open: boolean }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className="mt-[1px] inline-block w-[9px] shrink-0 text-center font-mono text-[10px] leading-[18px] text-ink-faint"
    >
      {open ? "−" : "+"}
    </span>
  );
}

function TreeRow({
  node,
  openDirs,
  selected,
  onToggle,
  onSelect,
}: {
  node: CodeNode;
  openDirs: ReadonlySet<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): ReactNode {
  const { entry } = node;
  const isDir = entry.type === "dir";
  const open = openDirs.has(entry.path);
  const isSelected = !isDir && entry.path === selected;

  return (
    <li>
      <button
        type="button"
        onClick={() => (isDir ? onToggle(entry.path) : onSelect(entry.path))}
        aria-expanded={isDir ? open : undefined}
        aria-current={isSelected ? "true" : undefined}
        title={entry.path}
        className={cx(
          "flex w-full items-start gap-1.5 py-[3px] pr-2 text-left transition-colors",
          "hover:bg-surface-raised",
          isSelected && "bg-accent-dim/25",
        )}
        // Indent by depth. Inline, because Tailwind cannot see a class built by
        // string concatenation and the padding would silently vanish.
        style={{ paddingLeft: `${String(8 + node.depth * 12)}px` }}
      >
        {isDir ? <Twisty open={open} /> : <span aria-hidden="true" className="w-[9px] shrink-0" />}
        <span
          className={cx(
            "min-w-0 flex-1 truncate font-mono text-[11.5px] leading-[18px]",
            isDir ? "text-ink-dim" : isSelected ? "text-ink" : "text-ink-dim",
          )}
        >
          {entry.name}
          {isDir && "/"}
        </span>
        {entry.bytes !== null && (
          <span className="numeric shrink-0 text-[10px] leading-[18px] text-ink-faint">
            {formatBytes(entry.bytes)}
          </span>
        )}
      </button>
      {isDir && open && node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.entry.path}
              node={child}
              openDirs={openDirs}
              selected={selected}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The file, or the reason there is no file.
 *
 * THE THREE "NO TEXT" CASES ARE THREE DIFFERENT SENTENCES. Binary bytes,
 * withheld-by-the-redactor and nothing-selected-yet are not the same fact, and a
 * single "cannot display" would erase the only interesting one of the three.
 */
function FileView({
  file,
  loading,
  error,
}: {
  file: CodeFileResponse | undefined;
  loading: boolean;
  error: unknown;
}): ReactNode {
  if (error !== undefined) {
    return (
      <div className="px-3 py-4 text-[12px] leading-relaxed text-fail" data-testid="code-error">
        {errorMessage(error)}
      </div>
    );
  }
  if (file === undefined) {
    return <div className="px-3 py-3">{loading ? <Skeleton rows={8} /> : null}</div>;
  }

  const lines = file.text === null ? 0 : file.text.split("\n").length;
  /*
   * MEASURED FROM WHAT ARRIVED, not from a copy of the server's cap.
   *
   * The truncation sentence has to name two numbers and only one of them is on
   * the wire. Re-declaring `MAX_FILE_BYTES` here would be a second constant that
   * silently goes stale the day the server's changes — and the sentence would
   * then be wrong in the most misleading possible way, understating how much is
   * missing. Encoding the text is the number that is actually true of this
   * response.
   */
  const shownBytes = file.text === null ? 0 : new TextEncoder().encode(file.text).length;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-ink" title={file.path}>
          {file.path}
        </span>
        <span className="numeric shrink-0 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
          {languageOf(file.path)} · {formatBytes(file.bytes)}
          {file.text !== null && ` · ${String(lines)} lines`}
        </span>
      </header>

      {file.truncated && (
        <p
          data-testid="code-truncated"
          className="border-b border-warn/40 bg-warn-dim/60 px-3 py-1.5 text-[11.5px] leading-snug text-ink-dim"
        >
          Truncated. Showing the first {formatBytes(shownBytes)} of {formatBytes(file.bytes)} — the
          rest is on disk only. Open the file in a terminal to read all of it.
        </p>
      )}

      {file.redactions > 0 && (
        <p
          data-testid="code-redacted"
          className="border-b border-line bg-surface-raised px-3 py-1.5 text-[11.5px] leading-snug text-ink-dim"
        >
          {file.redactions} span{file.redactions === 1 ? "" : "s"} redacted. Something in this file
          matched a credential pattern and was replaced before it reached the browser.
        </p>
      )}

      {file.text === null ? (
        <div className="px-3 py-6 text-center text-[12px] leading-relaxed text-ink-faint">
          {file.withheld !== null
            ? file.withheld
            : `Binary — ${formatBytes(file.bytes)} that are not text. Nothing is rendered rather than a page of replacement characters.`}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-w-full items-start">
            {/*
             * ONE TEXT NODE, and `select-none` so a copy of the code does not
             * come out interleaved with line numbers.
             */}
            <pre
              aria-hidden="true"
              className="shrink-0 select-none border-r border-line bg-canvas px-2 py-2 text-right font-mono text-[11.5px] leading-[17px] text-ink-faint"
            >
              {Array.from({ length: lines }, (_unused, index) => String(index + 1)).join("\n")}
            </pre>
            <pre
              data-testid="code-text"
              className="min-w-0 grow whitespace-pre px-3 py-2 font-mono text-[11.5px] leading-[17px] text-ink-dim"
            >
              {file.text}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function CodeBrowser({ runId }: { runId: string }): ReactNode {
  const {
    data: tree,
    error: treeError,
    isLoading,
    mutate: reloadTree,
  } = useSWR<CodeTreeResponse>(KEY.files(runId), swrFetcher, {
    // The workspace changes while a run builds, but not every second, and a poll
    // that re-fetched the tree under the reader's cursor would collapse folders
    // they had just opened. Revalidate on focus and on the explicit reload.
    revalidateOnFocus: true,
    keepPreviousData: true,
  });

  const [selected, setSelected] = useState<string | null>(null);
  const [openDirs, setOpenDirs] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState(false);

  const entries: readonly CodeTreeEntry[] = tree?.entries ?? [];
  const nodes = useMemo(() => buildCodeTree(entries), [entries]);

  /*
   * OPEN THE ROOT FOLDERS AND SHOW A FILE, ONCE.
   *
   * `touched` is what stops this from fighting the reader: without it, every
   * revalidation would re-open the folders they closed and jump back to
   * `index.html` from whatever they were reading. It flips on the first click and
   * never flips back.
   */
  useEffect(() => {
    if (touched || tree === undefined || tree.entries.length === 0) return;
    const first = firstInterestingFile(tree.entries);
    setOpenDirs(new Set([...initiallyOpen(tree.entries), ...(first === null ? [] : ancestorDirs(first))]));
    setSelected(first);
  }, [tree, touched]);

  const toggleDir = useCallback((path: string): void => {
    setTouched(true);
    setOpenDirs((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectFile = useCallback((path: string): void => {
    setTouched(true);
    setSelected(path);
  }, []);

  const {
    data: file,
    error: fileError,
    isLoading: fileLoading,
  } = useSWR<CodeFileResponse>(
    selected === null ? null : KEY.file(runId, selected),
    swrFetcher,
    { keepPreviousData: false, revalidateOnFocus: false },
  );

  const fileCount = entries.filter((entry) => entry.type === "file").length;

  return (
    <Panel
      title={tree === undefined ? "Code" : `Code · ${String(fileCount)} files`}
      subtitle="The run's workspace, read-only. Credential files and the git directory are refused by the server, and every file served is passed through the redactor first."
      bodyClassName="p-0"
      actions={
        <Button
          variant="ghost"
          onClick={() => {
            void reloadTree();
          }}
          title="Re-read the workspace from disk"
        >
          reload
        </Button>
      }
    >
      {treeError !== undefined ? (
        <div className="px-3 py-4">
          <p className="text-[12px] leading-relaxed text-ink-dim" data-testid="code-tree-error">
            {errorMessage(treeError)}
          </p>
        </div>
      ) : tree === undefined ? (
        <div className="px-3 py-3">{isLoading ? <Skeleton rows={6} /> : null}</div>
      ) : tree.entries.length === 0 ? (
        <EmptyState>
          This run&rsquo;s workspace is empty. A run that was cancelled before its build segment
          wrote no files.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[minmax(200px,264px)_minmax(0,1fr)]">
          {/*
           * The rail. `md:border-r` rather than a bottom border at every width:
           * at 375px the tree sits ABOVE the file and the divider has to be
           * horizontal, which is the one place this layout changes shape.
           */}
          <nav
            aria-label="Files this run produced"
            className="max-h-[240px] min-w-0 overflow-auto border-b border-line md:max-h-[520px] md:border-b-0 md:border-r"
          >
            <ul className="py-1">
              {nodes.map((node) => (
                <TreeRow
                  key={node.entry.path}
                  node={node}
                  openDirs={openDirs}
                  selected={selected}
                  onToggle={toggleDir}
                  onSelect={selectFile}
                />
              ))}
            </ul>

            {tree.truncated && (
              <p className="border-t border-line px-3 py-1.5 text-[11px] leading-snug text-warn">
                The listing hit its entry cap. Some of this workspace is not shown.
              </p>
            )}

            {tree.exclusions.length > 0 && (
              <details className="border-t border-line px-3 py-1.5">
                <summary className="cursor-pointer text-[11px] text-ink-faint">
                  {tree.exclusions.length} not shown
                </summary>
                <ul className="mt-1 space-y-1">
                  {tree.exclusions.map((one) => (
                    <li key={one.path} className="text-[11px] leading-snug text-ink-faint">
                      <code className="font-mono text-ink-dim">{one.path}</code> — {one.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <p className="border-t border-line px-3 py-1.5">
              <MonoPath path={tree.root} max={30} />
            </p>
          </nav>

          <div className="flex min-h-[240px] min-w-0 flex-col md:max-h-[520px]">
            {selected === null ? (
              <EmptyState>Pick a file.</EmptyState>
            ) : (
              <FileView file={file} loading={fileLoading} error={fileError} />
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
