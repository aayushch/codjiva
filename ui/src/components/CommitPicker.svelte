<script lang="ts">
  import {
    changeDetail,
    changeKey,
    changeTitle,
    compareTitle,
    HISTORY_LIMIT,
  } from '$lib/diff';
  import { diffs } from '$lib/state/diffs.svelte';
  import Icon from './Icon.svelte';

  // The controls of the toolbar that choose what the diff view shows for a
  // file (see DiffView.svelte). The toolbar shows them while the diff view
  // is on screen.
  //
  // From left to right:
  //   - A button that names what is on screen and opens a list of all
  //     changes of the file.
  //   - "Older" and "Newer", which show the change before and the change
  //     after the one on screen, without opening the list.
  //
  // The button has a fixed width, so the buttons beside it stay where they
  // are when another change, with a longer or a shorter name, is shown.
  //
  // The list has the changes of the file, newest first: the changes that
  // are not committed, when there are any, and then the commits. Each entry
  // has the first line of the commit message and, below it, the start of
  // the hash, the author and the age.
  //
  // One change. A click on an entry shows that change, compared with the
  // version before it. The button then has the name of that change.
  //
  // Two versions. Each entry also has a small command at its right end,
  // which is used twice to compare any two versions of the file.
  //   - At first the command is "Select to compare". It is visible on the
  //     entry under the pointer and on the entry that has focus. A click
  //     selects that entry, and the list stays open.
  //   - While an entry is selected, the command of every other entry is
  //     "Compare with selected" and is always visible. A click on it shows
  //     the lines that differ between the file as the selected entry left
  //     it and the file as the clicked entry left it.
  //   - The command of the selected entry is "Cancel", which removes the
  //     selection.
  // The older of the two entries is always the old version of the
  // comparison, whichever was selected first. The button then has the short
  // names of both versions, such as "c200000 → c300000". "Older" and
  // "Newer" then replace only the newer version.
  //
  // Closing. The list closes when the user chooses an entry, compares two
  // entries, presses Escape, presses the pointer outside the list, or
  // switches to another window. A selection is lost when the list closes.
  //
  // Keys. The up and down arrow keys move through the entries. The right
  // arrow key moves focus from an entry to its command, and the left arrow
  // key moves it back. Enter does what a click on the control with focus
  // does. When the list opens, the entry of the change on screen has focus
  // and is scrolled into view.
  let open = $state(false);
  let box: HTMLDivElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  // The `changeKey` of the entry that is selected to be compared, or null.
  let picked = $state<string | null>(null);

  const change = $derived(diffs.change);
  const base = $derived(diffs.baseChange);
  // The position in the list of the selected entry, or -1.
  const pickedAt = $derived(
    picked == null
      ? -1
      : diffs.changes.findIndex((entry) => changeKey(entry) === picked),
  );
  const name = $derived(
    !change
      ? 'No changes'
      : base
        ? compareTitle(base, change)
        : changeTitle(change),
  );
  const now = () => Math.floor(Date.now() / 1000);

  const entries = () =>
    Array.from(list?.querySelectorAll<HTMLButtonElement>('.commit-row') ?? []);

  $effect(() => {
    if (!open || !list) return;
    const current = entries()[diffs.index];
    current?.scrollIntoView({ block: 'center' });
    current?.focus();
  });

  function close() {
    open = false;
    picked = null;
  }

  function choose(index: number) {
    close();
    diffs.pick(index);
  }

  // Handles a click on the command of the entry at position `index`.
  function onCommand(index: number) {
    if (pickedAt < 0) picked = changeKey(diffs.changes[index]);
    else if (index === pickedAt) picked = null;
    else {
      const other = pickedAt;
      close();
      diffs.compare(other, index);
    }
  }
  // The words of the command of the entry at position `index`.
  const commandOf = (index: number) =>
    pickedAt < 0
      ? 'Select to compare'
      : index === pickedAt
        ? 'Cancel'
        : 'Compare with selected';

  function onKey(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const across = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    if (step == null && !across) return;
    event.preventDefault();
    // Focus can be on an entry or on the command beside it. Both are inside
    // the same `.commit-entry` element.
    const all = entries();
    const at = all.findIndex((entry) =>
      entry.parentElement?.contains(document.activeElement),
    );
    if (step != null)
      all[Math.max(0, Math.min(all.length - 1, at + step))]?.focus();
    else if (event.key === 'ArrowLeft') all[at]?.focus();
    else
      all[at]?.parentElement
        ?.querySelector<HTMLButtonElement>('.commit-command')
        ?.focus();
  }

  // A press of the pointer outside the picker closes the list. The listener
  // is on the window in the capture phase, so it also sees a press that the
  // element under the pointer handles itself.
  function onPress(event: PointerEvent) {
    if (open && box && !box.contains(event.target as Node)) close();
  }
</script>

<svelte:window onpointerdowncapture={onPress} onblur={close} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="commit-picker" bind:this={box} onkeydown={onKey}>
  <button
    class="commit-button"
    aria-expanded={open}
    aria-label="The change that is shown"
    disabled={!diffs.changes.length}
    title={change ? name : undefined}
    onclick={() => (open ? close() : (open = true))}
    ><span class="commit-name">{name}</span><span class="chev">▾</span></button
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
      class:selecting={pickedAt >= 0}
      role="group"
      aria-label="Changes of this file"
      bind:this={list}
    >
      {#each diffs.changes as entry, at (changeKey(entry))}
        <div class="commit-entry" class:picked={at === pickedAt}>
          <button
            class="commit-row"
            class:on={at === diffs.index}
            class:base={at === diffs.baseIndex}
            aria-current={at === diffs.index}
            onclick={() => choose(at)}
            ><span class="commit-title">{changeTitle(entry)}</span><span
              class="commit-detail">{changeDetail(entry, now())}</span
            ></button
          >
          {#if diffs.changes.length > 1}
            <button class="commit-command" onclick={() => onCommand(at)}
              >{commandOf(at)}</button
            >
          {/if}
        </div>
      {/each}
      {#if diffs.more}
        <div class="commit-more">
          Only the {HISTORY_LIMIT} newest commits are listed.
        </div>
      {/if}
    </div>
  {/if}
</div>
