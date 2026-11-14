<script lang="ts">
  import { showsFilm } from '$lib/artifacts';
  import { api, inDesktopApp } from '$lib/ipc';
  import { applyTheme, onSystemThemeChange } from '$lib/theme';
  import { app, DOCK_HEIGHT, DOCK_HEIGHT_FILM, INSPECTOR_WIDTH, SIDEBAR_MAX, SIDEBAR_MIN } from '$lib/state/app.svelte';
  import AnimateDialog from './components/AnimateDialog.svelte';
  import ComposeDialog from './components/ComposeDialog.svelte';
  import EditorEmpty from './components/EditorEmpty.svelte';
  import FileTree from './components/FileTree.svelte';
  import FilmPlayer from './components/FilmPlayer.svelte';
  import GitignorePrompt from './components/GitignorePrompt.svelte';
  import Icon from './components/Icon.svelte';
  import Inspector from './components/Inspector.svelte';
  import InstructionsDialog from './components/InstructionsDialog.svelte';
  import JobPanel from './components/JobPanel.svelte';
  import Library from './components/Library.svelte';
  import OutlineDialog from './components/OutlineDialog.svelte';
  import Validator from './components/Validator.svelte';
  import QuickOpen from './components/QuickOpen.svelte';
  import Settings from './components/Settings.svelte';
  import SourceView from './components/SourceView.svelte';
  import Splitter from './components/Splitter.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import VisualFrame from './components/VisualFrame.svelte';
  import Welcome from './components/Welcome.svelte';

  $effect(() => {
    app.init().then(async () => {
      // The self-check tour only exists in the desktop app, so its code is loaded only there.
      if (inDesktopApp) (await import('$lib/selfcheck')).runSelfCheckIfAsked();
    });
    return () => app.dispose();
  });

  // Keeps the window in the theme the settings ask for. With the `system` setting the theme is
  // applied again whenever the operating system switches between light and dark.
  $effect(() => {
    const setting = app.settings?.theme;
    if (!setting) return;
    app.theme = applyTheme(setting);
    if (setting === 'system') return onSystemThemeChange(() => { app.theme = applyTheme('system'); });
  });

  // The sidebar's width when a drag of its edge began.
  let widthAtDragStart = 0;

  const showSidebar = $derived(!!app.workspace && !app.theater);
  // An artifact of the selected file is on screen: the open tab is Visual or Film, the file
  // has an artifact of that kind, and its details are loaded.
  const showArtifact = $derived(!app.example && !!app.currentArtifact && !!app.detail && app.tab !== 'source' && app.shownVersion != null && app.detail.manifest.artifactId === app.currentArtifact.id);
  const showInspector = $derived(showArtifact && !app.theater);
  const showDock = $derived(!!app.job && app.dockOpen && !app.theater);

  function onKey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape' && app.dialog && app.dialog !== 'gitignore') { app.dialog = null; return; }
    if (!mod) return;
    if (key === 'p' && app.workspace) { event.preventDefault(); app.dialog = app.dialog === 'quickopen' ? null : 'quickopen'; }
    else if (key === 'o') { event.preventDefault(); app.pickAndOpen(); }
    else if (key === ',') { event.preventDefault(); app.dialog = 'settings'; }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="app" class:theater={app.theater} style:--sidebar-w="{showSidebar ? app.sidebarWidth : 0}px"
  style:--inspector-w="{showInspector ? INSPECTOR_WIDTH : 0}px" style:--dock-h="{showDock ? (app.job?.request.kind === 'animate' || (app.job?.request.kind === 'compose' && app.job.request.film) ? DOCK_HEIGHT_FILM : DOCK_HEIGHT) : 0}px">
  {#if !app.theater}<TitleBar />{/if}

  {#if showSidebar}
    <aside class="sidebar">
      <div class="side-head"><span>Explorer</span><span class="grow"></span>
        <button class="tb-btn" title="Go to file ({app.info?.platform === 'macos' ? '⌘' : 'Ctrl+'}P)" aria-label="Go to file" onclick={() => (app.dialog = 'quickopen')}><Icon name="search" /></button>
      </div>
      <FileTree />
      <Library />
    </aside>
    <Splitter label="Resize the sidebar" onstart={() => (widthAtDragStart = app.sidebarWidth)}
      ondrag={(dx) => (app.sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, widthAtDragStart + dx)))} />
  {/if}

  <main class="main" class:wide={!showSidebar}>
    {#if app.example}
      {#if !app.theater}<Toolbar />{/if}
      {#if app.example === 'film'}
        <FilmPlayer src={api.artifactUrl('reference/film') + '?embed=1'} title="Example film" />
      {:else}
        <VisualFrame src={api.artifactUrl('reference/visual') + '?embed=1'} title="Example visual" />
      {/if}
    {:else if !app.workspace}
      <Welcome />
    {:else}
      <Toolbar />
      {#if !app.selected}
        <div class="canvas"><div class="empty"><div class="card"><div class="path">Select a file in the explorer to see what Codjiva can draw from it.</div></div></div></div>
      {:else if app.tab === 'source' && !app.selectedPipelineId}
        <SourceView relPath={app.selected} line={app.sourceLine} />
      {:else if showArtifact && app.currentArtifact}
        {#key `${app.currentArtifact.id}/${app.shownVersion}`}
          {#if showsFilm(app.currentArtifact)}
            <FilmPlayer src={api.artifactUrl(`artifact/${app.currentArtifact.id}/${app.shownVersion}`) + '?embed=1'} title={app.currentArtifact.title} feedback />
          {:else}
            <VisualFrame src={api.artifactUrl(`artifact/${app.currentArtifact.id}/${app.shownVersion}`) + '?embed=1'} title={app.currentArtifact.title}
              onselect={(nodeId) => (app.selectedNode = nodeId)} />
          {/if}
        {/key}
      {:else}
        <div class="canvas"><EditorEmpty /></div>
      {/if}
    {/if}
  </main>

  {#if showInspector}<Inspector />{/if}
  {#if showDock}<JobPanel />{/if}
</div>

{#if app.dialog === 'quickopen'}<QuickOpen />{/if}
{#if app.dialog === 'settings'}<Settings />{/if}
{#if app.dialog === 'gitignore'}<GitignorePrompt />{/if}
{#if app.dialog === 'instructions'}<InstructionsDialog />{/if}
{#if app.dialog === 'animate'}<AnimateDialog />{/if}
{#if app.dialog === 'outline'}<OutlineDialog />{/if}
{#if app.dialog === 'compose'}<ComposeDialog />{/if}
<Validator />
<Toasts />
