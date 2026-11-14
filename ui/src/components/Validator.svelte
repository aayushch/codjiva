<script lang="ts">
  import { api, type Issue, type ValidateRequest, type ValidationReport } from '$lib/ipc';
  import { app } from '$lib/state/app.svelte';
  import ArtifactFrame from './ArtifactFrame.svelte';

  // Runs the self-test of a freshly built version for a running job.
  //
  // The version is loaded in a frame that is laid out at the full stage size, 1920 x 1080, but
  // not painted, with the same sandbox as the frame the user sees. When the page reports that it
  // is ready, it is asked for its self-test, and the report goes back to the job. One version is
  // checked at a time, in the order the requests arrived.

  // How long the page gets to load and report ready, and how long its self-test may take.
  const READY_LIMIT_MS = 20_000;
  const SELFTEST_LIMIT_MS = 60_000;

  const current = $derived<ValidateRequest | null>(app.validateQueue[0] ?? null);
  let frame: ReturnType<typeof ArtifactFrame> | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Errors the page reported while loading, which become issues if it never gets ready.
  let reported: string[] = [];
  let asked = false;

  const failure = (message: string): ValidationReport => {
    const issues: Issue[] = [{ check: 'exception', severity: 'error', message, hint: 'Fix the error so the artifact can be drawn.' }];
    return { ok: false, issues };
  };

  function finish(request: ValidateRequest, report: ValidationReport) {
    clearTimeout(timer);
    api.jobValidated(request.token, report).catch((e) => app.fail(e));
    app.validateQueue = app.validateQueue.filter((r) => r.token !== request.token);
  }

  // Starts the clock for each new request.
  $effect(() => {
    const request = current;
    if (!request) return;
    reported = [];
    asked = false;
    timer = setTimeout(() => finish(request, failure(reported.length ? reported.join(' · ') : 'The artifact did not finish loading.')), READY_LIMIT_MS);
    return () => clearTimeout(timer);
  });

  function onmessage(message: any) {
    const request = current;
    if (!request) return;
    if (message.cj === 'error') {
      reported.push(message.scene ? `${message.scene}: ${message.message}` : message.message);
    } else if (message.cj === 'ready' && !asked) {
      asked = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish(request, failure('The self-test did not finish within a minute.')), SELFTEST_LIMIT_MS);
      frame?.send({ cj: 'selftest' });
    } else if (message.cj === 'selftest') {
      finish(request, message.report as ValidationReport);
    }
  }
</script>

{#if current}
  {#key current.token}
    <div class="validator" aria-hidden="true">
      <ArtifactFrame bind:this={frame} src={api.artifactUrl(`artifact/${current.artifactId}/${current.version}`) + '?embed=1'} title="Self-test" {onmessage} />
    </div>
  {/key}
{/if}
