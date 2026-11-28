<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { PIPELINE_PREFIX } from '$lib/artifacts';
  import { api } from '$lib/ipc';
  import { app, type MenuItem } from '$lib/state/app.svelte';
  import { labelsOf } from '$lib/tabs';
  import Icon from './Icon.svelte';

  // The row of file tabs above the toolbar. `app.openFiles` holds one tab for
  // every file, folder and pipeline the user has selected and not closed.
  //
  // A click on a tab shows what it stands for, in the view it was last looked
  // at in. The tab of what is on screen is drawn with the editor's background
  // and an amber line along its top.
  //
  // A tab is closed with its ✕ button, which is at the left end of the tab,
  // with a click of the middle mouse button, or from its context menu.
  // Closing the tab that is on screen shows the tab next to it.
  //
  // The context menu of the tab of a file or a folder can also copy its path
  // and show it in the file manager. The tab of a file can open the file in
  // the external editor that is set in Settings. For the file on screen the
  // editor is given the line the source view was last sent to.
  //
  // Every tab has the same width. The tabs share the width of the row, and
  // the stylesheet gives the width of a tab a lower and an upper limit. When
  // the tabs are at the lower limit and still wider than the row, the row
  // scrolls sideways. The mouse wheel scrolls it, and the tab on screen is
  // scrolled into view when it changes.
  //
  // Closing several tabs without moving the pointer. A tab that is closed
  // with the pointer leaves the widths of the other tabs as they are, in
  // `kept`. The tab to the right of the closed tab moves to where the closed
  // tab was, so its ✕ button is under the pointer and the next click closes
  // it. The tabs share the width of the row again when the pointer leaves the
  // row.
  //
  // The tabs to the right of a tab that was closed move to their new place
  // in `MOVE_MS` milliseconds. A tab that is opened takes its place at once,
  // and so do the tabs to its right.
  //
  // A tab has a small amber dot while a job is running for its file.
  const titles = $derived(
    Object.fromEntries(
      app.artifacts
        .filter((a) => a.kind === 'pipeline')
        .map((a) => [a.id, a.title]),
    ),
  );
  const labels = $derived(
    labelsOf(
      app.openFiles.map((file) => file.path),
      titles,
    ),
  );
  // The paths that a running job is about.
  const busy = $derived(
    new Set(
      app.jobs
        .filter((job) => job.status === 'running')
        .map((job) => job.subject),
    ),
  );

  // How long a tab takes to move to a new place or to change its width, in
  // milliseconds.
  const MOVE_MS = 120;

  // True when the user has asked the operating system for less motion. The
  // tabs then change place and width at once.
  const lessMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let strip: HTMLDivElement | undefined = $state();

  // Set while the widths of the tabs are kept as they are, and null
  // otherwise. `width` is the width of every tab in pixels. `tabs` is the
  // number of tabs there were when the widths were first kept. The row has an
  // empty space of `width` pixels at its end for every tab closed since then,
  // so the row does not scroll when a tab is closed.
  let kept: { width: number; tabs: number } | null = $state(null);

  // Closes the tab `tab` of `path` for a click of the pointer. The widths of
  // the tabs are kept from now on if the pointer is over the row. The pointer
  // is not over the row when the ✕ button was pressed with the keyboard, and
  // the widths are not kept then, because `release` runs only when the
  // pointer leaves the row.
  function closeByPointer(path: string, tab: HTMLElement) {
    if (!kept && strip?.matches(':hover'))
      kept = {
        width: tab.getBoundingClientRect().width,
        tabs: app.openFiles.length,
      };
    void app.closeOpenFile(path);
  }

  // Stops keeping the widths of the tabs. The tabs share the width of the row
  // again, and each tab changes from the kept width to its new width in
  // `MOVE_MS` milliseconds.
  async function release() {
    if (!kept) return;
    const from = kept.width;
    kept = null;
    await tick();
    if (lessMotion()) return;
    for (const tab of strip?.querySelectorAll('.file-tab') ?? []) {
      const to = tab.getBoundingClientRect().width;
      if (Math.abs(to - from) < 0.5) continue;
      tab.animate(
        [
          { flex: 'none', width: `${from}px` },
          { flex: 'none', width: `${to}px` },
        ],
        { duration: MOVE_MS, easing: 'ease-out' },
      );
    }
  }

  // A new tab needs room in the row, so the widths are no longer kept when a
  // tab is opened.
  let tabCount = 0;
  $effect(() => {
    if (app.openFiles.length > tabCount) kept = null;
    tabCount = app.openFiles.length;
  });

  // Moves a tab from the place it had before the list of tabs changed, `from`,
  // to the place it has now, `to`. Svelte calls this for every tab whose
  // position in the list changed. Only a tab that is now further left is
  // moved over time, which is a tab to the right of a closed tab. A tab that
  // is now further right made room for a new tab and is there at once.
  function slide(_tab: Element, { from, to }: { from: DOMRect; to: DOMRect }) {
    const moved = from.left - to.left;
    return {
      duration: moved > 0 && !lessMotion() ? MOVE_MS : 0,
      easing: cubicOut,
      css: (_done: number, left: number) =>
        `transform: translateX(${left * moved}px)`,
    };
  }

  // Scrolls the tab on screen into view. It does not scroll while the widths
  // are kept, because then the next ✕ button would no longer be under the
  // pointer.
  $effect(() => {
    void [app.selected, app.openFiles.length];
    if (untrack(() => kept)) return;
    strip
      ?.querySelector('.file-tab.on')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  // What a tab's path is, for its icon.
  const iconOf = (path: string) =>
    path.startsWith(PIPELINE_PREFIX)
      ? 'viz'
      : path.endsWith('/')
        ? 'dir'
        : 'file';

  function menuFor(path: string): MenuItem[] {
    const items: MenuItem[] = [
      { label: 'Close', action: () => app.closeOpenFile(path) },
      {
        label: 'Close the other tabs',
        disabled: app.openFiles.length < 2,
        action: () => app.closeOtherFiles(path),
      },
    ];
    if (path.startsWith(PIPELINE_PREFIX)) return items;
    items.push('separator');
    if (!path.endsWith('/'))
      items.push({
        label: 'Open in external editor',
        action: () =>
          api
            .openExternal(
              path,
              path === app.selected ? (app.sourceLine ?? undefined) : undefined,
            )
            .catch((error) => app.fail(error)),
      });
    items.push(
      {
        label: 'Reveal in file manager',
        action: () => api.reveal(path).catch((error) => app.fail(error)),
      },
      'separator',
      { label: 'Copy path', action: () => app.copyPath(path, true) },
      { label: 'Copy relative path', action: () => app.copyPath(path) },
    );
    return items;
  }
</script>

<!-- The row does not take keyboard focus. Each tab in it does. The row
     listens only for the pointer leaving it. -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="file-tabs"
  role="tablist"
  aria-label="Open files"
  bind:this={strip}
  onwheel={(event) => {
    if (strip && event.deltaY && !event.deltaX)
      strip.scrollLeft += event.deltaY;
  }}
  onpointerleave={release}
>
  {#each app.openFiles as file, i (file.path)}
    {@const label = labels[i]}
    {@const on = file.path === app.selected}
    <div
      class="file-tab"
      class:on
      class:kept
      style:width={kept ? `${kept.width}px` : null}
      animate:slide
      role="tab"
      tabindex="0"
      aria-selected={on}
      title={file.path.startsWith(PIPELINE_PREFIX)
        ? `Pipeline · ${label.name}`
        : file.path}
      onclick={() => app.showOpenFile(file.path)}
      onauxclick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        closeByPointer(file.path, event.currentTarget);
      }}
      onkeydown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        app.showOpenFile(file.path);
      }}
      oncontextmenu={(event) => app.openMenu(event, menuFor(file.path))}
    >
      <button
        class="file-tab-close"
        aria-label="Close {label.name}"
        title="Close"
        onclick={(event) => {
          event.stopPropagation();
          const tab = event.currentTarget.parentElement;
          if (tab) closeByPointer(file.path, tab);
        }}><Icon name="close" size={10} /></button
      >
      <Icon name={iconOf(file.path)} size={13} />
      <span class="name">{label.name}</span>
      {#if label.where}<span class="where">{label.where}</span>{/if}
      {#if busy.has(file.path)}<span
          class="busy"
          title="A job is running for this file"
        ></span>{/if}
    </div>
  {/each}
  {#if kept && kept.tabs > app.openFiles.length}
    <div
      class="file-tabs-gap"
      style:width="{(kept.tabs - app.openFiles.length) * kept.width}px"
    ></div>
  {/if}
</div>
