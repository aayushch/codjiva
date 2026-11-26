<script lang="ts">
  import { sameScope, scopeTitle } from '$lib/discuss';
  import {
    app,
    SOURCE_SPLIT_MAX,
    SOURCE_SPLIT_MIN,
  } from '$lib/state/app.svelte';
  import { discuss } from '$lib/state/discuss.svelte';
  import Icon from './Icon.svelte';
  import ScopePanel from './ScopePanel.svelte';
  import Splitter from './Splitter.svelte';
  import SymbolPanel from './SymbolPanel.svelte';

  // The panel on the right of the source view. It takes the place the
  // inspector has beside a visual. It has two sections, one above the other.
  //   - "References" says where the name the user clicked is defined and
  //     used (SymbolPanel.svelte).
  //   - "Discussion" holds the discussion about the code the user selected
  //     and the visuals made of that code (ScopePanel.svelte).
  // The two are independent: a click on a name changes only the first, and
  // selecting code changes only the second.
  //
  // How the height is shared.
  //   - While both sections have something to show, the upper one has
  //     `app.sourceSplit` percent of the height. Dragging the line between
  //     them changes that share.
  //   - While one section has nothing to show and the other has, the empty
  //     one is only its heading and the other has the rest.
  //   - While neither has anything to show, both show their hint, split as
  //     in the first case.
  // A click on a heading closes its section to the heading alone, and
  // opens it again. `app.sourceSwapped` puts the discussion above the
  // references. The button in the discussion's heading swaps the two.
  let panel: HTMLElement | undefined = $state();

  const path = $derived(app.selected ?? '');
  const scopes = $derived(discuss.scopesIn(path));
  const openNow = $derived(
    app.scope
      ? scopes.find((one) => sameScope(one.scope, app.scope))?.now
      : undefined,
  );
  const hasRefs = $derived(!!app.symbol);
  const hasScope = $derived(!!app.scope || scopes.length > 0);
  // The sections the user closed by a click on their heading.
  let closed = $state({ refs: false, scope: false });
  const refsOpen = $derived(!closed.refs && (hasRefs || !hasScope));
  const scopeOpen = $derived(!closed.scope && (hasScope || !hasRefs));
  const order = $derived(
    app.sourceSwapped
      ? (['scope', 'refs'] as const)
      : (['refs', 'scope'] as const),
  );
  const isOpen = (section: 'refs' | 'scope') =>
    section === 'refs' ? refsOpen : scopeOpen;

  // Opening something in a section opens the section, even if the user had
  // closed it.
  $effect(() => {
    if (app.symbol) closed.refs = false;
  });
  $effect(() => {
    if (app.scope) closed.scope = false;
  });

  let splitAtDragStart = 0;
  // `moved` is how far down the pointer is from where the drag began.
  function dragSplit(moved: number) {
    const height = panel?.clientHeight ?? 0;
    if (!height) return;
    app.sourceSplit = Math.min(
      SOURCE_SPLIT_MAX,
      Math.max(SOURCE_SPLIT_MIN, splitAtDragStart + (moved / height) * 100),
    );
  }
</script>

<aside class="inspector source-panel" bind:this={panel}>
  {#each order as section, at (section)}
    {@const open = isOpen(section)}
    {#if at === 1 && refsOpen && scopeOpen}
      <div class="sp-split">
        <Splitter
          axis="y"
          label="Resize the two sections of the panel"
          onstart={() => (splitAtDragStart = app.sourceSplit)}
          ondrag={dragSplit}
        />
      </div>
    {/if}
    <section
      class="sp-section"
      class:open
      class:first={at === 0}
      style:flex={open
        ? at === 0 && refsOpen && scopeOpen
          ? `0 0 ${app.sourceSplit}%`
          : '1 1 0'
        : '0 0 auto'}
    >
      <div class="sp-head">
        <button
          class="sp-toggle"
          aria-expanded={open}
          onclick={() => (closed[section] = open)}
        >
          <span class="chev">{open ? '▾' : '▸'}</span>
          {#if section === 'refs'}
            References{#if app.symbol}<span class="sp-what"
                >{app.symbol.lookup.name}</span
              >{/if}
          {:else}
            Discussion{#if app.scope}<span class="sp-what"
                >{scopeTitle(app.scope, openNow)}</span
              >{/if}
          {/if}
        </button>
        {#if section === 'scope'}
          {#if app.scope && app.scopeArtifactId}
            {@const id = app.scopeArtifactId}
            <button
              class="tb-btn tip-end"
              data-tip="Show the visual in place of the code"
              aria-label="Maximise the visual"
              onclick={() => app.openSpotlight(id)}><Icon name="full" /></button
            >
          {/if}
          <button
            class="tb-btn tip-end"
            data-tip={app.sourceSwapped
              ? 'Move the discussion below the references'
              : 'Move the discussion above the references'}
            aria-label="Swap the two sections"
            onclick={() => (app.sourceSwapped = !app.sourceSwapped)}
            ><Icon name="swap" /></button
          >
          {#if app.scope}
            <button
              class="tb-btn tip-end"
              data-tip="Close this and list what the file has"
              aria-label="Close the discussion"
              onclick={() => app.closeScope()}><Icon name="close" /></button
            >
          {/if}
        {/if}
      </div>
      {#if open}
        <div class="sp-body" class:scope={section === 'scope'}>
          {#if section === 'refs'}<SymbolPanel />{:else}<ScopePanel />{/if}
        </div>
      {/if}
    </section>
  {/each}
</aside>
