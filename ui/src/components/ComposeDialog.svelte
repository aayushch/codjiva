<script lang="ts">
  import { api, type ArtifactPorts, type Join } from '$lib/ipc';
  import { app, FILM_SECONDS } from '$lib/state/app.svelte';

  // The step before a pipeline is made. It lists the chosen artifacts in the
  // order work flows through them, the joins the app proposes between their
  // ports, and lets the user confirm joins, add one by hand, and choose between
  // a still pipeline and a film.
  let parts = $state<ArtifactPorts[]>([]);
  let joins = $state<Join[]>([]);
  // Which joins are ticked, by the key from `keyOf`.
  let ticked = $state<Record<string, boolean>>({});
  let loading = $state(true);
  let film = $state(false);
  let text = $state('');

  // The two ends of a join the user is adding by hand, each as "<artifact
  // id>#<port id>".
  let manualFrom = $state('');
  let manualTo = $state('');

  const keyOf = (join: Join) =>
    `${join.fromArtifact}#${join.fromPort}>${join.toArtifact}#${join.toPort}`;
  const titleOf = (artifactId: string) =>
    parts.find((p) => p.artifactId === artifactId)?.title ?? artifactId;
  const fileOf = (part: ArtifactPorts) =>
    part.subject[0]?.split('/').pop() ?? '';
  const STRENGTH: Record<string, string> = {
    exact: 'same symbol',
    name: 'same name',
    line: 'named in the code',
  };

  // Reads the ports and the proposed joins once, when the dialog opens. The
  // parts are put in flow order: an artifact that only sends comes before one
  // that receives from it.
  $effect(() => {
    const ids = app.composeAsk;
    if (!ids) return;
    api
      .composePropose(ids)
      .then((proposal) => {
        joins = proposal.joins;
        // The strongest proposals are ticked; a weaker one is left for the user
        // to judge.
        ticked = Object.fromEntries(
          proposal.joins
            .filter((j) => j.strength !== 'line')
            .map((j) => [keyOf(j), true]),
        );
        const receives = (id: string) =>
          proposal.joins.filter((j) => j.toArtifact === id).length;
        const sends = (id: string) =>
          proposal.joins.filter((j) => j.fromArtifact === id).length;
        parts = [...proposal.parts].sort(
          (a, b) =>
            receives(a.artifactId) -
            sends(a.artifactId) -
            (receives(b.artifactId) - sends(b.artifactId)),
        );
      })
      .catch((error) => app.fail(error))
      .finally(() => {
        loading = false;
      });
  });

  const chosen = $derived(joins.filter((join) => ticked[keyOf(join)]));
  const outPorts = $derived(
    parts.flatMap((part) =>
      part.ports
        .filter((p) => p.dir === 'out')
        .map((p) => ({
          value: `${part.artifactId}#${p.id}`,
          label: `${fileOf(part)} · ${p.symbol}`,
        })),
    ),
  );
  const inPorts = $derived(
    parts.flatMap((part) =>
      part.ports
        .filter((p) => p.dir === 'in')
        .map((p) => ({
          value: `${part.artifactId}#${p.id}`,
          label: `${fileOf(part)} · ${p.symbol}`,
        })),
    ),
  );
  const manualValid = $derived(
    !!manualFrom &&
      !!manualTo &&
      manualFrom.split('#')[0] !== manualTo.split('#')[0],
  );

  function move(index: number, by: number) {
    const to = index + by;
    if (to < 0 || to >= parts.length) return;
    const next = [...parts];
    [next[index], next[to]] = [next[to], next[index]];
    parts = next;
  }

  // Adds the join chosen in the two lists, ticked. A join that is already
  // listed is ticked.
  function addManual() {
    if (!manualValid) return;
    const [fromArtifact, fromPort] = manualFrom.split('#');
    const [toArtifact, toPort] = manualTo.split('#');
    const into = parts
      .find((p) => p.artifactId === toArtifact)
      ?.ports.find((p) => p.id === toPort);
    const out = parts
      .find((p) => p.artifactId === fromArtifact)
      ?.ports.find((p) => p.id === fromPort);
    const join: Join = {
      fromArtifact,
      fromPort,
      toArtifact,
      toPort,
      symbol: into?.symbol ?? '',
      kind: out?.kind ?? into?.kind ?? '',
      carries: out?.carries ?? '',
      reason: 'Joined by you.',
      strength: null,
    };
    if (!joins.some((j) => keyOf(j) === keyOf(join))) joins = [...joins, join];
    ticked[keyOf(join)] = true;
    manualFrom = '';
    manualTo = '';
  }

  function start() {
    if (!chosen.length) return;
    // Only artifacts that take part in a ticked join become parts of the
    // pipeline.
    const used = parts
      .filter((p) =>
        chosen.some(
          (j) =>
            j.fromArtifact === p.artifactId || j.toArtifact === p.artifactId,
        ),
      )
      .map((p) => p.artifactId);
    app.startJob(
      {
        kind: 'compose',
        subject: [],
        parts: used,
        joins: chosen,
        film,
        instructions: text.trim(),
        lengthSeconds: FILM_SECONDS[app.settings?.filmLength ?? 'standard'],
      },
      'pipeline',
    );
  }
</script>

{#if app.composeAsk}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) app.dialog = null;
    }}
  >
    <div class="dialog compose" role="dialog" aria-labelledby="compose-title">
      <h2 id="compose-title">Compose a pipeline</h2>
      <p class="lead">
        The agent places these artifacts side by side in one drawing and joins
        them where their code meets. The artifacts themselves are not changed.
      </p>

      <div class="kicker">Parts, in the order work flows</div>
      {#if loading}<p class="lead">Reading the ports…</p>{/if}
      {#each parts as part, i (part.artifactId)}
        <div class="part">
          <span class="n">{i + 1}</span>
          <span class="t"
            >{part.title}<span class="why"
              >{part.subject.join(', ')} · {part.ports.filter(
                (p) => p.dir === 'in',
              ).length} in · {part.ports.filter((p) => p.dir === 'out').length} out</span
            ></span
          >
          <span class="moves">
            <button
              class="tb-btn"
              aria-label="Move {part.title} earlier"
              title="Earlier"
              disabled={i === 0}
              onclick={() => move(i, -1)}>↑</button
            >
            <button
              class="tb-btn"
              aria-label="Move {part.title} later"
              title="Later"
              disabled={i === parts.length - 1}
              onclick={() => move(i, 1)}>↓</button
            >
          </span>
        </div>
      {/each}

      <div class="kicker">Joins</div>
      {#if !loading && joins.length === 0}
        <p class="lead">
          No port of one artifact names the same place in the code as a port of
          another. Add a join below if you know where they meet.
        </p>
      {/if}
      {#each joins as join (keyOf(join))}
        <label class="check"
          ><input type="checkbox" bind:checked={ticked[keyOf(join)]} />
          <span
            ><code>{join.fromPort.replace(/^out:/, '')}</code> →
            <code>{join.toPort.replace(/^in:/, '')}</code>
            <span class="pill"
              >{join.strength ? STRENGTH[join.strength] : 'added by you'}</span
            >
            <div class="why">
              {titleOf(join.fromArtifact)} → {titleOf(join.toArtifact)}. {join.reason}
            </div></span
          ></label
        >
      {/each}
      {#if outPorts.length && inPorts.length}
        <div class="manual">
          <select class="select" aria-label="Out port" bind:value={manualFrom}
            ><option value="">an out port…</option
            >{#each outPorts as p (p.value)}<option value={p.value}
                >{p.label}</option
              >{/each}</select
          >
          <span>→</span>
          <select class="select" aria-label="In port" bind:value={manualTo}
            ><option value="">an in port…</option
            >{#each inPorts as p (p.value)}<option value={p.value}
                >{p.label}</option
              >{/each}</select
          >
          <button class="btn small" disabled={!manualValid} onclick={addManual}
            >Add join</button
          >
        </div>
      {/if}

      <div class="field">
        <span class="label">Make it as</span>
        <div class="seg">
          <button class="btn" class:on={!film} onclick={() => (film = false)}
            >A still pipeline</button
          >
          <button class="btn" class:on={film} onclick={() => (film = true)}
            >A film</button
          >
        </div>
        <div class="why">
          {film
            ? 'A film follows one piece of work through every part. It takes several minutes to make.'
            : 'A still pipeline shows every part and each crossing at once. It is the quicker one to make.'}
        </div>
      </div>
      <div class="field">
        <label for="compose-text"
          >What the pipeline should show (optional)</label
        >
        <textarea
          id="compose-text"
          class="input"
          rows="2"
          bind:value={text}
          placeholder="For example: follow one order from the handler to the file on disk"
        ></textarea>
      </div>
      <div class="foot">
        <span class="pill version"
          >{app.activeAgent ? app.activeAgent.name : 'No agent available'}</span
        >
        <button class="btn" onclick={() => (app.dialog = null)}>Cancel</button>
        <button
          class="btn primary"
          disabled={!app.activeAgent || chosen.length === 0}
          onclick={start}>Compose</button
        >
      </div>
    </div>
  </div>
{/if}

<style>
  .part {
    display: grid;
    grid-template-columns: 20px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 7px 0;
    border-bottom: 1px solid var(--shell-border-soft);
  }
  .part .n {
    color: var(--accent);
    text-align: right;
  }
  .part .t {
    color: var(--second);
    min-width: 0;
  }
  .why {
    display: block;
    font-size: 11px;
    color: var(--muted);
    margin-top: 2px;
  }
  .moves .tb-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .manual {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    margin-top: 10px;
  }
  .manual .select {
    flex: 1;
    min-width: 0;
    max-width: 240px;
  }
  .check .pill {
    margin-left: 6px;
  }
</style>
