<script lang="ts">
  import { FILE_KINDS, VIEWS } from '$lib/artifacts';
  import type { FileKind } from '$lib/ipc';
  import { targetOfArtifact } from '$lib/jobs';
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // What a tab shows for a file or a folder that has no artifact of the
  // tab's kind yet.
  //
  // For a file it is a card of a fixed size, the same on every tab. From
  // top to bottom the card holds:
  //   - the file's name, its path and its facts;
  //   - six small cards of one size, one for each kind of artifact that can
  //     be made of a file (`FILE_KINDS`);
  //   - a note of three lines;
  //   - the button that asks the agent which kind suits the file.
  //
  // A click on a small card opens the dialog that makes that kind. If the
  // file already has that kind, the click opens its tab instead.
  //
  // Asking the agent. The agent answers with the six kinds in order, each
  // with a reason (`app.suggestion`). The small card of the first kind then
  // has the word "suggested" on its top edge and a coloured border. The
  // other small cards stay where they are, and the card keeps its size.
  //
  // The note. While the pointer or the keyboard focus is on a small card,
  // the note shows the agent's reason for that kind, or what the kind is
  // for when the agent was not asked. Otherwise it shows the reason for the
  // suggested kind, or that the agent is being asked, or a hint. Its height
  // is fixed, and a longer text is cut after three lines.
  //
  // For a selected folder, the component shows how much code the folder
  // holds and what a visual of all of it would cost to make.
  const info = $derived(app.fileInfo);
  const folder = $derived(app.folderInfo);
  // The view the open tab is for, when it is one of the four views. Only
  // the card of a folder uses it.
  const view = $derived(VIEWS.find((one) => one.name === app.tab) ?? null);
  // True while a job is making that view of the folder on screen.
  const viewBusy = $derived(
    !!view &&
      !!app.selected &&
      app.isBusy(
        targetOfArtifact({ kind: view.name, subject: [app.selected] }),
      ),
  );
  // True while a job is making the visual of the folder on screen.
  const visualBusy = $derived(
    !!app.selected &&
      app.isBusy(targetOfArtifact({ kind: 'visual', subject: [app.selected] })),
  );
  const noAgent = $derived(app.agentsLoaded && !app.activeAgent);
  const agentName = $derived(app.activeAgent?.name ?? 'the agent');
  // True when no job can be started for the file on screen.
  const blocked = $derived(!info || info.binary || noAgent);

  // The name of the command that makes each kind, and what its small card
  // is called while a job is making it. Screen readers read these names.
  const COMMANDS: Record<FileKind, [string, string]> = {
    visual: ['Visualise', 'Visualising…'],
    film: ['Animate with companions…', 'Animating…'],
    stepthrough: ['Step through…', 'Making the step-through…'],
    schema: ['Make the schema view…', 'Making the schema…'],
    lanes: ['Make the lanes view…', 'Making the lanes…'],
    structure: ['Make the structure view…', 'Making the structure…'],
  };

  // The six small cards. Each is a kind with what is known about it for the
  // file on screen: whether the file has it, whether a job is making it,
  // whether the agent put it first, and the agent's reason for it.
  const options = $derived(
    FILE_KINDS.map((kind) => {
      const made = app.artifactOfKind(kind.kind) != null;
      const busy =
        !!app.selected &&
        app.isBusy(
          targetOfArtifact({ kind: kind.kind, subject: [app.selected] }),
        );
      return {
        ...kind,
        made,
        busy,
        suggested: app.suggestedKind === kind.kind,
        reason:
          app.suggestion?.ranked.find((one) => one.kind === kind.kind)
            ?.reason ?? '',
        command: made
          ? `Show the ${kind.label.toLowerCase()}`
          : COMMANDS[kind.kind][busy ? 1 : 0],
      };
    }),
  );

  function choose(option: (typeof options)[number]) {
    if (option.made) app.setTab(option.tab);
    else if (option.kind === 'visual') app.askInstructions();
    else if (option.kind === 'film') app.askAnimate();
    else if (option.kind === 'stepthrough')
      app.askInstructions(false, 'stepthrough');
    else app.askInstructions(false, 'view', option.kind);
  }

  // The kind whose small card the pointer or the keyboard focus is on.
  let pointed = $state<FileKind | null>(null);

  // What the note says: an optional heading and a text. `warn` is true for
  // a text that says why nothing can be made.
  const note = $derived.by(() => {
    const option = options.find((one) => one.kind === pointed);
    if (option)
      return {
        head: option.reason
          ? `${option.label}, as ${app.suggestion?.agent} sees it`
          : option.label,
        text: option.reason || option.about,
        warn: false,
      };
    if (noAgent)
      return {
        head: '',
        text:
          app.agents.find((a) => a.note)?.note ??
          'No agent was found on this machine.',
        warn: true,
      };
    if (app.suggesting)
      return {
        head: '',
        text: `Asking ${agentName} which view fits this file. That takes a few seconds.`,
        warn: false,
      };
    const first = options.find((one) => one.suggested);
    if (first)
      return {
        head: `Suggested: ${first.label}`,
        text: first.reason,
        warn: false,
      };
    return {
      head: '',
      text: `Point at a view to read what it is for. ${app.activeAgent?.name ?? 'The agent'} can also read the file and say which view fits it.`,
      warn: false,
    };
  });

  // The file's name as soon as a file is selected, before its facts have
  // been read.
  const fileName = $derived(info?.name ?? app.selected?.split('/').pop() ?? '');
  // An estimate in thousands of tokens, as "about 12 thousand tokens".
  const tokens = (n: number) =>
    n < 1000
      ? 'under a thousand tokens'
      : `about ${Math.round(n / 1000).toLocaleString()} thousand tokens`;
</script>

<!-- The button that starts the view the open tab is for, on the card of a
     folder. `off` is true when no job can be started for the folder. -->
{#snippet makeView(off: boolean)}
  {#if view}
    <button
      class="btn primary"
      disabled={off || viewBusy}
      onclick={() => app.askInstructions(false, 'view', view.name)}
    >
      {#if viewBusy}Making the {view.label.toLowerCase()}…{:else}<Icon
          name="viz"
          size={16}
        />{view.name === 'map'
          ? 'Map this folder…'
          : `Make the ${view.label.toLowerCase()} view…`}{/if}
    </button>
  {/if}
{/snippet}

<div class="empty">
  <div class="card" class:file-card={!app.selectedIsFolder}>
    {#if app.selectedIsFolder}
      <span class="empty-icon"><Icon name="dir" size={34} /></span>
      {#if folder}
        <div class="fname">{folder.name}/</div>
        <div class="path">{folder.relPath}/</div>
        <div class="meta">
          <span
            >{folder.files.length} code file{folder.files.length === 1
              ? ''
              : 's'}</span
          ><span>·</span>
          <span>{tokens(folder.estimatedTokens)}</span>
        </div>
        <div class="actions">
          {#if view}
            {@render makeView(
              folder.tooLarge || folder.files.length === 0 || noAgent,
            )}
          {:else if visualBusy}
            <button class="btn" disabled>Visualising…</button>
          {:else}
            <button
              class="btn primary"
              disabled={folder.tooLarge || folder.files.length === 0 || noAgent}
              onclick={() => app.askInstructions()}
              ><Icon name="viz" size={16} />Visualise this folder…</button
            >
          {/if}
        </div>
        {#if folder.files.length === 0}
          <div class="hint warn">This folder holds no code files.</div>
        {:else if folder.tooLarge}
          <div class="warn-box">
            <b>This folder is too large to draw as one blueprint.</b> An agent
            cannot read {folder.files.length} files, {tokens(
              folder.estimatedTokens,
            )}, at once. Choose a folder inside it, or visualise single files.
          </div>
        {:else}
          <div class="warn-box">
            <b
              >{folder.large
                ? 'This is a large folder.'
                : 'A folder costs more than a file.'}</b
            >
            The agent reads all {folder.files.length} files, {tokens(
              folder.estimatedTokens,
            )}, before it draws. That takes longer and uses more of your agent's
            allowance than one file{folder.large
              ? ', possibly many times more'
              : ''}.
          </div>
        {/if}
        {#if noAgent}<div class="hint warn">
            {app.agents.find((a) => a.note)?.note ??
              'No agent was found on this machine.'}
          </div>{/if}
        <div class="hint">
          {#if view}
            {view.about}
          {:else}
            A folder's blueprint shows how its files work together, not the
            inside of each one.
          {/if}
        </div>
      {:else}
        <div class="path">Reading…</div>
      {/if}
    {:else}
      <div class="fname">{fileName}</div>
      <div class="path">{info?.relPath ?? app.selected ?? ''}</div>
      <div class="meta">
        {#if info}
          <span>{info.lang ?? 'Unknown type'}</span><span>·</span>
          <span
            >{info.binary
              ? 'binary file'
              : info.lines != null
                ? `${info.lines.toLocaleString()} lines`
                : 'very large file'}</span
          >
        {:else}
          <span>Reading…</span>
        {/if}
      </div>
      <div class="picks">
        {#each options as option (option.kind)}
          <button
            class="pick"
            class:suggested={option.suggested}
            class:made={option.made}
            aria-label={option.command}
            disabled={option.busy || (!option.made && blocked)}
            onclick={() => choose(option)}
            onpointerenter={() => (pointed = option.kind)}
            onpointerleave={() => (pointed = null)}
            onfocus={() => (pointed = option.kind)}
            onblur={() => (pointed = null)}
          >
            {#if option.suggested}<span class="pick-tag">suggested</span>{/if}
            <span class="pick-name"
              >{option.label}{#if option.made}<span class="pick-made">made</span
                >{:else if option.busy}<span class="pick-made">making…</span
                >{/if}</span
            >
            <span class="pick-about">{option.short}</span>
          </button>
        {/each}
      </div>
      <div class="pick-note" class:warn={note.warn} aria-live="polite">
        {#if note.head}<b>{note.head}.</b>{/if}
        {note.text}
      </div>
      <button
        class="btn small"
        disabled={blocked || app.suggesting}
        onclick={() => app.askSuggestion()}
        >{app.suggesting
          ? `Asking ${agentName}…`
          : app.suggestion
            ? `Ask ${agentName} again`
            : 'Which view fits this file?'}</button
      >
      <div class="hint">
        Output is saved in <code>{app.info?.dotDir ?? '.codjiva'}/</code> as plain
        HTML.
      </div>
    {/if}
  </div>
</div>
