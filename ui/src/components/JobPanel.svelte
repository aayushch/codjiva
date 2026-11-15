<script lang="ts">
  import { formatElapsed, JOB_NAMES, stepStates, stepsFor } from '$lib/jobs';
  import { app } from '$lib/state/app.svelte';
  import { PIPELINE_PREFIX } from '$lib/artifacts';
  import { nameOf } from '$lib/tree';

  // The bottom dock: what the running job is doing, step by step, with the agent's activity as
  // it happens. A film job also shows its story outline here as soon as the agent has written
  // it. The dock stays after the job ends so the outcome can be read. The finished film or visual
  // is shown above the dock as soon as the job ends, if the user is still on the job's file. If
  // they have selected another file by then, the dock has a button that opens the result.
  const job = $derived(app.job);
  const steps = $derived(job ? stepStates(job, stepsFor(job)) : []);
  // What the job makes, for the sentences that report its outcome.
  const made = $derived(job?.request.kind === 'compose' || job?.artifactId?.startsWith('pipeline-') ? 'pipeline' : job?.request.kind === 'animate' || job?.artifactId?.startsWith('film-') ? 'film' : 'visual');

  // The time on the clock, refreshed every second while the job runs.
  let now = $state(Date.now());
  $effect(() => {
    if (job?.status !== 'running') return;
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });

  // Keeps the newest line of the log in view.
  let logEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    void job?.log.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  const fileName = $derived(job?.request.kind === 'compose' ? `${job.request.parts?.length ?? 0} parts` : job?.subject.startsWith(PIPELINE_PREFIX) ? 'pipeline' : nameOf(job?.subject ?? ''));
  const errors = $derived(job?.report ? [...(job.report.build ?? []).filter((p) => p.severity === 'error').map((p) => `${p.file}${p.line ? ':' + p.line : ''} · ${p.message}`),
    ...job.report.issues.filter((i) => i.severity === 'error').map((i) => `${i.check}${i.scene ? ' · ' + i.scene : ''} · ${i.message ?? i.hint ?? ''}`)] : []);
  // The outline can still be changed while the film is being made, and after it is finished.
  const canChangeOutline = $derived(job?.request.kind === 'animate' && (job.status === 'running' || job.status === 'done'));
</script>

{#if job}
  <section class="dock" class:with-outline={!!job.outline}>
    <div class="steps">
      <div class="kicker">{JOB_NAMES[job.request.kind]} · {fileName}</div>
      {#each steps as step}
        <div class="step" class:done={step.state === 'done'} class:now={step.state === 'now'}><span class="s"></span>{step.label}</div>
      {/each}
      {#if job.fixRound > 0}
        <div class="step" class:now={job.phase === 'fixing' && job.status === 'running'} class:done={job.phase !== 'fixing' || job.status !== 'running'}>
          <span class="s"></span>Fixing what the checks found (round {job.fixRound})
        </div>
      {/if}
      <div class="dock-foot">
        {#if job.status === 'running'}
          <button class="btn small" onclick={() => app.cancelJob()}>Cancel</button>
        {:else}
          <button class="btn small" onclick={() => (app.dockOpen = false)}>Close</button>
          {#if app.jobResultElsewhere}<button class="btn small primary" onclick={() => app.openJobResult()}>Show the {made}</button>{/if}
        {/if}
        {#if job.agent}<span class="pill">{job.agent}</span>{/if}
        <span class="pill">{formatElapsed((job.endedAt ?? now) - job.startedAt)}</span>
        {#if job.usage?.costUsd != null}<span class="pill">${job.usage.costUsd.toFixed(2)}</span>{/if}
      </div>
    </div>
    <div class="log" bind:this={logEl}>
      {#each job.log as line}
        {#if line.level === 'tool'}
          {@const space = line.text.indexOf(' ')}
          <div><span class="tool">{space < 0 ? line.text : line.text.slice(0, space)}</span>{space < 0 ? '' : line.text.slice(space)}</div>
        {:else if line.level === 'guard'}
          <div><span class="warn">write guard</span>: {line.text}</div>
        {:else}
          <div class:warn={line.level === 'warn' || line.level === 'error'}>{line.text}</div>
        {/if}
      {/each}
      {#if job.status === 'done' && job.result}
        <div class="outcome">{job.result.passed ? `Done. The ${made} passed every check.` : `Done, with ${job.result.errors} problem(s) the agent could not fix. The ${made} is shown with them listed in the inspector.`}</div>
      {/if}
      {#if job.status !== 'running' && errors.length && !job.result?.passed}
        {#each errors.slice(0, 8) as error}<div class="warn">· {error}</div>{/each}
      {/if}
      {#if job.status === 'failed' && job.violations.length}
        <div class="outcome">
          {#each job.violations as v}<div class="warn">{v.change} · {v.path}{v.tracked ? '' : ' (git cannot restore it)'}</div>{/each}
          {#if job.violations.some((v) => v.tracked)}<button class="btn small" onclick={() => app.revertViolations()}>Revert these changes</button>{/if}
        </div>
      {/if}
    </div>
    {#if job.outline}
      <div class="outline-pane">
        <div class="kicker">Story outline</div>
        <ol class="outline-list">
          {#each job.outline.chapters as chapter (chapter.id)}
            <li><span class="t">{chapter.title.replace(/^\d+\s*·\s*/, '')}</span><span class="s">{chapter.summary}</span></li>
          {/each}
        </ol>
        {#if canChangeOutline}
          <div class="outline-actions">
            <button class="btn small" onclick={() => (app.dialog = 'outline')}>Change the outline…</button>
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}
