<script lang="ts">
  import { app } from '$lib/state/app.svelte';

  // The parts of the selected path. A folder's path ends with a slash, which is shown after
  // its last part.
  const parts = $derived(app.selected ? app.selected.replace(/\/$/, '').split('/') : []);
  const artifact = $derived(app.currentArtifact);
  const shown = $derived(artifact?.versions.find((v) => v.version === app.shownVersion) ?? null);

  // Describes when a version was made, relative to today: "today 14:05", "yesterday", "3 Nov".
  function whenMade(iso: string): string {
    const made = new Date(iso);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const days = Math.floor((startOfToday.getTime() - new Date(made).setHours(0, 0, 0, 0)) / 86_400_000);
    if (days <= 0) return 'today ' + made.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return 'yesterday';
    return made.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
</script>

<div class="toolbar">
  {#if app.example}
    <span class="crumb">Example / <b>{app.example === 'film' ? 'How an order moves through the orders Handler' : 'Handler.Submit, a still visual'}</b></span>
    <span class="spacer"></span>
    <span class="tabs">
      <button class="tab" class:on={app.example === 'film'} onclick={() => (app.example = 'film')}>Film</button>
      <button class="tab" class:on={app.example === 'visual'} onclick={() => (app.example = 'visual')}>Visual</button>
    </span>
    <button class="btn small" onclick={() => (app.example = null)}>Close example</button>
  {:else if app.selectedPipelineId}
    <span class="crumb">Pipeline / <b>{artifact?.title ?? ''}</b></span>
    <span class="spacer"></span>
    {#if artifact}
      {#if artifact.stale}<span class="badge-stale" title="A source file of one of its parts changed after this version was made">stale</span>{/if}
      {#if shown && !shown.passed}<span class="badge-issues" title="Problems the checks found and the agent could not fix">{shown.errors} issue{shown.errors === 1 ? '' : 's'}</span>{/if}
      <select class="select" aria-label="Version" value={String(app.shownVersion)} onchange={(e) => app.pickVersion(Number(e.currentTarget.value))}>
        {#each [...artifact.versions].reverse() as version (version.version)}
          <option value={String(version.version)}>v{version.version} · {whenMade(version.createdAt)}{version.version === artifact.currentVersion ? '' : ' (earlier)'}</option>
        {/each}
      </select>
    {/if}
  {:else if app.selected}
    <span class="crumb">{#each parts.slice(0, -1) as part}{part}{' / '}{/each}<b>{parts[parts.length - 1]}{app.selectedIsFolder ? '/' : ''}</b></span>
    <span class="spacer"></span>
    <span class="tabs">
      <button class="tab" class:on={app.tab === 'visual'} onclick={() => app.setTab('visual')}>Visual{#if app.visualArtifact}<span class="has" title="This has a visual"></span>{/if}</button>
      {#if !app.selectedIsFolder}
        <button class="tab" class:on={app.tab === 'film'} onclick={() => app.setTab('film')}>Film{#if app.filmArtifact}<span class="has" title="This file has a film"></span>{/if}</button>
        <button class="tab" class:on={app.tab === 'source'} onclick={() => app.setTab('source')}>Source</button>
      {/if}
    </span>
    {#if artifact && app.tab !== 'source'}
      {#if artifact.stale}<span class="badge-stale" title="A source file changed after this version was made">stale</span>{/if}
      {#if shown && !shown.passed}<span class="badge-issues" title="Problems the checks found and the agent could not fix">{shown.errors} issue{shown.errors === 1 ? '' : 's'}</span>{/if}
      <select class="select" aria-label="Version" value={String(app.shownVersion)} onchange={(e) => app.pickVersion(Number(e.currentTarget.value))}>
        {#each [...artifact.versions].reverse() as version (version.version)}
          <option value={String(version.version)}>v{version.version} · {whenMade(version.createdAt)}{version.version === artifact.currentVersion ? '' : ' (earlier)'}</option>
        {/each}
      </select>
    {/if}
  {:else}
    <span class="crumb">{app.workspace?.name ?? ''}</span>
  {/if}
</div>
