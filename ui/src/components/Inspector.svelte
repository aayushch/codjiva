<script lang="ts">
  import { showsFilm } from '$lib/artifacts';
  import { formatBytes, formatTime } from '$lib/tree';
  import { app } from '$lib/state/app.svelte';
  import FeedbackBox from './FeedbackBox.svelte';
  import RationaleNote from './RationaleNote.svelte';

  // The right-hand panel beside a visual or a film.
  //
  // For a visual with a part selected, it explains that part and links to its
  // code. For a film, it lists the chapters, which seek the film when clicked,
  // and the companion files the film was made from.
  //
  // It is also where a rationale is read: why the code does what a part or a
  // step describes. A selected part shows its rationale under its role. A film
  // lists the rationales of its bubbles, each under the bubble's heading, which
  // goes to its chapter when clicked. A visual with a rationale has a switch
  // that shows a "?" marker on each such part. For both it shows the modes and
  // limits the agent found, the outcome of the checks and the feedback box. The
  // actions on the version, such as Regenerate and Export, are in
  // Toolbar.svelte.
  const detail = $derived(app.detail);
  const artifact = $derived(app.currentArtifact);
  const node = $derived(
    detail?.definition?.nodes?.find((n) => n.id === app.selectedNode) ?? null,
  );
  const model = $derived(detail?.model ?? null);
  const report = $derived(detail?.validation ?? null);
  const problems = $derived(
    report
      ? [
          ...(report.build ?? []).map((p) => ({
            severity: p.severity,
            text: `${p.file}${p.line ? ':' + p.line : ''} · ${p.message}`,
          })),
          ...report.issues.map((i) => ({
            severity: i.severity,
            text: [i.check, i.scene, i.message ?? i.hint]
              .filter(Boolean)
              .join(' · '),
          })),
        ]
      : [],
  );
  const errorCount = $derived(
    problems.filter((p) => p.severity === 'error').length,
  );
  const isCurrent = $derived(
    artifact != null && app.shownVersion === artifact.currentVersion,
  );
  const isFilm = $derived(showsFilm(artifact));
  const isPipeline = $derived(artifact?.kind === 'pipeline');
  const word = $derived(isPipeline ? 'pipeline' : isFilm ? 'film' : 'visual');
  // The artifacts this one could be joined with, from the joins the app can
  // propose.
  const connected = $derived(
    artifact && !isPipeline
      ? [
          ...new Set(
            app.connections
              .filter(
                (j) =>
                  j.fromArtifact === artifact.id ||
                  j.toArtifact === artifact.id,
              )
              .map((j) =>
                j.fromArtifact === artifact.id ? j.toArtifact : j.fromArtifact,
              ),
          ),
        ]
          .map((id) => app.artifacts.find((a) => a.id === id))
          .filter((a) => a != null)
      : [],
  );
  const partTitle = (artifactId: string) =>
    app.artifacts.find((a) => a.id === artifactId)?.title ?? null;
  const partKey = (artifactId: string) =>
    detail?.manifest.parts?.find((p) => p.artifact === artifactId)?.key ?? '';
  const chapters = $derived(detail?.manifest.chapters ?? []);
  // The rationales of a film, in the order of its bubbles. `chapter` is the
  // position of the chapter the bubble belongs to.
  const filmRationales = $derived(
    (detail?.definition?.scenes ?? []).flatMap((scene, chapter) =>
      scene.bubbles.flatMap((bubble) =>
        bubble.rationale
          ? [{ chapter, kicker: bubble.kicker, rationale: bubble.rationale }]
          : [],
      ),
    ),
  );
  const hasNodeRationale = $derived(
    !!detail?.definition?.nodes?.some((n) => n.rationale),
  );

  const LAYER_NAMES: Record<string, string> = {
    data: 'Data flow',
    control: 'Control and limits',
    errors: 'Errors',
    labels: 'Labels',
  };

  // Splits a "path:line" or "path:start-end" reference from the analysis.
  const parseRef = (ref: string) => {
    const cut = ref.lastIndexOf(':');
    return {
      path: ref.slice(0, cut),
      line: parseInt(ref.slice(cut + 1), 10) || 1,
    };
  };
  const shortPath = (path: string) => path.split('/').pop() ?? path;
  const openRef = (path: string, line: number) => app.selectFile(path, line);
  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
</script>

{#if detail && artifact}
  <aside class="inspector">
    {#if node}
      <div class="kicker">Selected</div>
      <h3>{node.label}</h3>
      <p>{node.role}</p>
      {#if node.rationale}
        <div class="kicker">Rationale</div>
        <RationaleNote rationale={node.rationale} />
      {/if}
      {#if node.refs?.length}
        <div class="kicker">Code</div>
        {#each node.refs as ref}
          <button class="ref" onclick={() => openRef(ref.path, ref.line)}
            >{shortPath(ref.path)}:{ref.line}</button
          >
        {/each}
      {/if}
    {:else}
      <div class="kicker">This {word}</div>
      <h3>{detail.manifest.title}</h3>
      {#if isFilm}
        <p class="muted">
          {detail.manifest.durationSec
            ? formatTime(detail.manifest.durationSec) + ' · '
            : ''}{chapters.length} chapters
        </p>
      {:else if isPipeline}
        <p class="muted">
          Click a part or a join to see what it does. Zoom in to read a part.
        </p>
      {:else}
        <p class="muted">
          Click a part to see what it does and where it is in the code.
        </p>
      {/if}
      {#if detail.manifest.instructions}
        <div class="kicker">Instructions</div>
        <p>{detail.manifest.instructions}</p>
      {/if}
      {#if detail.manifest.feedback}
        <div class="kicker">Changed after feedback</div>
        <p>{detail.manifest.feedback}</p>
      {/if}
    {/if}

    {#if isPipeline && detail.manifest.parts?.length}
      <div class="kicker">Parts</div>
      {#each detail.manifest.parts as part, i (part.key)}
        {@const title = partTitle(part.artifact)}
        {#if title}
          <button
            class="part-row"
            title="Open this part's own artifact"
            onclick={() => {
              const found = app.artifacts.find((a) => a.id === part.artifact);
              if (found) app.openArtifact(found);
            }}>{i + 1} · {title}</button
          >
        {:else}
          <span class="part-row gone"
            >{i + 1} · {part.key} (its artifact was deleted)</span
          >
        {/if}
      {/each}
      {#if detail.manifest.joins?.length}
        <div class="kicker">Joins</div>
        {#each detail.manifest.joins as join}
          <div class="join">
            <code>{partKey(join.fromArtifact)}</code> →
            <code>{partKey(join.toArtifact)}</code>
            · {join.symbol || join.toPort.replace(/^in:/, '')}
            <div class="why">
              {[join.kind, join.carries]
                .filter(Boolean)
                .join(' · ')}{join.reason
                ? (join.kind || join.carries ? '. ' : '') + join.reason
                : ''}
            </div>
          </div>
        {/each}
      {/if}
    {/if}
    {#if !isPipeline && connected.length}
      <div class="kicker">Connects to</div>
      {#each connected as other (other.id)}
        <button
          class="part-row"
          title="Open it"
          onclick={() => app.openArtifact(other)}>{other.title}</button
        >
      {/each}
      <button
        class="btn small"
        onclick={() =>
          app.askCompose([artifact.id, ...connected.map((a) => a.id)])}
        >Compose a pipeline…</button
      >
    {/if}

    {#if isFilm && chapters.length}
      <div class="kicker">Chapters</div>
      {#each chapters as chapter, i (chapter.id)}
        <button
          class="chapter-row"
          class:on={app.filmMoment?.chapter === i}
          title={chapter.desc || chapter.title}
          onclick={() =>
            app.frameSend?.({ cj: 'seek', t: chapter.start + 0.01 })}
        >
          <span>{chapter.name}</span><span class="at"
            >{formatTime(chapter.start)}</span
          >
        </button>
      {/each}
    {/if}
    {#if isFilm && filmRationales.length}
      <div class="kicker">Rationale</div>
      {#each filmRationales as item}
        <div
          class="rationale-item"
          class:on={app.filmMoment?.chapter === item.chapter}
        >
          <button
            class="rationale-head"
            title="Go to the chapter this is about"
            onclick={() => {
              const chapter = chapters[item.chapter];
              if (chapter)
                app.frameSend?.({ cj: 'seek', t: chapter.start + 0.01 });
            }}>{item.kicker}</button
          >
          <RationaleNote rationale={item.rationale} />
        </div>
      {/each}
    {/if}
    {#if isFilm && !isPipeline && detail.manifest.companions.length}
      <div class="kicker">Companion files</div>
      {#each detail.manifest.companions as companion (companion.path)}
        <div class="companion">
          <button
            class="ref"
            title={companion.path}
            onclick={() => openRef(companion.path, 1)}
            >{shortPath(companion.path)}</button
          >
          {#if companion.why}<div class="why">{companion.why}</div>{/if}
        </div>
      {/each}
    {/if}

    {#if model?.modes?.length}
      <div class="kicker">Modes</div>
      {#each model.modes.slice(0, 6) as mode}
        <p>
          <code>{mode.name}</code> when {mode.trigger}
          {#if mode.ref}{@const r = parseRef(mode.ref)}<button
              class="ref inline"
              onclick={() => openRef(r.path, r.line)}
              >{shortPath(r.path)}:{r.line}</button
            >{/if}
        </p>
      {/each}
    {/if}
    {#if model?.limits?.length}
      <div class="kicker">Limits</div>
      {#each model.limits.slice(0, 8) as limit}
        <p>
          <code>{limit.name}</code>{limit.scope ? ` (${limit.scope})` : ''}: {limit.effect}
          {#if limit.ref}{@const r = parseRef(limit.ref)}<button
              class="ref inline"
              onclick={() => openRef(r.path, r.line)}
              >{shortPath(r.path)}:{r.line}</button
            >{/if}
        </p>
      {/each}
    {/if}

    {#if !isFilm && (Object.keys(app.layers).length || detail.definition?.legend?.length || hasNodeRationale)}
      <div class="kicker">Layers</div>
      {#each Object.keys(app.layers) as layer}
        <button
          class="layer"
          role="switch"
          aria-checked={app.layers[layer]}
          onclick={() => app.setLayer(layer, !app.layers[layer])}
        >
          <span class="switch" class:on={app.layers[layer]}></span>{LAYER_NAMES[
            layer
          ] ?? layer}
        </button>
      {/each}
      {#if detail.definition?.legend?.length}
        <button
          class="layer"
          role="switch"
          aria-checked={app.legendOn}
          onclick={() => {
            app.legendOn = !app.legendOn;
            app.frameSend?.({ cj: 'legend', on: app.legendOn });
          }}
        >
          <span class="switch" class:on={app.legendOn}></span>Legend
        </button>
      {/if}
      {#if hasNodeRationale}
        <button
          class="layer"
          role="switch"
          aria-checked={app.rationaleOn}
          title="Show a ? on each part that says why the code is built that way"
          onclick={() => {
            app.rationaleOn = !app.rationaleOn;
            app.frameSend?.({ cj: 'rationale', on: app.rationaleOn });
          }}
        >
          <span class="switch" class:on={app.rationaleOn}></span>Rationale
        </button>
      {/if}
    {/if}

    {#if artifact.stale && isCurrent}
      <div class="kicker">Stale</div>
      <p class="muted">
        {#each artifact.staleSources as path, i}{i ? ', ' : ''}<code
            >{shortPath(path)}</code
          >{/each} changed after this version was made.{isPipeline
          ? ' Regenerate the part it belongs to first, then compose again.'
          : ''}
      </p>
      <button class="btn small" onclick={() => app.askRegenerate()}
        >{isPipeline ? 'Compose again…' : 'Regenerate…'}</button
      >
    {/if}

    <FeedbackBox />

    <div class="kicker">Checks</div>
    <p class="muted">
      {artifact.kind} · {errorCount ? `${errorCount} problem(s)` : 'passed'} · {problems.length -
        errorCount} warning(s) · {formatBytes(detail.bytes)}
    </p>
    {#each problems.slice(0, 12) as problem}
      <p class="problem" class:error={problem.severity === 'error'}>
        {problem.text}
      </p>
    {/each}

    <div class="kicker">Version</div>
    <p class="muted">
      v{detail.manifest.version} · {when(detail.manifest.createdAt)} · {detail
        .manifest.agent.kind}{detail.manifest.agent.model
        ? ' · ' + detail.manifest.agent.model
        : ''}{detail.manifest.costUsd != null
        ? ' · $' + detail.manifest.costUsd.toFixed(2)
        : ''}
    </p>
    {#if !isCurrent}
      <p class="muted">You are looking at an earlier version.</p>
      <button class="btn small" onclick={() => app.makeCurrent()}
        >Make this the current version</button
      >
    {/if}
  </aside>
{/if}
