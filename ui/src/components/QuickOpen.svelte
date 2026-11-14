<script lang="ts">
  import { api, type FileHit } from '$lib/ipc';
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  let query = $state('');
  let hits = $state<FileHit[]>([]);
  let cursor = $state(0);
  // Counts searches so that a slow answer to an old query cannot replace a newer one.
  let latest = 0;

  $effect(() => {
    const text = query;
    const mine = ++latest;
    api.filesSearch(text, 40).then((found) => {
      if (mine !== latest) return;
      hits = found;
      cursor = 0;
    }).catch(() => {});
  });

  function choose(hit: FileHit | undefined) {
    if (!hit) return;
    app.dialog = null;
    app.selectFile(hit.relPath);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); cursor = Math.min(hits.length - 1, cursor + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); cursor = Math.max(0, cursor - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(hits[cursor]); }
  }

  const focus = (el: HTMLInputElement) => { el.focus(); };
</script>

<div class="scrim top" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) app.dialog = null; }}>
  <div class="dialog quick" role="dialog" aria-label="Open file">
    <input class="input" placeholder="Go to file…" bind:value={query} onkeydown={onKey} use:focus spellcheck="false" autocomplete="off" />
    <div class="quick-list" role="listbox">
      {#each hits as hit, i (hit.relPath)}
        <button class="quick-row" class:on={i === cursor} role="option" aria-selected={i === cursor} onclick={() => choose(hit)} onmousemove={() => (cursor = i)}>
          <Icon name="file" /><span class="name">{hit.name}</span><span class="where">{hit.relPath}</span>
        </button>
      {:else}
        <div class="quick-none">{query.trim() ? 'No file matches.' : 'Type part of a file name.'}</div>
      {/each}
    </div>
  </div>
</div>
