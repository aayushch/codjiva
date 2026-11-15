<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  const dateOf = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
</script>

<div class="canvas">
  <div class="empty">
    <div class="card welcome">
      <Logo size={40} />
      <div class="fname">Codjiva</div>
      <div class="path">Take any code and see it work, end to end.</div>
      <div class="actions">
        <button class="btn primary" onclick={() => app.pickAndOpen()}
          ><Icon name="folder-open" size={16} />Open folder…</button
        >
        <button class="btn" onclick={() => (app.example = 'film')}
          ><Icon name="film" size={16} />Watch the example film</button
        >
      </div>
      {#if app.recents.length}
        <div class="recents">
          <div class="kicker">Recent</div>
          {#each app.recents as recent (recent.path)}
            <button
              class="recent"
              title={recent.path}
              onclick={() => app.openWorkspace(recent.path)}
            >
              <Icon name="dir" /><span class="name">{recent.name}</span><span
                class="where">{recent.path}</span
              ><span class="when">{dateOf(recent.openedAt)}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="hint">
        Codjiva reads your code and draws how it works. It never edits or runs
        your code.
      </div>
    </div>
  </div>
</div>
