<script lang="ts">
  import { portCount } from '$lib/artifacts';
  import { app, LIBRARY_MIN, TREE_MIN } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';
  import Poster from './Poster.svelte';
  import Splitter from './Splitter.svelte';

  // The list of everything Codjiva has made in this workspace, at the bottom of
  // the sidebar.
  //
  // Size. The library starts as tall as its list, up to two fifths of the
  // sidebar, and a longer list scrolls under the heading. Dragging the top edge
  // of the library sets its height, which leaves at least TREE_MIN pixels for
  // the file tree. Clicking the heading hides the list, so that only the
  // heading is left, and shows it again.
  let library: HTMLDivElement | undefined = $state();
  let heightAtDragStart = 0;
  function resize(moved: number) {
    const room = (library?.parentElement?.clientHeight ?? 600) - TREE_MIN;
    app.libraryHeight = Math.round(
      Math.min(
        Math.max(LIBRARY_MIN, room),
        Math.max(LIBRARY_MIN, heightAtDragStart - moved),
      ),
    );
  }
  const formatDuration = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

  // A second click on the delete button confirms it. This holds the artifact
  // waiting for that.
  let confirming = $state<string | null>(null);

  // Visuals and films can be ticked to compose them into a pipeline. An
  // artifact without ports records no place where it meets other code, so it
  // cannot be joined.
  const canTick = (artifact: (typeof app.artifacts)[number]) =>
    artifact.kind !== 'pipeline' && artifact.ports.length > 0;
</script>

{#if app.artifacts.length}
  <div
    class="library"
    class:sized={app.libraryOpen && app.libraryHeight != null}
    bind:this={library}
    style:height={app.libraryOpen && app.libraryHeight != null
      ? app.libraryHeight + 'px'
      : null}
  >
    {#if app.libraryOpen}<Splitter
        axis="y"
        label="Resize the library"
        onstart={() => (heightAtDragStart = library?.offsetHeight ?? 0)}
        ondrag={resize}
      />{/if}
    <div class="side-head">
      <button
        class="lib-toggle"
        aria-expanded={app.libraryOpen}
        onclick={() => (app.libraryOpen = !app.libraryOpen)}
      >
        <span class="chev">{app.libraryOpen ? '▾' : '▸'}</span>Codjiva library<span
          class="count">{app.artifacts.length}</span
        ></button
      >
      <span class="grow"></span>
      {#if app.libraryOpen && app.composeSelection.length}
        <button
          class="btn small lib-compose"
          disabled={app.composeSelection.length < 2}
          title={app.composeSelection.length < 2
            ? 'Tick at least two artifacts to join them'
            : 'Join the ticked artifacts into one pipeline'}
          onclick={() => app.askCompose(app.composeSelection)}
          >Compose {app.composeSelection.length}…</button
        >
      {/if}
    </div>
    {#if app.libraryOpen}
      <div class="lib-list">
        {#each app.artifacts as artifact (artifact.id)}
          <div
            class="lib-item"
            class:on={app.currentArtifact?.id === artifact.id}
            role="button"
            tabindex="0"
            title={artifact.subject.join(', ')}
            onclick={() => app.openArtifact(artifact)}
            onkeydown={(e) => {
              if (e.key === 'Enter') app.openArtifact(artifact);
            }}
          >
            <Poster
              artifactId={artifact.id}
              version={artifact.currentVersion}
            />
            <div class="lib-text">
              <div class="t">{artifact.title}</div>
              <div class="m">
                {artifact.kind}{artifact.durationSec
                  ? ' · ' + formatDuration(artifact.durationSec)
                  : ''} · v{artifact.currentVersion}{#if artifact.stale}{' · '}<span
                    class="stale">stale</span
                  >{/if}
              </div>
              {#if artifact.kind === 'pipeline'}
                <div class="m">{artifact.parts?.length ?? 0} parts</div>
              {:else if portCount(artifact)}
                <div
                  class="m ports"
                  title={artifact.ports
                    .map((p) => `${p.dir}: ${p.symbol}`)
                    .join('\n')}
                >
                  ports · {portCount(artifact)}
                </div>
              {/if}
            </div>
            {#if canTick(artifact)}
              <input
                type="checkbox"
                class="lib-tick"
                class:shown={app.composeSelection.length > 0}
                aria-label="Use {artifact.title} in a pipeline"
                title="Tick to join this with others in a pipeline"
                checked={app.composeSelection.includes(artifact.id)}
                onclick={(e) => e.stopPropagation()}
                onchange={() => app.toggleCompose(artifact.id)}
              />
            {/if}
            <button
              class="tb-btn lib-del"
              class:armed={confirming === artifact.id}
              title={confirming === artifact.id
                ? 'Click again to delete it and all its versions'
                : 'Delete'}
              aria-label="Delete"
              onclick={(e) => {
                e.stopPropagation();
                if (confirming === artifact.id) {
                  confirming = null;
                  app.deleteArtifact(artifact.id);
                } else confirming = artifact.id;
              }}
              onblur={() => (confirming = null)}
              ><Icon name="close" size={12} /></button
            >
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
