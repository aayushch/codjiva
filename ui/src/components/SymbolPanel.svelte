<script lang="ts">
  import type { NavSpan, NavTarget } from '$lib/ipc';
  import {
    byFile,
    groupWord,
    kindWord,
    previewParts,
    roleTag,
    splitPath,
  } from '$lib/nav';
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // The section of the panel beside the source view that says where a name
  // is defined and where it is used. SourcePanel.svelte holds it, with the
  // section for the discussion and the visuals of the selected code.
  //
  // While no name is selected in the source view (`app.symbol` is null), the
  // panel says what it lists and how to select a name.
  //
  // While a name is selected, the panel describes that name. From top to
  // bottom it shows the name, one sentence on how exact the
  // lists below are, the places that define the name, the places that define
  // its type when the code writes one, and the places that use the name,
  // grouped by file. A click on a place shows it in the source view. The
  // name stays selected while the user goes through the places, also into
  // other files.
  //
  // How exact the lists are depends on `lookup.basis`.
  //   - `scope`: the name is a parameter or a local variable. Both lists are
  //     exact.
  //   - `name`: the lists hold everything in the workspace with this name.
  //     The core does not know the types of every expression, so it cannot
  //     always tell two things of the same name apart.
  //   - `text`: the file's language is not parsed, and the name was read as
  //     a word of text.
  //
  // The definitions come in two parts. The first `lookup.likely` of them are
  // the ones the code around the name points to, for example the field of a
  // base class of the class the code is in. They are always shown. The rest
  // only have the same name, and are shown when the user opens the line
  // "Others with this name".
  //
  // The references of one file can be closed, so that only the heading of
  // the file is left. A click on the heading closes them and opens them
  // again. The button beside the word "References" does that for every file
  // at once.
  //
  // The references are searched for when this panel appears and not when
  // the name is selected, so that nothing is searched while the panel is
  // closed.
  const symbol = $derived(app.symbol);
  const lookup = $derived(symbol?.lookup);
  const files = $derived(byFile(symbol?.references ?? []));
  const likely = $derived(lookup?.definitions.slice(0, lookup.likely) ?? []);
  const others = $derived(lookup?.definitions.slice(lookup.likely) ?? []);

  $effect(() => {
    if (app.symbol?.search === 'idle') app.searchReferences();
  });

  // Which files have their references closed.
  //   - `allClosed` is what the button beside the word "References" last
  //     asked for: true after it closed every file, false after it opened
  //     every file. It is false when a name is selected.
  //   - `closedByFile` holds a file's path once the user has clicked that
  //     file's heading since then. The value is true if the click closed
  //     the file and false if it opened it.
  // A file that is not in `closedByFile` follows `allClosed`. A search adds
  // files to the list while it runs, and such a file is closed if the user
  // has already closed every file.
  let allClosed = $state(false);
  let closedByFile = $state<Record<string, boolean>>({});
  const isClosed = (path: string) => closedByFile[path] ?? allClosed;
  const everyClosed = $derived(
    files.length > 0 && files.every((file) => isClosed(file.path)),
  );

  function toggleFile(path: string) {
    closedByFile[path] = !isClosed(path);
  }

  // Opens every file if all of them are closed. Otherwise closes every file.
  function toggleAll() {
    allClosed = !everyClosed;
    closedByFile = {};
  }

  // Selecting another name opens every file again.
  $effect(() => {
    void app.symbol;
    allClosed = false;
    closedByFile = {};
  });

  const BASIS = {
    scope:
      'A parameter or a local variable. It exists only inside the function it is in, so its definition and its uses are found exactly.',
    name: 'Found by name. The references are every use of this name, also where it means something else.',
    text: 'Read as a word of text, because this code is not parsed. Other things with this name can be listed too.',
  };

  // The sentence above the definitions when more than one is listed as
  // likely. It is empty when there is one, and when there is none.
  const doubt = $derived.by(() => {
    if (!lookup || lookup.certain || likely.length < 2) return '';
    return others.length
      ? 'The code around the name fits these equally well.'
      : 'Nothing around the name says which of these is meant. The nearest is first.';
  });

  // What is said about a definition after its file and line: what kind of
  // thing it is, what it belongs to, and how close it is to the clicked
  // name. For example "· method of Handler · in this file".
  const describe = (target: NavTarget) =>
    `· ${target.declaration ? 'prototype of a ' : ''}${kindWord(target.kind)}` +
    `${target.container ? ` of ${target.container}` : ''} · ` +
    groupWord(target.group);

  // True for the place the source view is at, which is drawn as chosen.
  const isShown = (place: NavSpan & { path: string }) =>
    app.selected === place.path &&
    app.sourceLine === place.line &&
    app.sourceSpan?.column === place.column;
</script>

{#snippet code(text: string, place: NavSpan)}
  {@const parts = previewParts(text, place.column, place.endColumn)}
  <span class="nav-code"
    >{parts.before}{#if parts.name}<mark>{parts.name}</mark
      >{/if}{parts.after}</span
  >
{/snippet}

{#snippet place(target: NavTarget)}
  <button
    class="nav-row"
    class:on={isShown(target)}
    title="{target.path}:{target.line}"
    onclick={() => app.openSpan(target)}
  >
    <span class="nav-where"
      >{splitPath(target.path).name}:{target.line}
      <span class="muted">{describe(target)}</span></span
    >
    {@render code(target.text, target)}
  </button>
{/snippet}

{#if symbol && lookup}
  <div class="symbol-panel">
    <div class="symbol-head">
      <div class="kicker">Selected name</div>
      <button
        class="tb-btn tip-end"
        data-tip="Select nothing (Esc)"
        aria-label="Select nothing"
        onclick={() => app.clearSymbol()}><Icon name="close" /></button
      >
    </div>
    <h3>{lookup.name}</h3>
    <p class="symbol-basis">{BASIS[lookup.basis]}</p>
    {#if lookup.indexing}
      <p class="symbol-basis">
        The folder is still being read for the first time, so this took a
        search.
      </p>
    {/if}

    <div class="kicker">
      {likely.length < 2 ? 'Definition' : `Definitions · ${likely.length}`}
    </div>
    {#if doubt}
      <p class="symbol-basis">{doubt}</p>
    {/if}
    {#each likely as target (`${target.path}:${target.line}:${target.column}`)}
      {@render place(target)}
    {:else}
      <p class="symbol-basis">
        No definition was found in this folder. The name may come from a library
        outside it.
      </p>
    {/each}
    {#if others.length}
      {#key lookup}
        <details class="nav-others">
          <summary>Others with this name · {others.length}</summary>
          {#each others as target (`${target.path}:${target.line}:${target.column}`)}
            {@render place(target)}
          {/each}
        </details>
      {/key}
    {/if}

    {#if lookup.typeName}
      <div class="kicker">Type · {lookup.typeName}</div>
      {#each lookup.types as target (`${target.path}:${target.line}:${target.column}`)}
        {@render place(target)}
      {/each}
    {/if}

    <div class="nav-refs-head">
      <div class="kicker">
        References{symbol.references.length
          ? ` · ${symbol.references.length}`
          : ''}
      </div>
      {#if files.length}
        {@const label = everyClosed ? 'Expand all files' : 'Collapse all files'}
        <button
          class="tb-btn tip-end"
          data-tip={label}
          aria-label={label}
          onclick={toggleAll}
          ><Icon name={everyClosed ? 'expand' : 'collapse'} /></button
        >
      {/if}
    </div>
    {#if symbol.search === 'running'}
      <p class="symbol-basis">Searching…</p>
    {:else if symbol.outcome?.truncated}
      <p class="symbol-basis">
        There are more. The search stopped at the first {symbol.outcome.total}.
      </p>
    {:else if symbol.search === 'done' && !symbol.references.length}
      <p class="symbol-basis">No use was found.</p>
    {/if}
    {#each files as file (file.path)}
      {@const where = splitPath(file.path)}
      {@const closed = isClosed(file.path)}
      <button
        class="nav-file"
        title={file.path}
        aria-expanded={!closed}
        onclick={() => toggleFile(file.path)}
      >
        <span class="chev">{closed ? '▸' : '▾'}</span>
        <span class="name">{where.name}</span>
        <span class="muted">{where.folder}</span>
        <span class="grow"></span>
        <span class="muted">{file.references.length}</span>
      </button>
      {#if !closed}
        {#each file.references as reference (`${reference.line}:${reference.column}`)}
          {@const tag = roleTag(reference.role)}
          <button
            class="nav-row ref-row"
            class:on={isShown(reference)}
            onclick={() => app.openSpan(reference)}
          >
            <span class="nav-num">{reference.line}</span>
            {@render code(reference.text, reference)}
            {#if tag}<span class="nav-tag">{tag}</span>{/if}
          </button>
        {/each}
      {/if}
    {/each}
  </div>
{:else}
  <div class="symbol-empty">
    <div class="kicker">Definitions and references</div>
    <p class="muted">
      Click a symbol in the code to see where it is defined and where it is
      used.
    </p>
  </div>
{/if}
