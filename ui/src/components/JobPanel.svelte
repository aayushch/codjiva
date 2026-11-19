<script lang="ts">
  import {
    estimateNote,
    formatElapsed,
    JOB_NAMES,
    stepStates,
    stepsFor,
    type JobView,
  } from '$lib/jobs';
  import { app } from '$lib/state/app.svelte';
  import { PIPELINE_PREFIX, VIEWS } from '$lib/artifacts';
  import { nameOf } from '$lib/tree';

  // The bottom dock: what one job is doing, step by step, with the agent's
  // activity as it happens. A film job also shows its story outline here as
  // soon as the agent has written it. The dock stays after the job ends so the
  // outcome can be read. The finished film or visual is shown above the dock
  // as soon as the job ends, if the user is still on the job's file. If they
  // have selected another file by then, the dock has a button that opens the
  // result. Before the first job of a workspace, the dock says that nothing
  // has run yet.
  //
  // The column of steps has three parts, top to bottom. First the job's
  // title with a row of tags under it: the agent, the time the job has run,
  // how long such a job usually takes, and what it cost. The tags stay on one
  // line. If they are wider than the column, the agent's name is cut short
  // and the other tags keep their full text. Then the steps. Last, below a
  // dividing line, the buttons at the right: Cancel while the job runs, and
  // Close once it has ended.
  //
  // Several jobs can run at the same time. When `app.jobs` holds more than one
  // job, the dock has a list of them at its left edge. Clicking a job in the
  // list shows that job in the rest of the dock. A job that has ended has a
  // button in the list that removes it from the list.
  const job = $derived(app.job);
  const steps = $derived(job ? stepStates(job, stepsFor(job)) : []);
  // What the job makes, for the sentences that report its outcome.
  const made = $derived(
    job?.request.kind === 'compose' || job?.artifactId?.startsWith('pipeline-')
      ? 'pipeline'
      : job?.request.kind === 'animate' || job?.artifactId?.startsWith('film-')
        ? 'film'
        : job?.request.kind === 'stepthrough' ||
            job?.artifactId?.startsWith('stepthrough-')
          ? 'step-through'
          : job?.request.kind === 'view'
            ? job.request.view === 'map'
              ? 'map'
              : 'view'
            : 'visual',
  );

  // The time on the clock, refreshed every second while the job runs. Next to
  // the time the job has run, the dock says how long such a job usually takes,
  // once that estimate has arrived. When the job has run longer than the
  // estimate's upper end, it says "longer than usual" instead.
  let now = $state(Date.now());
  $effect(() => {
    if (job?.status !== 'running') return;
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  // Keeps the newest line of the log in view.
  let logEl: HTMLDivElement | undefined = $state();
  $effect(() => {
    void job?.log.length;
    if (logEl) logEl.scrollTop = logEl.scrollHeight;
  });

  // What a job is called in the dock: the kind of job and what it is about,
  // such as "Visualise · handler.go".
  function titleOf(one: JobView): string {
    const about =
      one.request.kind === 'compose'
        ? `${one.request.parts?.length ?? 0} parts`
        : one.subject.startsWith(PIPELINE_PREFIX)
          ? 'pipeline'
          : nameOf(one.subject);
    // A view job is called by the view it makes: "Schema · handler.go".
    const what =
      one.request.kind === 'view'
        ? (VIEWS.find((view) => view.name === one.request.view)?.label ??
          JOB_NAMES.view)
        : JOB_NAMES[one.request.kind];
    return `${what} · ${about}`;
  }
  // How a job's status is said in the list of jobs.
  const STATUS_WORDS: Record<JobView['status'], string> = {
    running: 'running',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  const errors = $derived(
    job?.report
      ? [
          ...(job.report.build ?? [])
            .filter((p) => p.severity === 'error')
            .map(
              (p) => `${p.file}${p.line ? ':' + p.line : ''} · ${p.message}`,
            ),
          ...job.report.issues
            .filter((i) => i.severity === 'error')
            .map(
              (i) =>
                `${i.check}${i.scene ? ' · ' + i.scene : ''} · ${i.message ?? i.hint ?? ''}`,
            ),
        ]
      : [],
  );
  // The outline can still be changed while the film is being made, and after it
  // is finished.
  const canChangeOutline = $derived(
    job?.request.kind === 'animate' &&
      (job.status === 'running' || job.status === 'done'),
  );
</script>

{#if job}
  <section
    class="dock"
    class:with-outline={!!job.outline}
    class:with-jobs={app.jobs.length > 1}
  >
    {#if app.jobs.length > 1}
      <div class="job-list" role="list" aria-label="Jobs">
        {#each app.jobs as one (one.key)}
          <div class="job-row" class:on={one.key === job.key} role="listitem">
            <button
              class="job-pick"
              aria-current={one.key === job.key}
              title="{titleOf(one)} ({STATUS_WORDS[one.status]})"
              onclick={() => app.showJob(one.key)}
            >
              <span class="state {one.status}"></span><span class="name"
                >{titleOf(one)}</span
              >
            </button>
            {#if one.status !== 'running'}
              <button
                class="job-drop"
                aria-label="Remove {titleOf(one)} from the list"
                title="Remove from the list"
                onclick={() => app.dismissJob(one.key)}>✕</button
              >
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    <div class="steps">
      <div class="steps-list">
        <div class="kicker">{titleOf(job)}</div>
        <div class="dock-meta">
          {#if job.agent}<span class="pill agent" title={job.agent}
              >{job.agent}</span
            >{/if}
          <span class="pill"
            >{formatElapsed((job.endedAt ?? now) - job.startedAt)}</span
          >
          {#if job.status === 'running' && job.estimate}<span
              class="pill estimate"
              >{estimateNote(job.estimate, now - job.startedAt)}</span
            >{/if}
          {#if job.usage?.costUsd != null}<span class="pill"
              >${job.usage.costUsd.toFixed(2)}</span
            >{/if}
        </div>
        {#each steps as step}
          <div
            class="step"
            class:done={step.state === 'done'}
            class:now={step.state === 'now'}
          >
            <span class="s"></span><span class="label">{step.label}</span>
          </div>
        {/each}
        {#if job.fixRound > 0}
          <div
            class="step"
            class:now={job.phase === 'fixing' && job.status === 'running'}
            class:done={job.phase !== 'fixing' || job.status !== 'running'}
          >
            <span class="s"></span><span class="label"
              >Fixing what the checks found (round {job.fixRound})</span
            >
          </div>
        {/if}
      </div>
      <div class="dock-foot">
        {#if job.status === 'running'}
          <button class="btn small" onclick={() => app.cancelJob()}
            >Cancel</button
          >
        {:else}
          <button class="btn small" onclick={() => (app.dockOpen = false)}
            >Close</button
          >
          {#if app.jobResultElsewhere}<button
              class="btn small primary"
              onclick={() => app.openJobResult()}>Show the {made}</button
            >{/if}
        {/if}
      </div>
    </div>
    <div class="log" bind:this={logEl}>
      {#each job.log as line}
        {#if line.level === 'tool'}
          {@const space = line.text.indexOf(' ')}
          <div>
            <span class="tool"
              >{space < 0 ? line.text : line.text.slice(0, space)}</span
            >{space < 0 ? '' : line.text.slice(space)}
          </div>
        {:else if line.level === 'guard'}
          <div><span class="warn">write guard</span>: {line.text}</div>
        {:else}
          <div class:warn={line.level === 'warn' || line.level === 'error'}>
            {line.text}
          </div>
        {/if}
      {/each}
      {#if job.status === 'done' && job.result}
        <div class="outcome">
          {job.result.passed
            ? `Done. The ${made} passed every check.`
            : `Done, with ${job.result.errors} problem(s) the agent could not fix. The ${made} is shown with them listed in the inspector.`}
        </div>
      {/if}
      {#if job.status !== 'running' && errors.length && !job.result?.passed}
        {#each errors.slice(0, 8) as error}<div class="warn">
            · {error}
          </div>{/each}
      {/if}
      <!-- The files outside the job's version folder that changed while the
           job ran. The app cannot tell who changed a file. It may have been
           the agent, or the user in their editor. -->
      {#if job.status !== 'running' && job.violations.length}
        <div class="outcome">
          <div>
            Changed while the job ran. If you did not change these files
            yourself, the agent did:
          </div>
          {#each job.violations as v}<div class="warn">
              {v.change} · {v.path}{v.tracked ? '' : ' (git cannot restore it)'}
            </div>{/each}
          {#if job.violations.some((v) => v.tracked)}<button
              class="btn small"
              title="Restores each file that git tracks to its last committed content. Changes you made to these files since the last commit are lost."
              onclick={() => app.revertViolations()}
              >Revert to the last commit</button
            >{/if}
        </div>
      {/if}
    </div>
    {#if job.outline}
      <div class="outline-pane">
        <div class="kicker">Story outline</div>
        <ol class="outline-list">
          {#each job.outline.chapters as chapter (chapter.id)}
            <li>
              <span class="t">{chapter.title.replace(/^\d+\s*·\s*/, '')}</span
              ><span class="s">{chapter.summary}</span>
            </li>
          {/each}
        </ol>
        {#if canChangeOutline}
          <div class="outline-actions">
            <button class="btn small" onclick={() => (app.dialog = 'outline')}
              >Change the outline…</button
            >
          </div>
        {/if}
      </div>
    {/if}
  </section>
{:else}
  <section class="dock idle">
    <div class="idle-note">
      <div class="kicker">Job panel</div>
      <p>
        No job has run since this folder was opened. Select a file and click
        Visualise or Animate. What the agent does is then shown here, step by
        step.
      </p>
      <button class="btn small" onclick={() => (app.dockOpen = false)}
        >Close</button
      >
    </div>
  </section>
{/if}
