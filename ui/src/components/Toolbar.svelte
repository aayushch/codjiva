<script lang="ts">
  import { showsFilm } from '$lib/artifacts';
  import { targetOfArtifact } from '$lib/jobs';
  import { api } from '$lib/ipc';
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // The bar above the editor area and the inspector. From left to right it
  // holds the Back and Forward buttons, the path of what is selected, the
  // controls of the artifact on screen, and the Visual, Film and Source tabs.
  // The tabs are last so that they stay at the right end of the bar, in the
  // same place whether or not the selected file has an artifact to show
  // controls for.

  // The parts of the selected path. A folder's path ends with a slash, which is
  // shown after its last part.
  const parts = $derived(
    app.selected ? app.selected.replace(/\/$/, '').split('/') : [],
  );
  const artifact = $derived(app.currentArtifact);
  // The keys for Back and Forward, as the buttons' labels show them. App.svelte
  // handles the keys.
  const mac = $derived(app.info?.platform === 'macos');
  const shown = $derived(
    artifact?.versions.find((v) => v.version === app.shownVersion) ?? null,
  );
  const isPipeline = $derived(artifact?.kind === 'pipeline');
  // A visual of a single file can be turned into a film. A folder, a film and a
  // pipeline cannot.
  const canAnimate = $derived(
    !!artifact && !isPipeline && !showsFilm(artifact) && !app.selectedIsFolder,
  );

  // True while a job is making the film of the file on screen. The button that
  // makes a film of the file is disabled meanwhile.
  const filmBusy = $derived(
    !!artifact &&
      app.isBusy(targetOfArtifact({ kind: 'film', subject: artifact.subject })),
  );

  // Describes when a version was made, relative to today: "today 14:05",
  // "yesterday", "3 Nov".
  function whenMade(iso: string): string {
    const made = new Date(iso);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const days = Math.floor(
      (startOfToday.getTime() - new Date(made).setHours(0, 0, 0, 0)) /
        86_400_000,
    );
    if (days <= 0)
      return (
        'today ' +
        made.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    if (days === 1) return 'yesterday';
    return made.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
  }
</script>

<!-- The controls of the artifact on screen: its badges, the version picker and
     the actions on the version. `staleWhy` is the text that explains the
     "stale" badge. -->
{#snippet controls(staleWhy: string)}
  {#if artifact && app.shownVersion != null}
    {@const version = app.shownVersion}
    {#if artifact.stale}<span class="badge-stale" title={staleWhy}>stale</span
      >{/if}
    {#if shown && !shown.passed}<span
        class="badge-issues"
        title="Problems the checks found and the agent could not fix"
        >{shown.errors} issue{shown.errors === 1 ? '' : 's'}</span
      >{/if}
    <select
      class="select"
      aria-label="Version"
      value={String(version)}
      onchange={(e) => app.pickVersion(Number(e.currentTarget.value))}
    >
      {#each [...artifact.versions].reverse() as one (one.version)}
        <option value={String(one.version)}
          >v{one.version} · {whenMade(one.createdAt)}{one.version ===
          artifact.currentVersion
            ? ''
            : ' (earlier)'}</option
        >
      {/each}
    </select>
    <span class="actions">
      <button
        class="tb-btn"
        data-tip={isPipeline ? 'Compose again…' : 'Regenerate…'}
        aria-label={isPipeline ? 'Compose again…' : 'Regenerate…'}
        disabled={app.artifactBusy}
        onclick={() => app.askRegenerate()}
        ><Icon name="again" size={16} /></button
      >
      {#if canAnimate}<button
          class="tb-btn"
          data-tip="Make a film of this file…"
          aria-label="Animate…"
          disabled={filmBusy}
          onclick={() => app.askAnimate()}
          ><Icon name="film" size={16} /></button
        >{/if}
      <button
        class="tb-btn"
        data-tip="Export as an HTML file"
        aria-label="Export HTML"
        onclick={() => app.exportArtifact()}
        ><Icon name="export" size={16} /></button
      >
      <button
        class="tb-btn"
        data-tip="Open in the browser"
        aria-label="Open in browser"
        onclick={() =>
          api
            .artifactOpenInBrowser(artifact.id, version)
            .catch((e) => app.fail(e))}
        ><Icon name="external" size={16} /></button
      >
      <button
        class="tb-btn"
        data-tip="Show the files in {app.info?.dotDir ?? '.codjiva'}"
        aria-label="Reveal in {app.info?.dotDir ?? '.codjiva'}"
        onclick={() =>
          api.artifactReveal(artifact.id, version).catch((e) => app.fail(e))}
        ><Icon name="reveal" size={16} /></button
      >
    </span>
  {/if}
{/snippet}

<div class="toolbar">
  {#if !app.example}
    <span class="history">
      <button
        class="tb-btn tip-start"
        data-tip="Back ({mac ? '⌘[' : 'Alt+←'})"
        aria-label="Back"
        disabled={!app.canGoBack}
        onclick={() => app.goBack()}><Icon name="back" size={16} /></button
      >
      <button
        class="tb-btn tip-start"
        data-tip="Forward ({mac ? '⌘]' : 'Alt+→'})"
        aria-label="Forward"
        disabled={!app.canGoForward}
        onclick={() => app.goForward()}
        ><Icon name="forward" size={16} /></button
      >
    </span>
  {/if}
  {#if app.example}
    <span class="crumb"
      >Example / <b
        >{app.example === 'film'
          ? 'How an order moves through the orders Handler'
          : 'Handler.Submit, a still visual'}</b
      ></span
    >
    <span class="spacer"></span>
    <span class="tabs">
      <button
        class="tab"
        class:on={app.example === 'film'}
        onclick={() => (app.example = 'film')}>Film</button
      >
      <button
        class="tab"
        class:on={app.example === 'visual'}
        onclick={() => (app.example = 'visual')}>Visual</button
      >
    </span>
    <button class="btn small" onclick={() => (app.example = null)}
      >Close example</button
    >
  {:else if app.selectedPipelineId}
    <span class="crumb">Pipeline / <b>{artifact?.title ?? ''}</b></span>
    <span class="spacer"></span>
    {@render controls(
      'A source file of one of its parts changed after this version was made',
    )}
  {:else if app.selected}
    <span class="crumb"
      >{#each parts.slice(0, -1) as part}{part}{' / '}{/each}<b
        >{parts[parts.length - 1]}{app.selectedIsFolder ? '/' : ''}</b
      ></span
    >
    <span class="spacer"></span>
    {#if artifact && app.tab !== 'source'}
      {@render controls('A source file changed after this version was made')}
      <span class="divider"></span>
    {/if}
    <span class="tabs">
      <button
        class="tab"
        class:on={app.tab === 'visual'}
        onclick={() => app.setTab('visual')}
        >Visual{#if app.visualArtifact}<span
            class="has"
            title="This has a visual"
          ></span>{/if}</button
      >
      {#if !app.selectedIsFolder}
        <button
          class="tab"
          class:on={app.tab === 'film'}
          onclick={() => app.setTab('film')}
          >Film{#if app.filmArtifact}<span
              class="has"
              title="This file has a film"
            ></span>{/if}</button
        >
        <button
          class="tab"
          class:on={app.tab === 'source'}
          onclick={() => app.setTab('source')}>Source</button
        >
      {/if}
    </span>
  {:else}
    <span class="crumb">{app.workspace?.name ?? ''}</span>
  {/if}
</div>
