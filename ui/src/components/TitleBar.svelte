<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  // On macOS the window's own buttons are drawn over the left end of this bar, so the bar's
  // content starts to the right of them. In full screen those buttons are hidden.
  //
  // The job panel button is there while a workspace is open. It shows and hides the panel at
  // the bottom of the window.
  const mac = $derived(app.info?.platform === 'macos' && !app.theater);
</script>

<div class="titlebar" class:mac data-tauri-drag-region>
  <Logo />
  {#if app.workspace}
    <span class="ws" data-tauri-drag-region>{app.workspace.name}</span><span data-tauri-drag-region>— Codjiva</span>
  {:else}
    <span class="ws" data-tauri-drag-region>Codjiva</span>
  {/if}
  <span class="agent">
    {#if app.job?.status === 'running'}
      <span class="dot"></span> {app.job.agent ?? app.activeAgent?.name ?? 'Agent'} · working
    {:else if app.activeAgent}
      <span class="dot cool"></span> {app.activeAgent.name} · ready
    {:else if app.agentsLoaded}
      <button class="agent-none" onclick={() => (app.dialog = 'settings')}><span class="dot off"></span> No agent available</button>
    {:else}
      <span class="dot off"></span> Looking for agents…
    {/if}
    {#if app.workspace}
      <button class="tb-btn" class:on={app.dockOpen} data-tip={app.dockOpen ? 'Hide the job panel' : 'Show the job panel'} aria-label="Job panel" aria-pressed={app.dockOpen}
        onclick={() => (app.dockOpen = !app.dockOpen)}><Icon name="panel" /></button>
    {/if}
    <button class="tb-btn tip-end" data-tip="Open folder…" aria-label="Open folder" onclick={() => app.pickAndOpen()}><Icon name="folder-open" /></button>
    <button class="tb-btn tip-end" data-tip="Settings" aria-label="Settings" onclick={() => (app.dialog = 'settings')}><Icon name="settings" /></button>
  </span>
</div>
