<script lang="ts">
  import { api, type Estimate, type JobRequest } from '$lib/ipc';
  import { formatEstimate } from '$lib/jobs';
  import { app } from '$lib/state/app.svelte';

  // One line in a dialog that starts a job. It says how long the job the
  // dialog is about to start usually takes. `request` is that job as the
  // dialog would start it now, or null while the dialog cannot say yet.
  //
  // The line is asked for again whenever `request` changes, for example when
  // the user picks another film length or ticks another companion file. It
  // stays empty when no agent is available or the estimate cannot be made.
  let { request }: { request: JobRequest | null } = $props();

  // The app waits this long after the last change before it asks, so that
  // ticking several boxes in a row asks once.
  const ASK_AFTER_MS = 200;

  let estimate = $state<Estimate | null>(null);

  // The request as text. The effect below depends on this text, so it runs
  // again when a value in the request changes and not when the dialog only
  // builds an equal request again.
  const wanted = $derived(request ? JSON.stringify(request) : null);

  $effect(() => {
    const text = wanted;
    if (!text) {
      estimate = null;
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      api
        .jobEstimate(JSON.parse(text))
        .then((found) => {
          if (!stale) estimate = found;
        })
        .catch(() => {
          if (!stale) estimate = null;
        });
    }, ASK_AFTER_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  const agent = $derived(app.activeAgent?.name ?? 'this agent');
</script>

{#if estimate}
  <div class="estimate" role="status">
    <b>Usually takes {formatEstimate(estimate)} to make.</b>
    {#if estimate.samples > 0}
      Going by {estimate.samples === 1
        ? 'one earlier job'
        : `${estimate.samples} earlier jobs`} with {agent} on this computer.
    {:else}
      A first estimate from the size of the code and how much it branches. It
      gets closer with every job you run.
    {/if}
  </div>
{/if}

<style>
  .estimate {
    font-size: 11px;
    line-height: 1.5;
    color: var(--muted);
    margin-top: 8px;
  }
  .estimate b {
    font-weight: 600;
    color: var(--shell-text-2);
  }
</style>
