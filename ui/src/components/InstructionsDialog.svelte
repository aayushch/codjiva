<script lang="ts">
  import { VIEWS } from '$lib/artifacts';
  import { app } from '$lib/state/app.svelte';
  import { nameOf } from '$lib/tree';
  import JobEstimate from './JobEstimate.svelte';

  // The step between clicking Visualise or Step through and the job starting:
  // the user says what this result should show. The field may be left empty.
  const ask = $derived(app.instructionsAsk);
  let text = $state(app.instructionsAsk?.initial ?? '');
  // True when the job that starts is a step-through and not a visual.
  const steps = $derived(ask?.kind === 'stepthrough');
  // The view the job makes, when it makes one of the four views: its name,
  // the name it is shown under and the sentence that says what it is for.
  const view = $derived(
    ask?.kind === 'view'
      ? (VIEWS.find((one) => one.name === ask.view) ?? null)
      : null,
  );

  // Phrases the user can add with one click. They name aspects of code, not a
  // language. A step-through has its own, because it is about what the code
  // does with one input and not about its overall structure.
  const VISUAL_CHIPS = [
    'limits and what happens when they are hit',
    'error paths and cleanup',
    'modes and what switches them',
    'the happy path only',
    'when work is flushed or committed',
    'lifecycle: setup and teardown',
  ];
  const STEP_CHIPS = [
    'malformed input and how it is handled',
    'every fallback and what triggers it',
    'the edge cases of each state',
    'what each variable is for',
    'examples taken from the tests',
  ];
  // What is worth asking of each view.
  const VIEW_CHIPS: Record<string, string[]> = {
    schema: [
      'where each field gets its value',
      'the types only, without who uses them',
      'fields that are never reset',
    ],
    lanes: [
      'what happens when a call fails',
      'timeouts and retries',
      'what runs at the same time',
      'the usual run only',
    ],
    structure: [
      'the point where it grows or rebalances',
      'examples taken from the tests',
      'what happens when it is full',
    ],
    map: [
      'the entry points',
      'what talks to the outside',
      'which parts depend on which',
    ],
  };
  const CHIPS = $derived(
    view ? VIEW_CHIPS[view.name] : steps ? STEP_CHIPS : VISUAL_CHIPS,
  );

  const fileName = $derived(nameOf(ask?.subject ?? ''));
  // Set when the subject is a folder: how much code the agent will have to
  // read.
  const folder = $derived(ask?.subject.endsWith('/') ? app.folderInfo : null);

  // The job as it would start now, without the instructions, for the line
  // that says how long the visual usually takes to make.
  const planned = $derived(
    ask ? { kind: ask.kind, view: ask.view, subject: [ask.subject] } : null,
  );

  function add(chip: string) {
    const sentence = 'Emphasise ' + chip + '.';
    text = text.trim() ? text.trim() + ' ' + sentence : sentence;
  }

  function start() {
    if (!ask) return;
    app.startJob({
      kind: ask.kind,
      view: ask.view,
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
        {#if view}
          {ask.regenerate ? 'Regenerate the' : 'Make the'}
          {view.name === 'map' ? 'map' : view.label.toLowerCase() + ' view'} of
        {:else if steps}
          {ask.regenerate ? 'Regenerate the step-through of' : 'Step through'}
        {:else}
          {ask.regenerate ? 'Regenerate the blueprint of' : 'Visualise'}
        {/if}
        {fileName}
      </h2>
      <p class="lead">
        {#if view}
          {view.about} The agent reads the code and writes the data, and Codjiva lays
          it out and draws it. Say what matters most, or leave this empty for all
          of it.
        {:else if steps}
          The agent reads this file, draws its states and writes a step function
          that restates the code. You can then run the code on any input, one
          step at a time. Say which input or which behaviour matters most, or
          leave this empty and let the agent choose.
        {:else if ask.regenerate}
          A new version will be made from the code as it is now. Change the
          instructions if the last one missed the point.
        {:else if folder}
          The agent reads every code file in this folder and draws how they work
          together. Say what the blueprint should show, or leave this empty and
          let the agent choose.
        {:else}
          The agent reads this file and draws how it works. Say what the
          blueprint should show, or leave this empty and let the agent choose.
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
          placeholder={view
            ? 'For example: ' + CHIPS[0]
            : steps
              ? 'For example: step through the orders of one customer, with an example for every limit'
              : 'For example: show what happens when the queue is full, and where a failed write is retried'}
        ></textarea>
      </div>
      <div class="chips">
        {#each CHIPS as chip}<button
            class="chip"
            type="button"
            onclick={() => add(chip)}>+ {chip}</button
          >{/each}
      </div>
      <JobEstimate request={planned} />
      <div class="foot">
        <span class="pill version"
          >{app.activeAgent ? app.activeAgent.name : 'No agent available'}</span
        >
        <button class="btn" onclick={() => (app.dialog = null)}>Cancel</button>
        <button class="btn primary" disabled={!app.activeAgent} onclick={start}
          >{ask.regenerate
            ? 'Regenerate'
            : view
              ? view.name === 'map'
                ? 'Make the map'
                : 'Make the view'
              : steps
                ? 'Step through'
                : folder
                  ? 'Visualise the folder'
                  : 'Visualise'}</button
        >
      </div>
    </div>
  </div>
{/if}
