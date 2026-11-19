<script lang="ts">
  import { PIPELINE_PREFIX } from '$lib/artifacts';
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
  // A tab is closed with its ✕ button, with a click of the middle mouse
  // button, or from its context menu. Closing the tab that is on screen shows
  // the tab next to it.
  //
  // When the tabs are wider than the row, the row scrolls sideways. The mouse
  // wheel scrolls it, and the tab on screen is scrolled into view when it
  // changes.
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

  let strip: HTMLDivElement | undefined = $state();
  $effect(() => {
    void [app.selected, app.openFiles.length];
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
    if (!path.startsWith(PIPELINE_PREFIX))
      items.push(
        'separator',
        { label: 'Copy path', action: () => app.copyPath(path, true) },
        { label: 'Copy relative path', action: () => app.copyPath(path) },
      );
    return items;
  }
</script>

<div
  class="file-tabs"
  role="tablist"
  aria-label="Open files"
  bind:this={strip}
  onwheel={(event) => {
    if (strip && event.deltaY && !event.deltaX)
      strip.scrollLeft += event.deltaY;
  }}
>
  {#each app.openFiles as file, i (file.path)}
    {@const label = labels[i]}
    {@const on = file.path === app.selected}
    <div
      class="file-tab"
      class:on
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
        app.closeOpenFile(file.path);
      }}
      onkeydown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        app.showOpenFile(file.path);
      }}
      oncontextmenu={(event) => app.openMenu(event, menuFor(file.path))}
    >
      <Icon name={iconOf(file.path)} size={13} />
      <span class="name">{label.name}</span>
      {#if label.where}<span class="where">{label.where}</span>{/if}
      {#if busy.has(file.path)}<span
          class="busy"
          title="A job is running for this file"
        ></span>{/if}
      <button
        class="file-tab-close"
        aria-label="Close {label.name}"
        title="Close"
        onclick={(event) => {
          event.stopPropagation();
          app.closeOpenFile(file.path);
        }}><Icon name="close" size={10} /></button
      >
    </div>
  {/each}
</div>
