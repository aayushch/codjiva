<script lang="ts">
  import { showsFilm } from '$lib/artifacts';
  import { api, inDesktopApp } from '$lib/ipc';
  import { applyTheme, onSystemThemeChange } from '$lib/theme';
  import { app, DOCK_HEIGHT, DOCK_HEIGHT_FILM, DOCK_MIN, EDITOR_MIN, INSPECTOR_MAX, INSPECTOR_MIN, SIDEBAR_MAX, SIDEBAR_MIN } from '$lib/state/app.svelte';
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

  // The three panels around the editor area: the sidebar on the left, the inspector on the
  // right and the job panel at the bottom. They share one behaviour.
  //   - Dragging a panel's inner edge changes its size, between a least and a greatest size.
  //   - Dragging that edge to less than half of the least size closes the panel.
  //   - A closed panel leaves its handle on the edge of the window. Dragging the handle into
  //     the window, or clicking it, opens the panel again.
  //   - A button in the title bar and a key open and close each panel.
  //
  // `hasSidebar`, `hasInspector` and `hasDock` say whether the panel belongs on the screen at
  // all, and so whether its handle is there. `showSidebar`, `showInspector` and `showDock` say
  // whether the panel is open. Full screen hides all three. The inspector also needs an
  // artifact on screen to describe.
  const hasSidebar = $derived(!!app.workspace && !app.theater);
  const showSidebar = $derived(hasSidebar && app.sidebarOpen);
  const showArtifact = $derived(app.artifactShown);
  const hasInspector = $derived(showArtifact && !app.theater);
  const showInspector = $derived(hasInspector && app.inspectorOpen);

  // The sidebar's width when a drag of its handle began, or 0 if the sidebar was closed then.
  let sidebarAtDragStart = 0;
  // `moved` is how far right the pointer is from where the drag began.
  function dragSidebar(moved: number) {
    const wanted = sidebarAtDragStart + moved;
    if (wanted < SIDEBAR_MIN / 2) { app.sidebarOpen = false; return; }
    app.sidebarOpen = true;
    app.sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, wanted));
  }
  // The inspector's width when a drag of its handle began, or 0 if the inspector was closed.
  let inspectorAtDragStart = 0;
  // `moved` is how far right the pointer is from where the drag began, so a drag to the left
  // makes the inspector wider.
  function dragInspector(moved: number) {
    const wanted = inspectorAtDragStart - moved;
    if (wanted < INSPECTOR_MIN / 2) { app.inspectorOpen = false; return; }
    app.inspectorOpen = true;
    app.inspectorWidth = Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, wanted));
  }
  // Saves the panels' sizes and open states half a second after the last change, so that a
  // drag writes the settings file once and not on every pixel.
  $effect(() => {
    void [app.sidebarOpen, app.sidebarWidth, app.inspectorOpen, app.inspectorWidth, app.dockHeight, app.libraryOpen, app.libraryHeight];
    const timer = setTimeout(() => app.saveLayout(), 500);
    return () => clearTimeout(timer);
  });

  // The pointer was released within this many pixels of where it went down, which makes the
  // press a click and not a drag.
  const CLICK_SLACK = 3;
  // The toolbar is a row of its own across the editor area and the inspector, so that it keeps
  // its width when the inspector appears or goes away. An example hides it in full screen, and
  // the welcome screen has none.
  const showToolbar = $derived(app.example ? !app.theater : !!app.workspace);

  // The job panel at the bottom of the window belongs to an open workspace.
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
    if (dockAtDragStart === 0 && Math.abs(moved) < CLICK_SLACK) app.dockOpen = true;
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
    // The panels. The key with 0 shows and hides the sidebar, with Alt as well the inspector,
    // and the key with Shift and Y the job panel. Outside macOS, Control with Alt is how some
    // keyboards type a character, so that combination is left alone in a text field.
    if (app.workspace && !app.dialog && event.code === 'Digit0') {
      if (!event.altKey) { event.preventDefault(); app.sidebarOpen = !app.sidebarOpen; return; }
      if (app.info?.platform === 'macos' || !(event.target as HTMLElement).closest('input, textarea, select')) {
        event.preventDefault(); app.inspectorOpen = !app.inspectorOpen; return;
      }
    }
    if (app.workspace && !app.dialog && key === 'y' && event.shiftKey) { event.preventDefault(); app.dockOpen = !app.dockOpen; return; }
    if (key === 'p' && app.workspace) { event.preventDefault(); app.dialog = app.dialog === 'quickopen' ? null : 'quickopen'; }
    else if (key === 'o') { event.preventDefault(); app.pickAndOpen(); }
    else if (key === ',') { event.preventDefault(); app.dialog = 'settings'; }
  }
</script>

<!-- A mouse with side buttons sends button 3 for Back and button 4 for Forward. -->
<svelte:window bind:innerHeight={windowHeight} onkeydown={onKey} onmouseup={(e) => { if (app.workspace && !app.dialog && (e.button === 3 || e.button === 4)) { e.preventDefault(); if (e.button === 3) app.goBack(); else app.goForward(); } }} />

<div class="app" class:theater={app.theater} style:--sidebar-w="{showSidebar ? app.sidebarWidth : 0}px" style:--bar-h="{showToolbar ? TOOLBAR_HEIGHT : 0}px"
  style:--inspector-w="{showInspector ? app.inspectorWidth : 0}px" style:--dock-h="{showDock ? dockHeight : 0}px">
  {#if !app.theater}<TitleBar />{/if}

  {#if showSidebar}
    <aside class="sidebar">
      <div class="side-head"><span>Explorer</span><span class="grow"></span>
        <button class="tb-btn tip-end" data-tip="Go to file ({app.info?.platform === 'macos' ? '⌘' : 'Ctrl+'}P)" aria-label="Go to file" onclick={() => (app.dialog = 'quickopen')}><Icon name="search" /></button>
      </div>
      <FileTree />
      <Library />
    </aside>
  {/if}
  {#if hasSidebar}
    <div class="side-edge" class:closed={!showSidebar}>
      <Splitter label="Resize the sidebar" hint={showSidebar ? undefined : 'Drag right or click to show the sidebar'}
        onstart={() => (sidebarAtDragStart = showSidebar ? app.sidebarWidth : 0)} ondrag={dragSidebar}
        onend={(moved) => { if (sidebarAtDragStart === 0 && Math.abs(moved) < CLICK_SLACK) app.sidebarOpen = true; }} />
    </div>
  {/if}

  {#if showToolbar}<Toolbar />{/if}

  <main class="main">
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
  {#if hasInspector}
    <div class="insp-edge" class:closed={!showInspector}>
      <Splitter label="Resize the inspector" hint={showInspector ? undefined : 'Drag left or click to show the inspector'}
        onstart={() => (inspectorAtDragStart = showInspector ? app.inspectorWidth : 0)} ondrag={dragInspector}
        onend={(moved) => { if (inspectorAtDragStart === 0 && Math.abs(moved) < CLICK_SLACK) app.inspectorOpen = true; }} />
    </div>
  {/if}
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
