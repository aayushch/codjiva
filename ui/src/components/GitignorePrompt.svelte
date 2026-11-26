<script lang="ts">
  import { app } from '$lib/state/app.svelte';

  // The question that is asked before the first job of a workspace: whether
  // to add the folder Codjiva saves its work in to the repository's
  // .gitignore. It has four answers.
  //   - "Add" adds the folder to .gitignore.
  //   - "Keep tracked" leaves .gitignore as it is and records that the
  //     folder is to be committed.
  //   - "Ask later" records nothing. The question is asked again before the
  //     next job.
  //   - "Do not ask again" leaves .gitignore as it is and stops the question
  //     for this workspace. Other workspaces still ask.
  const dot = $derived(app.info?.dotDir ?? '.codjiva');
</script>

<div class="scrim" role="presentation">
  <div class="dialog" role="dialog" aria-labelledby="gitignore-title">
    <h2 id="gitignore-title">Add <code>{dot}/</code> to .gitignore?</h2>
    <p class="lead">
      Codjiva saves the blueprints and films it makes in a <code>{dot}/</code> folder
      in this workspace. Ignore it to keep them on this machine, or keep it tracked
      to share them with your team through the repository.
    </p>
    <div class="foot">
      <button class="never" onclick={() => app.answerGitignore('never')}
        >Do not ask again</button
      >
      <button class="btn" onclick={() => app.answerGitignore('later')}
        >Ask later</button
      >
      <button class="btn" onclick={() => app.answerGitignore('track')}
        >Keep tracked (share with team)</button
      >
      <button class="btn primary" onclick={() => app.answerGitignore('add')}
        >Add</button
      >
    </div>
  </div>
</div>

<style>
  /* "Do not ask again" is plain text at the left end of the row of buttons.
     The other three answers stay at the right end. */
  .never {
    margin-right: auto;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: 12px;
    color: var(--shell-text-2);
    white-space: nowrap;
    cursor: pointer;
  }
  .never:hover {
    color: var(--second);
    text-decoration: underline;
  }
</style>
