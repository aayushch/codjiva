<script lang="ts">
  import { showsFilm } from '$lib/artifacts';
  import { formatTime } from '$lib/tree';
  import { app } from '$lib/state/app.svelte';

  // The feedback box in the inspector. The user writes what should change in
  // the version on screen. Sending it starts a job that makes a new version
  // with only that change.
  //
  // What the user is looking at is attached without them typing it: the moment
  // of the film (or the moment they pinned on the scrubber), the part selected
  // in a visual, and the element they pointed at with "Point at…".
  let text = $state('');
  const artifact = $derived(app.currentArtifact);
  const isFilm = $derived(showsFilm(artifact));
  const running = $derived(app.job?.status === 'running');
  const moment = $derived(app.filmMoment);
  const selectedLabel = $derived(
    app.detail?.definition?.nodes?.find((n) => n.id === app.selectedNode)
      ?.label ?? null,
  );
  const pickedLabel = $derived(
    app.picked
      ? app.picked.text?.trim() ||
          app.picked.part ||
          app.picked.selector ||
          'an element'
      : null,
  );

  async function send() {
    const words = text.trim();
    if (!words) return;
    text = '';
    await app.sendFeedback(words);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  }
</script>

<div class="feedback">
  <div class="kicker">Feedback</div>
  <textarea
    class="input"
    rows="3"
    bind:value={text}
    onkeydown={onKey}
    aria-label="Feedback"
    placeholder={isFilm
      ? 'What should change? For example: the bubble covers the gauge here'
      : 'What should change? For example: this label is cut off'}></textarea>
  <div class="attached">
    {#if isFilm && app.pinnedTime != null}
      <span class="pill"
        >pinned at {formatTime(app.pinnedTime)}<button
          aria-label="Remove the pinned moment"
          onclick={() => (app.pinnedTime = null)}>✕</button
        ></span
      >
    {:else if isFilm && moment}
      <span class="pill" title={moment.chapterTitle}
        >at {formatTime(moment.t)} · chapter {moment.chapter + 1}</span
      >
    {/if}
    {#if !isFilm && selectedLabel}<span class="pill" title="The selected part"
        >{selectedLabel}</span
      >{/if}
    {#if pickedLabel}
      <span class="pill" title={app.picked?.selector ?? ''}
        >points at: {pickedLabel}<button
          aria-label="Remove the pointed-at element"
          onclick={() => (app.picked = null)}>✕</button
        ></span
      >
    {/if}
  </div>
  {#if app.picking}<div class="picking">
      Click the element in the {isFilm ? 'film' : 'visual'} that your feedback is
      about.
    </div>{/if}
  <div class="line">
    {#if app.picking}
      <button class="btn small" onclick={() => app.cancelPick()}
        >Stop pointing</button
      >
    {:else}
      <button class="btn small" onclick={() => app.startPick()}
        >Point at…</button
      >
    {/if}
    <button
      class="btn small primary"
      disabled={!text.trim() || running || !app.activeAgent}
      onclick={send}>Send feedback</button
    >
  </div>
  <p class="muted">
    A new version is made with only this change. The version on screen is kept.{isFilm
      ? ' Hold Alt and click the scrubber to pin a moment.'
      : ''}
  </p>
</div>
