<script lang="ts">
  import type { Rationale } from '$lib/ipc';
  import { rationaleParts } from '$lib/artifacts';
  import { app } from '$lib/state/app.svelte';

  // One rationale in the inspector: why the code does what a part of a visual
  // or a step of a film describes.
  //
  // It shows the reason, then where the reason comes from. "Stated in the
  // code" means a comment or a name in the code gives it. "Inferred from the
  // code" means the agent concluded it from how the code works. Each
  // reference opens the file at the line that shows the reason.
  let { rationale }: { rationale: Rationale } = $props();

  const shortPath = (path: string) => path.split('/').pop() ?? path;
</script>

<div class="rationale">
  <p>
    {#each rationaleParts(rationale.text) as part}{#if part.code}<code
          >{part.text}</code
        >{:else}{part.text}{/if}{/each}
  </p>
  <div class="origin">
    <span class="basis" class:inferred={rationale.basis !== 'stated'}
      >{rationale.basis === 'stated'
        ? 'Stated in the code'
        : 'Inferred from the code'}</span
    >
    {#each rationale.refs as ref}
      <button
        class="ref inline"
        title={ref.path}
        onclick={() => app.selectFile(ref.path, ref.line)}
        >{shortPath(ref.path)}:{ref.line}</button
      >
    {/each}
  </div>
</div>

<style>
  .rationale p {
    margin-bottom: 6px;
  }
  .origin {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 8px;
    font-size: 11px;
    color: var(--muted);
  }
  /* A reason that the agent concluded by itself is set apart from one the
     code states, so that the reader knows how far to trust it. */
  .basis.inferred {
    color: var(--main);
  }
</style>
