<script lang="ts">
  import { app } from '$lib/state/app.svelte';

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
