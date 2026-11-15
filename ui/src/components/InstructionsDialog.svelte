<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import { nameOf } from '$lib/tree';

  // The step between clicking Visualise and the job starting: the user says
  // what this result should show. The field may be left empty.
  const ask = $derived(app.instructionsAsk);
  let text = $state(app.instructionsAsk?.initial ?? '');

  // Phrases the user can add with one click. They name aspects of code, not a
  // language.
  const CHIPS = [
    'limits and what happens when they are hit',
    'error paths and cleanup',
    'modes and what switches them',
    'the happy path only',
    'when work is flushed or committed',
    'lifecycle: setup and teardown',
  ];

  const fileName = $derived(nameOf(ask?.subject ?? ''));
  // Set when the subject is a folder: how much code the agent will have to
  // read.
  const folder = $derived(ask?.subject.endsWith('/') ? app.folderInfo : null);

  function add(chip: string) {
    const sentence = 'Emphasise ' + chip + '.';
    text = text.trim() ? text.trim() + ' ' + sentence : sentence;
  }

  function start() {
    if (!ask) return;
    app.startJob({
      kind: ask.kind,
      subject: [ask.subject],
      instructions: text.trim(),
    });
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      start();
    }
  }

  const focus = (el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
</script>

{#if ask}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) app.dialog = null;
    }}
  >
    <div class="dialog" role="dialog" aria-labelledby="instructions-title">
      <h2 id="instructions-title">
        {ask.regenerate ? 'Regenerate the visual of' : 'Visualise'}
        {fileName}
      </h2>
      <p class="lead">
        {#if ask.regenerate}
          A new version will be made from the code as it is now. Change the
          instructions if the last one missed the point.
        {:else if folder}
          The agent reads every code file in this folder and draws how they work
          together. Say what the visual should show, or leave this empty and let
          the agent choose.
        {:else}
          The agent reads this file and draws how it works. Say what the visual
          should show, or leave this empty and let the agent choose.
        {/if}
      </p>
      {#if folder}
        <div class="warn-box">
          <b
            >{folder.files.length} files, about {Math.max(
              1,
              Math.round(folder.estimatedTokens / 1000),
            ).toLocaleString()} thousand tokens.</b
          >
          Reading a whole folder takes longer and uses more of your agent's allowance
          than one file{folder.large ? ', possibly many times more' : ''}.
        </div>
      {/if}
      <div class="field">
        <label for="instructions-text">Instructions (optional)</label>
        <textarea
          id="instructions-text"
          class="input"
          rows="4"
          bind:value={text}
          onkeydown={onKey}
          use:focus
          placeholder="For example: show what happens when the queue is full, and where a failed write is retried"
        ></textarea>
      </div>
      <div class="chips">
        {#each CHIPS as chip}<button
            class="chip"
            type="button"
            onclick={() => add(chip)}>+ {chip}</button
          >{/each}
      </div>
      <div class="foot">
        <span class="pill version"
          >{app.activeAgent ? app.activeAgent.name : 'No agent available'}</span
        >
        <button class="btn" onclick={() => (app.dialog = null)}>Cancel</button>
        <button class="btn primary" disabled={!app.activeAgent} onclick={start}
          >{ask.regenerate
            ? 'Regenerate'
            : folder
              ? 'Visualise the folder'
              : 'Visualise'}</button
        >
      </div>
    </div>
  </div>
{/if}
