<script lang="ts">
  import { api } from '$lib/ipc';
  import { highlightLines } from '$lib/highlight';
  import { app } from '$lib/state/app.svelte';

  // The source viewer is read-only. Lines are LINE_HEIGHT pixels tall and only
  // the lines in view are in the page, so a file of many thousand lines scrolls
  // smoothly.
  const LINE_HEIGHT = 20;
  const OVERSCAN = 30;

  let { relPath, line = null }: { relPath: string; line?: number | null } =
    $props();

  let viewport: HTMLDivElement | undefined = $state();
  let lines = $state<string[]>([]);
  let truncated = $state(false);
  let problem = $state<string | null>(null);
  let loading = $state(true);
  let scrollTop = $state(0);
  let height = $state(600);

  const first = $derived(
    Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN),
  );
  const last = $derived(
    Math.min(
      lines.length,
      Math.ceil((scrollTop + height) / LINE_HEIGHT) + OVERSCAN,
    ),
  );
  const gutter = $derived(String(lines.length).length);

  // Reads and colours the file whenever a different file is shown.
  $effect(() => {
    const path = relPath;
    let cancelled = false;
    loading = true;
    problem = null;
    api
      .fileRead(path)
      .then(async (content) => {
        const html = await highlightLines(content.text, content.highlighter);
        if (cancelled) return;
        lines = html;
        truncated = content.truncated;
        loading = false;
      })
      .catch((error) => {
        if (cancelled) return;
        lines = [];
        problem = error?.message ?? String(error);
        loading = false;
      });
    return () => {
      cancelled = true;
    };
  });

  // Scrolls so the referenced line sits a third of the way down the view.
  $effect(() => {
    if (line == null || loading || !viewport) return;
    viewport.scrollTop = Math.max(
      0,
      (line - 1) * LINE_HEIGHT - viewport.clientHeight / 3,
    );
  });

  $effect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      height = viewport!.clientHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  });
</script>

<div
  class="source"
  bind:this={viewport}
  onscroll={() => (scrollTop = viewport!.scrollTop)}
>
  {#if problem}
    <div class="source-note">{problem}</div>
  {:else if loading}
    <div class="source-note">Reading…</div>
  {:else}
    <div
      class="source-sizer"
      style:height="{lines.length * LINE_HEIGHT + (truncated ? 40 : 0)}px"
    >
      <div style:transform="translateY({first * LINE_HEIGHT}px)">
        {#each lines.slice(first, last) as html, i (first + i)}
          {@const number = first + i + 1}
          <div class="source-line" class:ref={number === line}>
            <span class="source-num" style:width="{gutter + 2}ch">{number}</span
            ><span class="source-text">{@html html || ' '}</span>
          </div>
        {/each}
      </div>
      {#if truncated}
        <div class="source-cut" style:top="{lines.length * LINE_HEIGHT}px">
          This file is longer than the viewer shows. Open it in your editor to
          see the rest.
        </div>
      {/if}
    </div>
  {/if}
</div>
<div class="source-bar">
  <span>Read-only</span>
  <span class="grow"></span>
  <button
    class="btn small"
    onclick={() =>
      api.openExternal(relPath, line ?? undefined).catch((e) => app.fail(e))}
    >Open in external editor</button
  >
  <button
    class="btn small"
    onclick={() => api.reveal(relPath).catch((e) => app.fail(e))}
    >Reveal in file manager</button
  >
</div>
