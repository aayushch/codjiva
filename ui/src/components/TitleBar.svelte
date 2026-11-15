<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import { updater } from '$lib/state/updater.svelte';
  import Icon from './Icon.svelte';
  import Logo from './Logo.svelte';

  // On macOS the window's own buttons are drawn over the left end of this bar,
  // so the bar's content starts to the right of them. In full screen those
  // buttons are hidden.
  //
  //
  // While a workspace is open the bar has three buttons that show and hide the
  // panels around the editor area: the sidebar button at the left end, and the
  // job panel and inspector buttons at the right end. The inspector button is
  // disabled while no visual or film is on screen, because the inspector has
  // nothing to describe then.
  //
  // The update notice is at the left of the agent status while a newer
  // version of the app waits, is being installed, is ready or failed to
  // install. Its button does the next step: install, restart, or try again.
  const mac = $derived(app.info?.platform === 'macos' && !app.theater);
  // The modifier keys as each system writes them, for the labels of the
  // buttons.
  const cmd = $derived(app.info?.platform === 'macos' ? '⌘' : 'Ctrl+');
  const alt = $derived(app.info?.platform === 'macos' ? '⌥' : 'Alt+');
  const shift = $derived(app.info?.platform === 'macos' ? '⇧' : 'Shift+');
</script>

<div class="titlebar" class:mac data-tauri-drag-region>
  {#if app.workspace}
    <button
      class="tb-btn tip-start"
      class:on={app.sidebarOpen}
      data-tip="{app.sidebarOpen ? 'Hide' : 'Show'} the sidebar ({cmd}0)"
      aria-label="Sidebar"
      aria-pressed={app.sidebarOpen}
      onclick={() => (app.sidebarOpen = !app.sidebarOpen)}
      ><Icon name="sidebar" /></button
    >
  {/if}
  <Logo />
  {#if app.workspace}
    <span class="ws" data-tauri-drag-region>{app.workspace.name}</span><span
      data-tauri-drag-region>— Codjiva</span
    >
  {:else}
    <span class="ws" data-tauri-drag-region>Codjiva</span>
  {/if}
  <span class="agent">
    {#if updater.noticeShown}
      <span class="update" role="status">
        {#if updater.status === 'ready'}
          <button class="update-act" onclick={() => updater.relaunch()}
            >Restart to update</button
          >
        {:else if updater.status === 'downloading'}
          <span class="update-text">Updating · {updater.progress}%</span>
        {:else if updater.status === 'error'}
          <button
            class="update-act"
            title={updater.error ?? ''}
            onclick={() => updater.install()}>Update failed · Retry</button
          >
        {:else}
          <button class="update-act" onclick={() => updater.install()}
            >Update to {updater.version}</button
          >
        {/if}
        {#if updater.status !== 'downloading'}
          <button
            class="update-close"
            aria-label="Hide the update notice"
            onclick={() => (updater.dismissed = true)}>✕</button
          >
        {/if}
      </span>
    {/if}
    {#if app.job?.status === 'running'}
      <span class="dot"></span>
      {app.job.agent ?? app.activeAgent?.name ?? 'Agent'} · working
    {:else if app.activeAgent}
      <span class="dot cool"></span> {app.activeAgent.name} · ready
    {:else if app.agentsLoaded}
      <button class="agent-none" onclick={() => (app.dialog = 'settings')}
        ><span class="dot off"></span> No agent available</button
      >
    {:else}
      <span class="dot off"></span> Looking for agents…
    {/if}
    {#if app.workspace}
      <button
        class="tb-btn"
        class:on={app.dockOpen}
        data-tip="{app.dockOpen
          ? 'Hide'
          : 'Show'} the job panel ({shift}{cmd}Y)"
        aria-label="Job panel"
        aria-pressed={app.dockOpen}
        onclick={() => (app.dockOpen = !app.dockOpen)}
        ><Icon name="panel" /></button
      >
      <button
        class="tb-btn tip-end"
        class:on={app.inspectorOpen && app.artifactShown}
        disabled={!app.artifactShown}
        data-tip="{app.inspectorOpen
          ? 'Hide'
          : 'Show'} the inspector ({alt}{cmd}0)"
        aria-label="Inspector"
        aria-pressed={app.inspectorOpen}
        onclick={() => (app.inspectorOpen = !app.inspectorOpen)}
        ><Icon name="inspector" /></button
      >
    {/if}
    <button
      class="tb-btn tip-end"
      data-tip="Open folder…"
      aria-label="Open folder"
      onclick={() => app.pickAndOpen()}><Icon name="folder-open" /></button
    >
    <button
      class="tb-btn tip-end"
      data-tip="Settings"
      aria-label="Settings"
      onclick={() => (app.dialog = 'settings')}><Icon name="settings" /></button
    >
  </span>
</div>
