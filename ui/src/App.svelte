<script lang="ts">
  import { showsFilm } from '$lib/artifacts';
  import { api, inDesktopApp } from '$lib/ipc';
  import { applyTheme, onSystemThemeChange } from '$lib/theme';
  import { app, DOCK_HEIGHT, DOCK_HEIGHT_FILM, DOCK_MIN, EDITOR_MIN, INSPECTOR_WIDTH, SIDEBAR_MAX, SIDEBAR_MIN } from '$lib/state/app.svelte';
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

  // The heights of the title bar and the toolbar, which the grid in app-shell.css also uses.
  const TITLE_HEIGHT = 36;
  const TOOLBAR_HEIGHT = 44;

  // The sidebar's width when a drag of its edge began.
  let widthAtDragStart = 0;

  const showSidebar = $derived(!!app.workspace && !app.theater);
  // An artifact of the selected file is on screen: the open tab is Visual or Film, the file
  // has an artifact of that kind, and its details are loaded.
  const showArtifact = $derived(!app.example && !!app.currentArtifact && !!app.detail && app.tab !== 'source' && app.shownVersion != null && app.detail.manifest.artifactId === app.currentArtifact.id);
  const showInspector = $derived(showArtifact && !app.theater);
  // The toolbar is a row of its own across the editor area and the inspector, so that it keeps
  // its width when the inspector appears or goes away. An example hides it in full screen, and
  // the welcome screen has none.
  const showToolbar = $derived(app.example ? !app.theater : !!app.workspace);

  // The job panel at the bottom of the window. It belongs to an open workspace and is hidden in
  // full screen. Its handle lies on its top edge while it is open and on the bottom edge of the
  // window while it is closed, so the user can always drag it.
  const hasDock = $derived(!!app.workspace && !app.theater);
  const showDock = $derived(hasDock && app.dockOpen);
  let windowHeight = $state(window.innerHeight);
  // The tallest the panel can be: the window without the title bar, the toolbar and the height
  // that is kept for the editor area.
  const dockMax = $derived(Math.max(DOCK_MIN, windowHeight - TITLE_HEIGHT - TOOLBAR_HEIGHT - EDITOR_MIN));
  // The panel's height: the one the user dragged it to or, until they drag it, the height that
  // suits the kind of job. A film job lists more steps, so its panel is taller.
  const dockHeight = $derived(Math.min(dockMax, app.dockHeight
    ?? (app.job?.request.kind === 'animate' || (app.job?.request.kind === 'compose' && app.job.request.film) ? DOCK_HEIGHT_FILM : DOCK_HEIGHT)));
  // The panel's height when a drag of its handle began, or 0 if the panel was closed then.
  let dockAtDragStart = 0;
  // Follows a drag of the panel's handle. `moved` is how far down the pointer is from where the
  // drag began. A drag to less than half of the least height closes the panel. Any other drag
  // opens it and sets its height, between the least height and `dockMax`.
  function dragDock(moved: number) {
    const wanted = dockAtDragStart - moved;
    if (wanted < DOCK_MIN / 2) { app.dockOpen = false; return; }
    app.dockOpen = true;
    app.dockHeight = Math.min(dockMax, Math.max(DOCK_MIN, wanted));
  }
  // A click on the handle of the closed panel, without a drag, opens the panel.
  function endDockDrag(moved: number) {
    if (dockAtDragStart === 0 && Math.abs(moved) < 3) app.dockOpen = true;
  }

  function onKey(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape' && app.dialog && app.dialog !== 'gitignore') { app.dialog = null; return; }
    // Back and Forward. Command with [ and ] on macOS, Alt with the left and right arrows
    // elsewhere. The arrows are left alone in a text field, where Alt with an arrow moves the
    // caret by a word.
    if (app.workspace && !app.dialog) {
      const mac = app.info?.platform === 'macos';
      const inText = !!(event.target as HTMLElement).closest('input, textarea, select');
      const back = mac ? event.metaKey && event.key === '[' : event.altKey && event.key === 'ArrowLeft' && !inText;
      const forward = mac ? event.metaKey && event.key === ']' : event.altKey && event.key === 'ArrowRight' && !inText;
      if (back || forward) { event.preventDefault(); if (back) app.goBack(); else app.goForward(); return; }
    }
    if (!mod) return;
    if (key === 'p' && app.workspace) { event.preventDefault(); app.dialog = app.dialog === 'quickopen' ? null : 'quickopen'; }
    else if (key === 'o') { event.preventDefault(); app.pickAndOpen(); }
    else if (key === ',') { event.preventDefault(); app.dialog = 'settings'; }
  }
</script>

<!-- A mouse with side buttons sends button 3 for Back and button 4 for Forward. -->
<svelte:window bind:innerHeight={windowHeight} onkeydown={onKey} onmouseup={(e) => { if (app.workspace && !app.dialog && (e.button === 3 || e.button === 4)) { e.preventDefault(); if (e.button === 3) app.goBack(); else app.goForward(); } }} />

<div class="app" class:theater={app.theater} style:--sidebar-w="{showSidebar ? app.sidebarWidth : 0}px" style:--bar-h="{showToolbar ? TOOLBAR_HEIGHT : 0}px"
  style:--inspector-w="{showInspector ? INSPECTOR_WIDTH : 0}px" style:--dock-h="{showDock ? dockHeight : 0}px">
  {#if !app.theater}<TitleBar />{/if}

  {#if showSidebar}
    <aside class="sidebar">
      <div class="side-head"><span>Explorer</span><span class="grow"></span>
        <button class="tb-btn tip-end" data-tip="Go to file ({app.info?.platform === 'macos' ? '⌘' : 'Ctrl+'}P)" aria-label="Go to file" onclick={() => (app.dialog = 'quickopen')}><Icon name="search" /></button>
      </div>
      <FileTree />
      <Library />
    </aside>
    <Splitter label="Resize the sidebar" onstart={() => (widthAtDragStart = app.sidebarWidth)}
      ondrag={(dx) => (app.sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, widthAtDragStart + dx)))} />
  {/if}

  {#if showToolbar}<Toolbar />{/if}

  <main class="main" class:wide={!showSidebar}>
    {#if app.example}
      {#if app.example === 'film'}
        <FilmPlayer src={api.artifactUrl('reference/film') + '?embed=1'} title="Example film" />
      {:else}
        <VisualFrame src={api.artifactUrl('reference/visual') + '?embed=1'} title="Example visual" />
      {/if}
    {:else if !app.workspace}
      <Welcome />
    {:else}
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
  {#if hasDock}
    <div class="dock-edge" class:closed={!showDock}>
      <Splitter axis="y" label="Resize the job panel" hint={showDock ? undefined : 'Drag up or click to show the job panel'}
        onstart={() => (dockAtDragStart = showDock ? dockHeight : 0)} ondrag={dragDock} onend={endDockDrag} />
    </div>
  {/if}
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
