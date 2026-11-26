<script lang="ts">
  import { FILE_KINDS, isStepped, kindWord, showsFilm } from '$lib/artifacts';
  import {
    asMade,
    sameScope,
    scopeLines,
    scopeTitle,
    type ShownNote,
    type Target,
  } from '$lib/discuss';
  import { api, type ArtifactDetail, type FileKind } from '$lib/ipc';
  import { formatTime } from '$lib/tree';
  import { app, type MenuItem } from '$lib/state/app.svelte';
  import { discuss } from '$lib/state/discuss.svelte';
  import AskPanel from './AskPanel.svelte';
  import FilmPlayer from './FilmPlayer.svelte';
  import VisualFrame from './VisualFrame.svelte';

  // The section of the panel beside the source view that is about selected
  // code. SourcePanel.svelte holds it.
  //
  // While no part of the file is open (`app.scope` is null), it lists the
  // parts of the file that have a discussion or a visual. A click on one
  // opens it.
  //
  // While a part is open, it shows from top to bottom:
  //   - the lines the part is on, and a sentence when its code has changed
  //     since the discussion or the visual was made;
  //   - one button for each visual that was made of the part, and a button
  //     that makes one of another kind;
  //   - the visual that is chosen, in a frame. A click on a part of it shows
  //     the code of that part in the source view. A film has its transport
  //     bar under the frame;
  //   - the discussion about the part (AskPanel.svelte). A question is sent
  //     with the part of the visual that is selected, and an answer can put
  //     notes on the visual.
  //
  // The frame is as wide as the panel, which the user can drag as wide as
  // the window allows. The button in the section's heading shows the visual
  // in the editor area instead (`app.openSpotlight`).
  //
  // The height of the frame. The frame and the discussion share the height
  // of the section. The frame is never taller than its width allows for the
  // shape of the stage (`frameMax`), and the discussion gets what is left.
  // In a low section both shrink to a least height, and below that the
  // section scrolls.
  const path = $derived(app.selected ?? '');
  const scopes = $derived(discuss.scopesIn(path));
  const scope = $derived(app.scope);
  const now = $derived(
    scope
      ? (scopes.find((one) => sameScope(one.scope, scope))?.now ??
          asMade(scope))
      : null,
  );
  const made = $derived(scope ? app.scopeArtifacts(scope) : []);
  const shown = $derived(
    made.find((one) => one.id === app.scopeArtifactId) ?? null,
  );
  const isFilm = $derived(showsFilm(shown));

  // The width of the section, which the page reports as it changes.
  let width = $state(0);
  // The height of the transport bar under a film.
  const PLAYER_HEIGHT = 57;
  // The tallest the frame may be, in pixels. The stage is 16 to 9. A visual
  // that is played step by step has a strip of panels under its drawing, so
  // its frame may be as tall as 4 to 3. A film has its transport bar under
  // the stage.
  const frameMax = $derived(
    Math.round(width * (isStepped(shown?.kind) ? 3 / 4 : 9 / 16)) +
      (isFilm ? PLAYER_HEIGHT : 0),
  );

  // The details of the visual in the frame: its parts and the runtime it
  // was built with. They are read again when another visual or another
  // version of it is shown.
  let detail = $state<ArtifactDetail | null>(null);
  $effect(() => {
    const id = shown?.id;
    const version = shown?.currentVersion;
    detail = null;
    if (!id || version == null) return;
    let cancelled = false;
    api
      .artifactDetail(id, version)
      .then((read) => {
        if (!cancelled) detail = read;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });
  const nodes = $derived(detail?.definition?.nodes ?? []);
  // The part of the visual the user clicked, or null. Another visual has
  // other parts, so the choice is dropped when the visual changes.
  let nodeId = $state<string | null>(null);
  $effect(() => {
    void shown?.id;
    nodeId = null;
  });
  const node = $derived(nodes.find((one) => one.id === nodeId) ?? null);

  // A click on a part of the visual shows the first line of that part's code
  // in the source view, when the code is in the file on screen.
  function selectNode(id: string | null) {
    nodeId = id;
    const place = nodes.find((one) => one.id === id)?.refs?.[0];
    if (place && place.path === path) app.selectFile(path, place.line);
  }

  const target = $derived<Target | null>(
    scope
      ? { path, scope, artifact: shown, version: shown?.currentVersion }
      : null,
  );
  const thread = $derived(target ? discuss.shown(target) : null);
  const about = $derived(
    isFilm && app.filmMoment
      ? { time: app.filmMoment.t, chapter: app.filmMoment.chapterTitle }
      : nodeId
        ? { part: nodeId }
        : {},
  );
  const aboutLabel = $derived(
    isFilm && app.filmMoment
      ? `at ${formatTime(app.filmMoment.t)}`
      : (node?.label ?? null),
  );

  function showNote(note: ShownNote) {
    if (note.time != null) {
      app.frameSend?.({ cj: 'pause' });
      app.frameSend?.({ cj: 'seek', t: note.time + 0.05 });
      return;
    }
    if (note.part) {
      nodeId = note.part;
      app.frameSend?.({ cj: 'select', nodeId: note.part });
    }
    app.frameSend?.({ cj: 'note', id: note.id });
  }

  // The menu of the button that makes a visual of the open part: one command
  // for each kind. A kind the part already has is made again, as a new
  // version.
  const kindMenu = (): MenuItem[] =>
    FILE_KINDS.map((kind) => ({
      label: kind.label,
      detail: kind.about,
      mark: made.some((one) => one.kind === kind.kind) ? 'made' : '',
      disabled: !app.activeAgent,
      action: () => make(kind.kind),
    }));
  function make(kind: FileKind) {
    if (scope) app.askScoped(scope, kind, thread?.id);
  }

  const STATE: Record<string, string> = {
    moved: '',
    same: '',
    changed:
      'This code has changed since the discussion or the visual was made.',
    lost: 'This code is no longer in the file as it was. The lines below are where it used to be.',
  };
  const labelOf = (kind: string) =>
    FILE_KINDS.find((one) => one.kind === kind)?.label ?? kind;
</script>

{#if scope && now && target}
  <div class="scope-open" bind:clientWidth={width}>
    <p class="scope-where">
      <button
        class="ref inline"
        title="Show these lines in the code"
        onclick={() => app.selectFile(path, now.startLine)}
        >{now.startLine === now.endLine ? 'Line' : 'Lines'}
        {scopeLines(scope, now)}</button
      >
      {#if STATE[now.state]}<span class="scope-state">{STATE[now.state]}</span
        >{/if}
    </p>
    <div class="scope-kinds">
      {#each made as one (one.id)}
        <button
          class="chip"
          class:on={one.id === shown?.id}
          aria-pressed={one.id === shown?.id}
          onclick={() =>
            (app.scopeArtifactId = one.id === shown?.id ? null : one.id)}
          >{labelOf(one.kind)} · v{one.currentVersion}{#if one.stale}<span
              class="stale"
              title="The code of this part changed after this version was made"
            >
              stale</span
            >{/if}</button
        >
      {/each}
      <button
        class="chip make"
        aria-haspopup="menu"
        title={app.activeAgent ? undefined : 'No agent is available'}
        onclick={(event) => app.openMenuBelow(event.currentTarget, kindMenu())}
        >{made.length ? 'Another visual' : 'Visualise'} ▾</button
      >
    </div>
    {#if shown}
      <div class="scope-frame" style:max-height="{frameMax}px">
        {#key `${shown.id}/${shown.currentVersion}`}
          {#if isFilm}
            <FilmPlayer
              src={api.artifactUrl(
                `artifact/${shown.id}/${shown.currentVersion}`,
              ) + '?embed=1'}
              title={shown.title}
              artifactId={shown.id}
              feedback
            />
          {:else}
            <VisualFrame
              src={api.artifactUrl(
                `artifact/${shown.id}/${shown.currentVersion}`,
              ) + '?embed=1'}
              title={shown.title}
              steps={isStepped(shown.kind)}
              artifactId={shown.id}
              onselect={selectNode}
            />
          {/if}
        {/key}
      </div>
      {#if node}
        <p class="scope-node"><b>{node.label}</b> {node.role}</p>
      {/if}
      {#if shown.stale}
        <p class="muted">
          The code of this part changed after this {kindWord(shown)} was made.
          <button
            class="btn small"
            disabled={!app.activeAgent}
            onclick={() => make(shown.kind as FileKind)}>Regenerate…</button
          >
        </p>
      {/if}
    {/if}
    <AskPanel
      {target}
      {about}
      {aboutLabel}
      {nodes}
      runtimeVersion={shown ? (detail?.manifest.runtimeVersion ?? null) : null}
      onnote={showNote}
      focus={app.scopeFocus}
    />
  </div>
{:else}
  <div class="scope-list">
    {#each scopes as one (one.scope.id)}
      <button
        class="nav-row scope-row"
        class:lost={one.now.state === 'lost'}
        onclick={() => app.openScope(one.scope)}
      >
        <span class="nav-where"
          >{scopeTitle(one.scope, one.now)}
          <span class="muted"
            >{one.scope.symbol
              ? `· lines ${scopeLines(one.scope, one.now)}`
              : ''}</span
          ></span
        >
        <span class="muted"
          >{[
            one.threads.length
              ? `${one.threads.length} discussion${one.threads.length === 1 ? '' : 's'}`
              : '',
            ...one.artifacts.map((made) => labelOf(made.kind).toLowerCase()),
          ]
            .filter(Boolean)
            .join(' · ')}</span
        >
      </button>
    {:else}
      <p class="muted">
        Select code in the file to discuss it, or to make a visual of just that
        code.
      </p>
    {/each}
  </div>
{/if}
