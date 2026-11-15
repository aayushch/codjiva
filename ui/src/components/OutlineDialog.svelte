<script lang="ts">
  import type { OutlineChapter } from '$lib/ipc';
  import { app } from '$lib/state/app.svelte';

  // Lets the user change the outline of the film that is being made: reword,
  // reorder or remove chapters, and change the instructions. Confirming cancels
  // the running job and starts the film again, with the agent told to follow
  // this outline exactly.
  const job = $derived(app.job);
  // A copy to edit. The job's own outline is not changed until the user
  // confirms.
  let chapters = $state<OutlineChapter[]>(
    JSON.parse(JSON.stringify(app.job?.outline?.chapters ?? [])),
  );
  let instructions = $state(app.job?.request.instructions ?? '');

  // An outline needs at least two chapters: an overview and one that follows
  // the work.
  const MIN_CHAPTERS = 2;

  function move(index: number, by: number) {
    const to = index + by;
    if (to < 0 || to >= chapters.length) return;
    const next = [...chapters];
    [next[index], next[to]] = [next[to], next[index]];
    chapters = next;
  }

  function remove(index: number) {
    chapters = chapters.filter((_, i) => i !== index);
  }

  function confirm() {
    const outline = app.job?.outline;
    if (!outline) return;
    app.restartWithOutline(
      {
        ...outline,
        chapters: chapters.map((c) => ({
          ...c,
          title: c.title.trim(),
          summary: c.summary.trim(),
        })),
      },
      instructions.trim(),
    );
  }

  const valid = $derived(
    chapters.length >= MIN_CHAPTERS &&
      chapters.every((c) => c.title.trim() && c.summary.trim()),
  );
</script>

{#if job?.outline}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) app.dialog = null;
    }}
  >
    <div class="dialog outline" role="dialog" aria-labelledby="outline-title">
      <h2 id="outline-title">Change the outline</h2>
      <p class="lead">
        {job.status === 'running'
          ? 'The film that is being made now will be stopped, and a new one is started that follows this outline exactly.'
          : 'A new version of the film is made that follows this outline exactly.'}
      </p>
      {#each chapters as chapter, i (chapter.id)}
        <div class="chapter">
          <span class="n">{i + 1}</span>
          <div class="fields">
            <input
              class="input"
              aria-label="Title of chapter {i + 1}"
              bind:value={chapter.title}
              spellcheck="false"
            />
            <input
              class="input"
              aria-label="Summary of chapter {i + 1}"
              bind:value={chapter.summary}
            />
          </div>
          <div class="moves">
            <button
              class="tb-btn"
              aria-label="Move chapter {i + 1} up"
              title="Move up"
              disabled={i === 0}
              onclick={() => move(i, -1)}>↑</button
            >
            <button
              class="tb-btn"
              aria-label="Move chapter {i + 1} down"
              title="Move down"
              disabled={i === chapters.length - 1}
              onclick={() => move(i, 1)}>↓</button
            >
            <button
              class="tb-btn"
              aria-label="Remove chapter {i + 1}"
              title="Remove"
              disabled={chapters.length <= MIN_CHAPTERS}
              onclick={() => remove(i)}>✕</button
            >
          </div>
        </div>
      {/each}
      <div class="field">
        <label for="outline-instructions">What the film should show</label>
        <textarea
          id="outline-instructions"
          class="input"
          rows="2"
          bind:value={instructions}
          placeholder="Add or change your instructions for the new film"
        ></textarea>
      </div>
      <div class="foot">
        <button class="btn" onclick={() => (app.dialog = null)}
          >Keep the outline as it is</button
        >
        <button class="btn primary" disabled={!valid} onclick={confirm}
          >Make the film with this outline</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .chapter {
    display: grid;
    grid-template-columns: 20px 1fr auto;
    gap: 10px;
    align-items: start;
    padding: 8px 0;
    border-bottom: 1px solid var(--shell-border-soft);
  }
  .n {
    color: var(--accent);
    padding-top: 8px;
    text-align: right;
  }
  .fields {
    display: grid;
    gap: 6px;
  }
  .fields .input {
    width: 100%;
  }
  .fields .input:first-child {
    color: var(--second);
  }
  .moves {
    display: flex;
    gap: 2px;
    padding-top: 4px;
  }
  .moves .tb-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
