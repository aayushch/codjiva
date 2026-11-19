<script lang="ts">
  import { api } from '$lib/ipc';
  import { highlightLines } from '$lib/highlight';
  import { app } from '$lib/state/app.svelte';

  // The lines of code behind a part of a visual, shown in the inspector under
  // the part's name. The app reads them from the file itself, so what is shown
  // is always the code as it is now and never a copy an agent typed.
  //
  // `path` is the file, `line` the first line to show and `end` the last. A
  // reference without `end` names one line, and the excerpt then shows that
  // line and the five after it. At most MAX_LINES lines are shown.
  //
  // A click on the heading opens the file in the Source view at `line`.
  const MAX_LINES = 24;
  const LINES_WITHOUT_END = 6;

  let { path, line, end }: { path: string; line: number; end?: number } =
    $props();

  // The lines to show, as HTML with the colours of the source view, and the
  // number of the first one. `problem` says why they could not be read.
  let rows = $state<string[]>([]);
  let first = $state(1);
  let problem = $state<string | null>(null);

  $effect(() => {
    const from = Math.max(1, line);
    const to = Math.min(
      from + MAX_LINES - 1,
      end != null && end >= from ? end : from + LINES_WITHOUT_END - 1,
    );
    let cancelled = false;
    rows = [];
    problem = null;
    api
      .fileRead(path)
      .then(async (content) => {
        const html = await highlightLines(content.text, content.highlighter);
        if (cancelled) return;
        first = from;
        rows = html.slice(from - 1, to);
        if (!rows.length)
          problem = `${path} has no line ${from}. The file may have changed since this was made.`;
      })
      .catch((error) => {
        if (!cancelled) problem = error?.message ?? String(error);
      });
    return () => {
      cancelled = true;
    };
  });

  const name = $derived(path.split('/').pop() ?? path);
</script>

<div class="excerpt">
  <button
    class="ref"
    title="Open {path} at line {line}"
    onclick={() => app.selectFile(path, line)}
    >{name}:{line}{end != null && end > line ? '–' + end : ''}</button
  >
  {#if problem}
    <div class="excerpt-note">{problem}</div>
  {:else if rows.length}
    <div class="excerpt-code">
      {#each rows as html, i}
        <div class="excerpt-line">
          <span class="excerpt-num">{first + i}</span><span class="excerpt-text"
            >{@html html || ' '}</span
          >
        </div>
      {/each}
    </div>
  {/if}
</div>
