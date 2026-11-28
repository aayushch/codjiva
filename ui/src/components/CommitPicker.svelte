<script lang="ts">
  import {
    changeDetail,
    changeKey,
    changeTitle,
    HISTORY_LIMIT,
  } from '$lib/diff';
  import { diffs } from '$lib/state/diffs.svelte';
  import Icon from './Icon.svelte';

  // The controls of the toolbar that choose which change of a file the diff
  // view shows (see DiffView.svelte). The toolbar shows them while the diff
  // view is on screen.
  //
  // From left to right:
  //   - A button with the name of the change on screen. It opens a list of
  //     all changes of the file, newest first: the changes that are not
  //     committed, when there are any, and then the commits. Each entry has
  //     the first line of the commit message and, below it, the start of
  //     the hash, the author and the age. Choosing an entry shows that
  //     change, compared with the version before it.
  //   - "Older" and "Newer", which show the change before and the change
  //     after the one on screen, without opening the list.
  //
  // The button has a fixed width, so the buttons beside it stay where they
  // are when another change, with a longer or a shorter name, is shown.
  //
  // The list. It closes when the user chooses an entry, presses Escape,
  // presses the pointer outside it, or switches to another window. The
  // arrow keys move through the entries and Enter chooses the one that has
  // focus. When the list opens, the entry of the change on screen has
  // focus and is scrolled into view.
  let open = $state(false);
  let box: HTMLDivElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();

  const change = $derived(diffs.change);
  const now = () => Math.floor(Date.now() / 1000);

  const entries = () =>
    Array.from(list?.querySelectorAll<HTMLButtonElement>('.commit-row') ?? []);

  $effect(() => {
    if (!open || !list) return;
    const current = entries()[diffs.index];
    current?.scrollIntoView({ block: 'center' });
    current?.focus();
  });

  function choose(index: number) {
    open = false;
    diffs.pick(index);
  }

  function onKey(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      open = false;
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const all = entries();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = at + (event.key === 'ArrowDown' ? 1 : -1);
    all[Math.max(0, Math.min(all.length - 1, next))]?.focus();
  }

  // A press of the pointer outside the picker closes the list. The listener
  // is on the window in the capture phase, so it also sees a press that the
  // element under the pointer handles itself.
  function onPress(event: PointerEvent) {
    if (open && box && !box.contains(event.target as Node)) open = false;
  }
</script>

<svelte:window onpointerdowncapture={onPress} onblur={() => (open = false)} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="commit-picker" bind:this={box} onkeydown={onKey}>
  <button
    class="commit-button"
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label="The change that is shown"
    disabled={!diffs.changes.length}
    title={change ? changeTitle(change) : undefined}
    onclick={() => (open = !open)}
    ><span class="commit-name"
      >{change ? changeTitle(change) : 'No changes'}</span
    ><span class="chev">▾</span></button
  >
  <button
    class="tb-btn tip-end"
    data-tip="Older change"
    aria-label="Older change"
    disabled={!diffs.hasOlder}
    onclick={() => diffs.older()}><Icon name="back" /></button
  >
  <button
    class="tb-btn tip-end"
    data-tip="Newer change"
    aria-label="Newer change"
    disabled={!diffs.hasNewer}
    onclick={() => diffs.newer()}><Icon name="forward" /></button
  >
  {#if open}
    <div
      class="commit-list"
      role="listbox"
      aria-label="Changes of this file"
      bind:this={list}
    >
      {#each diffs.changes as entry, at (changeKey(entry))}
        <button
          class="commit-row"
          class:on={at === diffs.index}
          role="option"
          aria-selected={at === diffs.index}
          onclick={() => choose(at)}
          ><span class="commit-title">{changeTitle(entry)}</span><span
            class="commit-detail">{changeDetail(entry, now())}</span
          ></button
        >
      {/each}
      {#if diffs.more}
        <div class="commit-more">
          Only the {HISTORY_LIMIT} newest commits are listed.
        </div>
      {/if}
    </div>
  {/if}
</div>
