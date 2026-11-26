<script lang="ts">
  import { FILE_KINDS, isView, showsFilm } from '$lib/artifacts';
  import { targetOfArtifact } from '$lib/jobs';
  import { api } from '$lib/ipc';
  import { app, type MenuItem } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // The bar above the editor area and the inspector. From left to right it
  // holds the Back and Forward buttons, the path of what is selected with a
  // button that copies it, the controls of the artifact on screen, and the
  // controls that choose what the editor area shows. Those are last so that
  // they stay at the right end of the bar, in the same place whether or not
  // the selected file has an artifact to show controls for.
  //
  // What the editor area shows for a file. A file has two controls at the
  // right end of the bar.
  //   - The first is a button labelled "Visuals" that opens a menu. The menu
  //     has one command for each kind of artifact that can be made of a file
  //     (`FILE_KINDS`): Blueprint, Film, Step-through, Schema, Lanes and
  //     Structure. Choosing one shows that kind. While an artifact of the
  //     file is on screen, the button has the name of its kind in place of
  //     "Visuals".
  //   - The second is a button with an icon of source code. It shows the
  //     source of the file. Its label, "Source", appears while the pointer is
  //     on it.
  //
  // A folder has no source view. It has two tabs, Blueprint and Map.
  //
  // Which kind to use for a file. The user can ask the agent which kind of
  // artifact suits the file (`app.askSuggestion`). The "Visuals" button is
  // then underlined, and the command of the kind the agent put first has the
  // word "suggested". The last command of the menu asks the agent.
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

  // The kind of the artifact on screen, when the editor area shows an
  // artifact of the selected file. It is null while the source is showing,
  // and while the card that offers to make an artifact is showing.
  const shownKind = $derived(
    artifact && app.tab !== 'source'
      ? (FILE_KINDS.find((kind) => kind.tab === app.tab) ?? null)
      : null,
  );
  // True when the selected file has an artifact of at least one kind.
  const hasAnyKind = $derived(
    FILE_KINDS.some((kind) => app.artifactOfKind(kind.kind) != null),
  );
  // The kind that the agent put first for the selected file, with the
  // agent's reason for it. Null when the agent has not been asked.
  const suggested = $derived.by(() => {
    const first = app.suggestion?.ranked[0];
    const kind = FILE_KINDS.find((one) => one.kind === first?.kind);
    return kind && first ? { ...kind, reason: first.reason } : null;
  });
  // The menu of the "Visuals" button. It has one command per kind of
  // artifact. The sentence on what the kind is for is the command's `detail`,
  // which the menu shows while the pointer is on the command. For the kind
  // the agent put first, the agent's reason comes before that sentence. A
  // command has the word "suggested" when the agent put its kind first, and
  // the word "made" when the file has an artifact of its kind. The last
  // command asks the agent which kind suits the file. It is disabled while no
  // agent is available and while the agent is answering.
  const kindMenu = (): MenuItem[] => [
    ...FILE_KINDS.map((kind) => ({
      label: kind.label,
      detail:
        suggested?.kind === kind.kind
          ? `Suggested for this file. ${suggested.reason}\n\n${kind.about}`
          : kind.about,
      mark: [
        suggested?.kind === kind.kind ? 'suggested' : '',
        app.artifactOfKind(kind.kind) ? 'made' : '',
      ]
        .filter(Boolean)
        .join(' · '),
      action: () => app.setTab(kind.tab),
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
  // A blueprint or a step-through of a single file can be turned into a film. A
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
        class="tb-btn tip-end"
        data-tip="Open in the browser"
        aria-label="Open in browser"
        onclick={() =>
          api
            .artifactOpenInBrowser(artifact.id, version)
            .catch((e) => app.fail(e))}
        ><Icon name="external" size={16} /></button
      >
      <button
        class="tb-btn tip-end"
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
          : 'Handler.Submit, a still blueprint'}</b
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
        onclick={() => (app.example = 'visual')}>Blueprint</button
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
      {#if app.selectedIsFolder}
        <button
          class="tab"
          class:on={app.tab === 'visual'}
          onclick={() => app.setTab('visual')}
          >Blueprint{#if app.visualArtifact}<span
              class="has"
              title="This folder has a blueprint"
            ></span>{/if}</button
        >
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
          class="tab kinds"
          class:on={app.tab !== 'source'}
          class:suggested={suggested != null}
          aria-haspopup="menu"
          title={suggested
            ? `Suggested for this file: ${suggested.label}. ${suggested.reason}`
            : undefined}
          onclick={(event) =>
            app.openMenuBelow(event.currentTarget, kindMenu())}
          >{shownKind ? shownKind.label : 'Visuals'} ▾{#if hasAnyKind}<span
              class="has"
              title="This file has at least one of these"
            ></span>{/if}</button
        >
        <button
          class="tab source-tab tip-end"
          class:on={app.tab === 'source'}
          data-tip="Source"
          aria-label="Source"
          onclick={() => app.setTab('source')}
          ><Icon name="code" size={16} /></button
        >
      {/if}
    </span>
  {:else}
    <span class="crumb">{app.workspace?.name ?? ''}</span>
  {/if}
</div>
