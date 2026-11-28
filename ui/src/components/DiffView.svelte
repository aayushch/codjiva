<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { api, type GitFileDiff } from '$lib/ipc';
  import {
    blocksOf,
    changeDetail,
    changeStarts,
    changeTitle,
    countsOf,
    rowsOf,
    type DiffRow,
  } from '$lib/diff';
  import { highlightLines, linesOf } from '$lib/highlight';
  import { app, CODE_FONT_DEFAULT, codeFontSize } from '$lib/state/app.svelte';
  import { diffs } from '$lib/state/diffs.svelte';
  import Icon from './Icon.svelte';

  // What the editor area shows for a file in place of its text while the
  // Changes button of the toolbar is on: one change of the file, as the
  // lines it removed and the lines it added.
  //
  // Which change. `diffs` (lib/state/diffs.svelte.ts) holds the changes of
  // the file, newest first: the changes that are not committed, when there
  // are any, and then the commits that changed the file. One of them is on
  // screen. The toolbar has the list and the buttons that step through it.
  // This component reads the list from git, and reads the two versions of
  // the change on screen. A change is compared with the version before it.
  //
  // The bar at the top names the change on the left. On the right it has:
  //   - how many lines the change added and removed;
  //   - two buttons that scroll to the previous and to the next place where
  //     lines changed. F7 and Shift+F7 do the same;
  //   - a switch between "Changes only", which folds away the lines that
  //     did not change, except `CONTEXT` lines around each change, and
  //     "Whole file", which shows every line. A click on a row of folded
  //     lines shows those lines;
  //   - a switch between "Single", one column with the removed lines above
  //     the added lines, and "Split", the old version on the left and the
  //     new version on the right.
  // Both switches are kept in the settings with the layout of the panels.
  //
  // In one column, each row has the number of the line in the old version
  // and its number in the new version. A click on a number of the new
  // version shows that line in the text of the file. This works only while
  // the new version is the file on disk, because a line of an earlier
  // version can be at another place in the file now.
  //
  // Rows are `lineHeight` pixels tall, and only the rows in view, plus
  // `OVERSCAN` above and below, are in the page. In two columns each column
  // scrolls sideways by itself, and the two scroll up and down together.
  //
  // `relPath` is the file's path inside the workspace. `refresh` is a number
  // that changes when the file changed on disk.
  let { relPath, refresh = 0 }: { relPath: string; refresh?: number } =
    $props();

  const OVERSCAN = 20;

  const fontSize = $derived(codeFontSize(app.settings?.codeFontSize));
  const lineHeight = $derived(Math.round((fontSize * 20) / CODE_FONT_DEFAULT));

  // The list of changes is read again when another file is shown, when the
  // file changes on disk, and when git reports other changed files, because
  // each of these can add or remove the entry for what is not committed.
  $effect(() => {
    void [refresh, app.gitEntries];
    void diffs.load(relPath);
  });

  const change = $derived(diffs.path === relPath ? diffs.change : null);
  // A text that is the same for as long as the same two versions are on
  // screen. The versions are read again only when it changes.
  const sides = $derived(
    change ? JSON.stringify([change.old, change.new]) : null,
  );
  // True when the new version is the file on disk.
  const onDisk = $derived(change?.new.commit == null);

  // The two versions that were read, and the text `sides` had then.
  // `problem` is the reason when reading failed.
  let diff = $state.raw<GitFileDiff | null>(null);
  let diffOf = $state<string | null>(null);
  let problem = $state<string | null>(null);

  $effect(() => {
    const wanted = sides;
    // The file on disk is read again when it changes. A version in a commit
    // never changes.
    if (onDisk) void refresh;
    if (!wanted) {
      diff = null;
      diffOf = null;
      problem = null;
      return;
    }
    const [old, next] = JSON.parse(wanted);
    let cancelled = false;
    api
      .gitFileDiff(old, next)
      .then((found) => {
        if (cancelled) return;
        const other = diffOf !== wanted;
        diff = found;
        diffOf = wanted;
        problem = null;
        if (other) startAtFirstChange();
      })
      .catch((error) => {
        if (cancelled) return;
        diff = null;
        diffOf = wanted;
        problem = error?.message ?? String(error);
      });
    return () => {
      cancelled = true;
    };
  });

  // True while the versions on screen are not the ones of `change`, because
  // the new ones are still being read.
  const reading = $derived(sides != null && diffOf !== sides);

  // The lines of both versions as HTML. They are plain text until the
  // language of the file is known and the colours are worked out.
  let oldHtml = $state.raw<string[]>([]);
  let newHtml = $state.raw<string[]>([]);
  const language = $derived(
    app.fileInfo?.relPath === relPath ? app.fileInfo.highlighter : '',
  );
  $effect(() => {
    const shown = diff;
    const name = language;
    if (!shown) {
      oldHtml = [];
      newHtml = [];
      return;
    }
    let cancelled = false;
    Promise.all([
      highlightLines(shown.oldText, name),
      highlightLines(shown.newText, name),
    ]).then(([old, next]) => {
      if (cancelled) return;
      oldHtml = old;
      newHtml = next;
    });
    return () => {
      cancelled = true;
    };
  });

  // How many lines a text has. An empty text has none.
  const countOf = (text: string) => (text === '' ? 0 : linesOf(text).length);
  const blocks = $derived(
    diff
      ? blocksOf(diff.hunks, countOf(diff.oldText), countOf(diff.newText))
      : [],
  );
  // The positions in `blocks` of the folded stretches the user opened. It
  // is emptied when other versions are shown.
  let opened = $state.raw<ReadonlySet<number>>(new Set());
  const rows = $derived(
    rowsOf(blocks, {
      split: app.diffSplit,
      whole: app.diffWholeFile,
      opened,
    }),
  );
  const starts = $derived(changeStarts(rows));
  const counts = $derived(countsOf(diff?.hunks ?? []));
  // The width of a column of line numbers, in characters.
  const gutter = $derived(
    String(Math.max(oldHtml.length, newHtml.length, 1)).length,
  );

  // The columns on screen: one that shows both versions, or one for each.
  type Column = 'both' | 'old' | 'new';
  const columns = $derived<Column[]>(app.diffSplit ? ['old', 'new'] : ['both']);
  // The scrolling element of each column, in the order of `columns`.
  let panes = $state<(HTMLDivElement | undefined)[]>([]);
  let scrollTop = $state(0);
  let height = $state(600);
  const first = $derived(
    Math.max(0, Math.floor(scrollTop / lineHeight) - OVERSCAN),
  );
  const last = $derived(
    Math.min(
      rows.length,
      Math.ceil((scrollTop + height) / lineHeight) + OVERSCAN,
    ),
  );

  $effect(() => {
    const pane = panes[0];
    if (!pane) return;
    const observer = new ResizeObserver(() => {
      height = pane.clientHeight;
    });
    observer.observe(pane);
    return () => observer.disconnect();
  });

  // A column was scrolled. The other column is scrolled to the same
  // distance from the top.
  function onScroll(event: Event) {
    const from = event.currentTarget as HTMLDivElement;
    scrollTop = from.scrollTop;
    for (const pane of panes)
      if (pane && pane !== from && pane.scrollTop !== from.scrollTop)
        pane.scrollTop = from.scrollTop;
  }
  function scrollTo(top: number) {
    for (const pane of panes) if (pane) pane.scrollTop = top;
  }
  // Where the view scrolls to for the row at `index`: the row is a third of
  // the way down the view.
  const topFor = (index: number) =>
    Math.max(0, index * lineHeight - Math.round(height / 3));

  // New versions start at their first change, with the folds closed.
  async function startAtFirstChange() {
    opened = new Set();
    await tick();
    scrollTo(starts.length ? topFor(starts[0]) : 0);
  }
  // The columns are made again when the layout changes between one column
  // and two. They then start at the top, so they are scrolled back to where
  // the view was.
  $effect(() => {
    void app.diffSplit;
    const top = untrack(() => scrollTop);
    tick().then(() => scrollTo(top));
  });

  // How long the rows of a change stay highlighted after the view went to
  // that change, in milliseconds. It is the length of the `diff-flash`
  // animations in the stylesheet.
  const FLASH_MS = 900;
  // The rows that are highlighted, from position `first` to position `last`
  // in `rows`, or null when no row is highlighted. `turn` is 'a' or 'b' and
  // changes with every highlight. Each letter has its own animation in the
  // stylesheet, so a highlight starts from the beginning when the view goes
  // to a change whose rows are still highlighted.
  let flash = $state<{ first: number; last: number; turn: 'a' | 'b' } | null>(
    null,
  );
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  // Highlights the run of changed rows that starts at position `at` in
  // `rows`. The highlight fades out and is removed after `FLASH_MS`.
  function flashChange(at: number) {
    const changed = (row: DiffRow | undefined) =>
      row?.kind === 'line' && row.change;
    let end = at;
    while (changed(rows[end + 1])) end++;
    clearTimeout(flashTimer);
    flash = { first: at, last: end, turn: flash?.turn === 'a' ? 'b' : 'a' };
    flashTimer = setTimeout(() => (flash = null), FLASH_MS);
  }
  // The positions in `flash` belong to one list of rows, so the highlight is
  // removed when `rows` becomes another list.
  $effect(() => {
    void rows;
    clearTimeout(flashTimer);
    flash = null;
  });
  // The class that highlights the row at position `index` in `rows`, or an
  // empty text for a row that is not highlighted.
  const flashOf = (index: number) =>
    flash && index >= flash.first && index <= flash.last
      ? `flash-${flash.turn}`
      : '';

  // Scrolls to the next place where lines changed, or with `forward` false
  // to the previous one, counted from where the view is now. The rows of
  // that change are highlighted for a moment, so that the user can tell it
  // from the changes around it.
  function goToChange(forward: boolean) {
    // The distance is read from the column itself. `scrollTop` is set by
    // the scroll event, which arrives a moment after the column moved.
    const from = panes[0]?.scrollTop ?? scrollTop;
    const at = forward
      ? starts.find((start) => topFor(start) > from + 1)
      : starts.filter((start) => topFor(start) < from - 1).pop();
    if (at == null) return;
    scrollTo(topFor(at));
    flashChange(at);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key !== 'F7' || app.dialog) return;
    event.preventDefault();
    goToChange(!event.shiftKey);
  }

  function setLayout(split: boolean) {
    app.diffSplit = split;
    void app.saveLayout();
  }
  function setWhole(whole: boolean) {
    app.diffWholeFile = whole;
    void app.saveLayout();
  }

  // The class of a row of code in a column: `removed` and `added` for a
  // changed line the column shows, and `blank` for a row of a two-column
  // view whose line is only in the other column.
  function classOf(row: DiffRow & { kind: 'line' }, column: Column) {
    if (!row.change) return '';
    if (column === 'old') return row.old != null ? 'removed' : 'blank';
    if (column === 'new') return row.next != null ? 'added' : 'blank';
    return row.next != null ? 'added' : 'removed';
  }
  // The HTML of the code a row has in a column, or an empty text.
  function htmlOf(row: DiffRow & { kind: 'line' }, column: Column) {
    const fromNew = column === 'new' || (column === 'both' && row.next != null);
    const html = fromNew
      ? row.next != null && newHtml[row.next - 1]
      : row.old != null && oldHtml[row.old - 1];
    return html || ' ';
  }
  const now = () => Math.floor(Date.now() / 1000);
</script>

<svelte:window onkeydown={onKey} />

<div
  class="diff"
  style:--source-font-size="{fontSize}px"
  style:--source-line-height="{lineHeight}px"
>
  {#if diffs.problem}
    <div class="source-note">{diffs.problem}</div>
  {:else if !diffs.loaded || diffs.path !== relPath}
    <div class="source-note">Reading…</div>
  {:else if !change}
    <div class="source-note">Git has no history for this file.</div>
  {:else}
    <div class="diff-bar">
      <div class="diff-what">
        <b>{changeTitle(change)}</b>
        <span class="muted"
          >{changeDetail(change, now())}{#if change.commit}{change.old
              ? change.old.path !== change.new.path
                ? ` · renamed from ${change.old.path}`
                : ''
              : ' · created the file'}{/if}</span
        >
      </div>
      {#if diff && !diff.binary && !diff.tooLarge}
        <span class="diff-counts" aria-label="Lines added and removed"
          ><span class="plus">+{counts.added}</span>
          <span class="minus">−{counts.removed}</span></span
        >
        <button
          class="tb-btn tip-end"
          data-tip="Previous change (Shift+F7)"
          aria-label="Previous change"
          disabled={!starts.length}
          onclick={() => goToChange(false)}><Icon name="up" /></button
        >
        <button
          class="tb-btn tip-end"
          data-tip="Next change (F7)"
          aria-label="Next change"
          disabled={!starts.length}
          onclick={() => goToChange(true)}><Icon name="down" /></button
        >
      {/if}
      <div class="diff-switch" role="group" aria-label="Lines shown">
        <button
          class:on={!app.diffWholeFile}
          aria-pressed={!app.diffWholeFile}
          onclick={() => setWhole(false)}>Changes only</button
        ><button
          class:on={app.diffWholeFile}
          aria-pressed={app.diffWholeFile}
          onclick={() => setWhole(true)}>Whole file</button
        >
      </div>
      <div class="diff-switch" role="group" aria-label="Columns">
        <button
          class:on={!app.diffSplit}
          aria-pressed={!app.diffSplit}
          onclick={() => setLayout(false)}>Single</button
        ><button
          class:on={app.diffSplit}
          aria-pressed={app.diffSplit}
          onclick={() => setLayout(true)}>Split</button
        >
      </div>
    </div>
    {#if problem}
      <div class="source-note">{problem}</div>
    {:else if !diff}
      <div class="source-note">Reading…</div>
    {:else if diff.binary}
      <div class="source-note">
        This file is not text, so its versions are not compared.
      </div>
    {:else if diff.tooLarge}
      <div class="source-note">This file is too large to compare.</div>
    {:else}
      <div class="diff-panes" class:split={app.diffSplit} class:reading>
        {#each columns as column, at (column)}
          <div
            class="diff-pane"
            data-column={column}
            bind:this={panes[at]}
            onscroll={onScroll}
          >
            <div class="diff-sizer" style:height="{rows.length * lineHeight}px">
              <div class="diff-rows" style:top="{first * lineHeight}px">
                {#each rows.slice(first, last) as row, i (first + i)}
                  {#if row.kind === 'fold'}
                    <button
                      class="diff-fold"
                      data-block={row.block}
                      onclick={() => (opened = new Set([...opened, row.block]))}
                      ><span
                        >⋯ {row.lines} unchanged {row.lines === 1
                          ? 'line'
                          : 'lines'}</span
                      ></button
                    >
                  {:else}
                    <div
                      class="diff-line {classOf(row, column)} {flashOf(
                        first + i,
                      )}"
                    >
                      {#if column !== 'new'}<span
                          class="diff-num"
                          style:width="{gutter + 2}ch">{row.old ?? ''}</span
                        >{/if}{#if column !== 'old'}{#if onDisk && row.next != null}<button
                            class="diff-num to-line"
                            style:width="{gutter + 2}ch"
                            title="Show this line in the file"
                            onclick={() => app.selectFile(relPath, row.next!)}
                            >{row.next}</button
                          >{:else}<span
                            class="diff-num"
                            style:width="{gutter + 2}ch">{row.next ?? ''}</span
                          >{/if}{/if}<span class="diff-sign"
                        >{classOf(row, column) === 'added'
                          ? '+'
                          : classOf(row, column) === 'removed'
                            ? '−'
                            : ' '}</span
                      ><span class="source-text"
                        >{@html htmlOf(row, column)}</span
                      >
                    </div>
                  {/if}
                {/each}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
