<script lang="ts">
  import { FILE_KINDS, isView, showsFilm, VIEWS } from '$lib/artifacts';
  import { targetOfArtifact } from '$lib/jobs';
  import { api } from '$lib/ipc';
  import { app, type MenuItem } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // The bar above the editor area and the inspector. From left to right it
  // holds the Back and Forward buttons, the path of what is selected with a
  // button that copies it, the controls of the artifact on screen, and the
  // Visual, Film, Step-through and Source tabs. The tabs are last so that
  // they stay at the
  // right end of the bar, in the same place whether or not the selected file
  // has an artifact to show controls for.
  //
  // A file has more views than fit in the bar as tabs of their own. Its
  // schema, lanes and structure views share one tab, labelled "More". A click
  // on it opens a menu of the three, each with a sentence on what it is for,
  // and choosing one shows that view. While one of them is showing, the tab
  // has that view's name. A folder has two tabs of its own, Visual and Map.
  //
  // Which of a file's six tabs to use. The user can ask the agent which kind
  // of artifact suits the file (`app.askSuggestion`). The tab of the kind the
  // agent puts first is then underlined, and its tooltip gives the agent's
  // reason. The menu of the "More" tab has the command that asks.
  //
  // The copy button puts the path inside the workspace on the clipboard, which
  // is the path the bar shows. A right-click on the path opens a menu that
  // can also copy the full path on this computer.

  // The parts of the selected path. A folder's path ends with a slash, which is
  // shown after its last part.
  const parts = $derived(
    app.selected ? app.selected.replace(/\/$/, '').split('/') : [],
  );
  const artifact = $derived(app.currentArtifact);

  // The views a file can have. A map is made of a folder only.
  const fileViews = VIEWS.filter((view) => view.name !== 'map');
  // The view on screen, when the open tab is one of the views of a file.
  const shownView = $derived(
    fileViews.find((view) => view.name === app.tab) ?? null,
  );
  // True when the selected file has at least one of those views.
  const hasFileView = $derived(
    fileViews.some((view) => app.viewArtifact(view.name) != null),
  );
  // What the tooltip of a tab says: what the kind of that tab is for, and
  // the agent's reason when the agent put that kind first.
  function tipOf(tab: string): string {
    const kind = FILE_KINDS.find((one) => one.tab === tab);
    if (!kind) return '';
    const first = app.suggestion?.ranked[0];
    return first?.kind === kind.kind
      ? `Suggested for this file. ${first.reason}\n\n${kind.about}`
      : kind.about;
  }
  // True when the agent put the kind of this tab first for the selected file.
  const isSuggested = (tab: string) =>
    FILE_KINDS.some((one) => one.tab === tab && one.kind === app.suggestedKind);
  // The view of the "More" tab that the agent put first, if it is one of
  // them.
  const suggestedView = $derived(
    fileViews.find((view) => view.name === app.suggestedKind) ?? null,
  );
  // The menu of the "More" tab. It has one command per view of a file, with
  // a sentence on what the view is for. A view is marked when the agent put
  // it first, and when it has been made. The last command asks the agent
  // which kind suits the file. It is disabled while no agent is available
  // and while the agent is answering.
  const viewMenu = (): MenuItem[] => [
    ...fileViews.map((view) => ({
      label: view.label,
      detail: view.about,
      mark: [
        view.name === app.suggestedKind ? 'suggested' : '',
        app.viewArtifact(view.name) ? 'made' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      action: () => app.setTab(view.name),
    })),
    'separator',
    {
      label: app.suggesting
        ? 'Asking which view fits…'
        : app.suggestion
          ? 'Ask again which view fits this file'
          : 'Which view fits this file?',
      disabled: app.suggesting || !app.activeAgent,
      action: () => app.askSuggestion(true),
    },
  ];

  // True for a moment after the copy button was pressed. The button shows a
  // tick meanwhile, in place of its icon.
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyShownPath() {
    if (!app.selected) return;
    if (!(await app.copyPath(app.selected, false, false))) return;
    copied = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copied = false), 1500);
  }
  // The keys for Back and Forward, as the buttons' labels show them. App.svelte
  // handles the keys.
  const mac = $derived(app.info?.platform === 'macos');
  const shown = $derived(
    artifact?.versions.find((v) => v.version === app.shownVersion) ?? null,
  );
  const isPipeline = $derived(artifact?.kind === 'pipeline');
  // A visual or a step-through of a single file can be turned into a film. A
  // folder, a film and a pipeline cannot.
  const canAnimate = $derived(
    !!artifact &&
      !isPipeline &&
      !showsFilm(artifact) &&
      !isView(artifact.kind) &&
      !app.selectedIsFolder,
  );

  // True while a job is making the film of the file on screen. The button that
  // makes a film of the file is disabled meanwhile.
  const filmBusy = $derived(
    !!artifact &&
      app.isBusy(targetOfArtifact({ kind: 'film', subject: artifact.subject })),
  );

  // Describes when a version was made, relative to today: "today 14:05",
  // "yesterday", "3 Nov".
  function whenMade(iso: string): string {
    const made = new Date(iso);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const days = Math.floor(
      (startOfToday.getTime() - new Date(made).setHours(0, 0, 0, 0)) /
        86_400_000,
    );
    if (days <= 0)
      return (
        'today ' +
        made.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    if (days === 1) return 'yesterday';
    return made.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });
  }
</script>

<!-- The controls of the artifact on screen: its badges, the version picker and
     the actions on the version. `staleWhy` is the text that explains the
     "stale" badge. -->
{#snippet controls(staleWhy: string)}
  {#if artifact && app.shownVersion != null}
    {@const version = app.shownVersion}
    {#if artifact.stale}<span class="badge-stale" title={staleWhy}>stale</span
      >{/if}
    {#if shown && !shown.passed}<span
        class="badge-issues"
        title="Problems the checks found and the agent could not fix"
        >{shown.errors} issue{shown.errors === 1 ? '' : 's'}</span
      >{/if}
    <select
      class="select"
      aria-label="Version"
      value={String(version)}
      onchange={(e) => app.pickVersion(Number(e.currentTarget.value))}
    >
      {#each [...artifact.versions].reverse() as one (one.version)}
        <option value={String(one.version)}
          >v{one.version} · {whenMade(one.createdAt)}{one.version ===
          artifact.currentVersion
            ? ''
            : ' (earlier)'}</option
        >
      {/each}
    </select>
    <span class="actions">
      <button
        class="tb-btn"
        data-tip={isPipeline ? 'Compose again…' : 'Regenerate…'}
        aria-label={isPipeline ? 'Compose again…' : 'Regenerate…'}
        disabled={app.artifactBusy}
        onclick={() => app.askRegenerate()}
        ><Icon name="again" size={16} /></button
      >
      {#if canAnimate}<button
          class="tb-btn"
          data-tip="Make a film of this file…"
          aria-label="Animate…"
          disabled={filmBusy}
          onclick={() => app.askAnimate()}
          ><Icon name="film" size={16} /></button
        >{/if}
      <button
        class="tb-btn"
        data-tip="Export as an HTML file"
        aria-label="Export HTML"
        onclick={() => app.exportArtifact()}
        ><Icon name="export" size={16} /></button
      >
      <button
        class="tb-btn"
        data-tip="Open in the browser"
        aria-label="Open in browser"
        onclick={() =>
          api
            .artifactOpenInBrowser(artifact.id, version)
            .catch((e) => app.fail(e))}
        ><Icon name="external" size={16} /></button
      >
      <button
        class="tb-btn"
        data-tip="Show the files in {app.info?.dotDir ?? '.codjiva'}"
        aria-label="Reveal in {app.info?.dotDir ?? '.codjiva'}"
        onclick={() =>
          api.artifactReveal(artifact.id, version).catch((e) => app.fail(e))}
        ><Icon name="reveal" size={16} /></button
      >
    </span>
  {/if}
{/snippet}

<div class="toolbar">
  {#if !app.example}
    <span class="history">
      <button
        class="tb-btn tip-start"
        data-tip="Back ({mac ? '⌘[' : 'Alt+←'})"
        aria-label="Back"
        disabled={!app.canGoBack}
        onclick={() => app.goBack()}><Icon name="back" size={16} /></button
      >
      <button
        class="tb-btn tip-start"
        data-tip="Forward ({mac ? '⌘]' : 'Alt+→'})"
        aria-label="Forward"
        disabled={!app.canGoForward}
        onclick={() => app.goForward()}
        ><Icon name="forward" size={16} /></button
      >
    </span>
  {/if}
  {#if app.example}
    <span class="crumb"
      >Example / <b
        >{app.example === 'film'
          ? 'How an order moves through the orders Handler'
          : 'Handler.Submit, a still visual'}</b
      ></span
    >
    <span class="spacer"></span>
    <span class="tabs">
      <button
        class="tab"
        class:on={app.example === 'film'}
        onclick={() => (app.example = 'film')}>Film</button
      >
      <button
        class="tab"
        class:on={app.example === 'visual'}
        onclick={() => (app.example = 'visual')}>Visual</button
      >
    </span>
    <button class="btn small" onclick={() => (app.example = null)}
      >Close example</button
    >
  {:else if app.selectedPipelineId}
    <span class="crumb">Pipeline / <b>{artifact?.title ?? ''}</b></span>
    <span class="spacer"></span>
    {@render controls(
      'A source file of one of its parts changed after this version was made',
    )}
  {:else if app.selected}
    {@const path = app.selected}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <span
      class="crumb"
      oncontextmenu={(event) =>
        app.openMenu(event, [
          { label: 'Copy path', action: () => app.copyPath(path, true) },
          { label: 'Copy relative path', action: () => app.copyPath(path) },
        ])}
      >{#each parts.slice(0, -1) as part}{part}{' / '}{/each}<b
        >{parts[parts.length - 1]}{app.selectedIsFolder ? '/' : ''}</b
      ></span
    >
    <button
      class="tb-btn copy-path"
      data-tip={copied ? 'Copied' : 'Copy the path'}
      aria-label="Copy the path"
      onclick={copyShownPath}
      ><Icon name={copied ? 'check' : 'copy'} size={14} /></button
    >
    <span class="spacer"></span>
    {#if artifact && app.tab !== 'source'}
      {@render controls('A source file changed after this version was made')}
      <span class="divider"></span>
    {/if}
    <span class="tabs">
      <button
        class="tab"
        class:on={app.tab === 'visual'}
        class:suggested={!app.selectedIsFolder && isSuggested('visual')}
        title={app.selectedIsFolder ? undefined : tipOf('visual')}
        onclick={() => app.setTab('visual')}
        >Visual{#if app.visualArtifact}<span
            class="has"
            title="This has a visual"
          ></span>{/if}</button
      >
      {#if app.selectedIsFolder}
        <button
          class="tab"
          class:on={app.tab === 'map'}
          onclick={() => app.setTab('map')}
          >Map{#if app.viewArtifact('map')}<span
              class="has"
              title="This folder has a map"
            ></span>{/if}</button
        >
      {:else}
        <button
          class="tab"
          class:on={app.tab === 'film'}
          class:suggested={isSuggested('film')}
          title={tipOf('film')}
          onclick={() => app.setTab('film')}
          >Film{#if app.filmArtifact}<span
              class="has"
              title="This file has a film"
            ></span>{/if}</button
        >
        <button
          class="tab"
          class:on={app.tab === 'steps'}
          class:suggested={isSuggested('steps')}
          title={tipOf('steps')}
          onclick={() => app.setTab('steps')}
          >Step-through{#if app.stepsArtifact}<span
              class="has"
              title="This file has a step-through"
            ></span>{/if}</button
        >
        <button
          class="tab more-views"
          class:on={shownView != null}
          class:suggested={suggestedView != null}
          aria-haspopup="menu"
          title={suggestedView
            ? `Suggested for this file: ${suggestedView.label}. ${app.suggestion?.ranked[0]?.reason ?? ''}`
            : 'The other views of this file: schema, lanes and structure'}
          onclick={(event) => app.openMenu(event, viewMenu())}
          >{shownView ? shownView.label : 'More'} ▾{#if hasFileView}<span
              class="has"
              title="This file has one of these views"
            ></span>{/if}</button
        >
        <button
          class="tab"
          class:on={app.tab === 'source'}
          onclick={() => app.setTab('source')}>Source</button
        >
      {/if}
    </span>
  {:else}
    <span class="crumb">{app.workspace?.name ?? ''}</span>
  {/if}
</div>
