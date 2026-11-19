<script lang="ts">
  import { api, type FileHit, type SymbolHit } from '$lib/ipc';
  import { kindWord } from '$lib/nav';
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // The dialog that goes somewhere by name. What the user types is searched
  // for as they type.
  //   - Plain text finds files whose path contains its letters in order.
  //     Choosing one selects the file.
  //   - Text that starts with "#" finds definitions whose name contains what
  //     follows the "#". Choosing one shows it in the source view.
  // The dialog starts with the text `app.quickOpenStart`, which is "#" when
  // it was opened to find a definition.
  type Hit =
    { kind: 'file'; file: FileHit } | { kind: 'symbol'; symbol: SymbolHit };

  let query = $state(app.quickOpenStart);
  app.quickOpenStart = '';
  let hits = $state<Hit[]>([]);
  let cursor = $state(0);
  // Counts searches so that a slow answer to an old query cannot replace a
  // newer one.
  let latest = 0;

  const forSymbols = $derived(query.startsWith('#'));

  $effect(() => {
    const text = query;
    const mine = ++latest;
    const search: Promise<Hit[]> = text.startsWith('#')
      ? api
          .navSymbols(text.slice(1), 40)
          .then((found) =>
            found.map((symbol) => ({ kind: 'symbol', symbol }) as const),
          )
      : api
          .filesSearch(text, 40)
          .then((found) =>
            found.map((file) => ({ kind: 'file', file }) as const),
          );
    search
      .then((found) => {
        if (mine !== latest) return;
        hits = found;
        cursor = 0;
      })
      .catch(() => {});
  });

  function choose(hit: Hit | undefined) {
    if (!hit) return;
    app.dialog = null;
    if (hit.kind === 'file') app.selectFile(hit.file.relPath);
    else app.openSpan(hit.symbol);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      cursor = Math.min(hits.length - 1, cursor + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      cursor = Math.max(0, cursor - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(hits[cursor]);
    }
  }

  // Puts the caret at the end of the text the dialog starts with.
  const focus = (el: HTMLInputElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
</script>

<div
  class="scrim top"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) app.dialog = null;
  }}
>
  <div class="dialog quick" role="dialog" aria-label="Go to a file or a name">
    <input
      class="input"
      placeholder="Go to file…   Start with # to go to a definition by name"
      bind:value={query}
      onkeydown={onKey}
      use:focus
      spellcheck="false"
      autocomplete="off"
    />
    <div class="quick-list" role="listbox">
      {#each hits as hit, i (hit.kind === 'file' ? hit.file.relPath : `${hit.symbol.path}:${hit.symbol.line}:${hit.symbol.column}`)}
        <button
          class="quick-row"
          class:on={i === cursor}
          role="option"
          aria-selected={i === cursor}
          onclick={() => choose(hit)}
          onmousemove={() => (cursor = i)}
        >
          {#if hit.kind === 'file'}
            <Icon name="file" /><span class="name">{hit.file.name}</span><span
              class="where">{hit.file.relPath}</span
            >
          {:else}
            <Icon name="target" /><span class="name">{hit.symbol.name}</span
            ><span class="where"
              >{kindWord(hit.symbol.kind)}{hit.symbol.container
                ? ` of ${hit.symbol.container}`
                : ''} · {hit.symbol.path}:{hit.symbol.line}</span
            >
          {/if}
        </button>
      {:else}
        <div class="quick-none">
          {#if forSymbols}
            {query.slice(1).trim()
              ? 'No definition has a name like that.'
              : 'Type part of the name of a function, a type or a variable.'}
          {:else}
            {query.trim() ? 'No file matches.' : 'Type part of a file name.'}
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
