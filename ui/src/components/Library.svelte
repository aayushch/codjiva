<script lang="ts">
  import { portCount } from '$lib/artifacts';
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';
  import Poster from './Poster.svelte';

  // The list of everything Codjiva has made in this workspace, at the bottom of the sidebar.
  const formatDuration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

  // A second click on the delete button confirms it. This holds the artifact waiting for that.
  let confirming = $state<string | null>(null);

  // Visuals and films can be ticked to compose them into a pipeline. An artifact without ports
  // records no place where it meets other code, so it cannot be joined.
  const canTick = (artifact: (typeof app.artifacts)[number]) => artifact.kind !== 'pipeline' && artifact.ports.length > 0;
</script>

{#if app.artifacts.length}
  <div class="library">
    <div class="side-head"><span>Codjiva library</span><span class="grow"></span>
      {#if app.composeSelection.length}
        <button class="btn small lib-compose" disabled={app.composeSelection.length < 2} title={app.composeSelection.length < 2 ? 'Tick at least two artifacts to join them' : 'Join the ticked artifacts into one pipeline'}
          onclick={() => app.askCompose(app.composeSelection)}>Compose {app.composeSelection.length}…</button>
      {/if}
    </div>
    {#each app.artifacts as artifact (artifact.id)}
      <div class="lib-item" class:on={app.currentArtifact?.id === artifact.id} role="button" tabindex="0" title={artifact.subject.join(', ')}
        onclick={() => app.openArtifact(artifact)}
        onkeydown={(e) => { if (e.key === 'Enter') app.openArtifact(artifact); }}>
        <Poster artifactId={artifact.id} version={artifact.currentVersion} />
        <div class="lib-text">
          <div class="t">{artifact.title}</div>
          <div class="m">
            {artifact.kind}{artifact.durationSec ? ' · ' + formatDuration(artifact.durationSec) : ''} · v{artifact.currentVersion}{#if artifact.stale}{' · '}<span class="stale">stale</span>{/if}
          </div>
          {#if artifact.kind === 'pipeline'}
            <div class="m">{artifact.parts?.length ?? 0} parts</div>
          {:else if portCount(artifact)}
            <div class="m ports" title={artifact.ports.map((p) => `${p.dir}: ${p.symbol}`).join('\n')}>ports · {portCount(artifact)}</div>
          {/if}
        </div>
        {#if canTick(artifact)}
          <input type="checkbox" class="lib-tick" class:shown={app.composeSelection.length > 0} aria-label="Use {artifact.title} in a pipeline" title="Tick to join this with others in a pipeline"
            checked={app.composeSelection.includes(artifact.id)} onclick={(e) => e.stopPropagation()} onchange={() => app.toggleCompose(artifact.id)} />
        {/if}
        <button class="tb-btn lib-del" class:armed={confirming === artifact.id} title={confirming === artifact.id ? 'Click again to delete it and all its versions' : 'Delete'} aria-label="Delete"
          onclick={(e) => { e.stopPropagation(); if (confirming === artifact.id) { confirming = null; app.deleteArtifact(artifact.id); } else confirming = artifact.id; }}
          onblur={() => (confirming = null)}><Icon name="close" size={12} /></button>
      </div>
    {/each}
  </div>
{/if}
