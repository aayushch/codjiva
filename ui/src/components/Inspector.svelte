<script lang="ts">
  import { isStepped, kindWord, showsFilm } from '$lib/artifacts';
  import { formatBytes, formatTime } from '$lib/tree';
  import { app } from '$lib/state/app.svelte';
  import CodeExcerpt from './CodeExcerpt.svelte';
  import FeedbackBox from './FeedbackBox.svelte';
  import RationaleNote from './RationaleNote.svelte';

  // The right-hand panel beside a visual or a film.
  //
  // For a visual with a part selected, it explains that part: its role, the
  // lines of its code, what it reads and writes, where the work goes from it
  // and under which condition, and its edge cases. For a film, it lists the
  // chapters, which seek the film when clicked, and the companion files the
  // film was made from.
  //
  // For a step-through the part it explains is the one the user clicked. While
  // they have clicked none, it is the state that the step on screen is in,
  // so the panel follows the steps. An edge case with an example has a
  // button that runs the step-through on that example. A lanes view and a
  // structure view are followed in the same way.
  //
  // A part of a view has more to show. A type of a schema view lists its
  // fields, each with the functions that write it and read it. A node of a
  // map links to its file or folder, lists the visuals, films and views that
  // were made of that file or folder, and lists the nodes it uses and the
  // nodes that use it.
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
  // True for an artifact that is played one step at a time. The part on
  // show then follows the steps.
  const isSteps = $derived(isStepped(artifact?.kind));
  // True for an artifact that is run on an input the viewer types, so that
  // an edge case's example can be run on it. A lanes view has scenarios and
  // no input.
  const takesInput = $derived(
    artifact?.kind === 'stepthrough' || artifact?.kind === 'structure',
  );
  const isMap = $derived(artifact?.kind === 'map');
  const nodes = $derived(detail?.definition?.nodes ?? []);
  const node = $derived(
    nodes.find((n) => n.id === app.selectedNode) ??
      (isSteps ? nodes.find((n) => n.id === app.stepNode) : null) ??
      null,
  );
  // True when the part on show is the state of the step on screen and not a
  // part the user clicked.
  const following = $derived(!!node && node.id !== app.selectedNode);
  // The label of the node with the given id, or the text itself when it is
  // not the id of a node. A transition names its target either way.
  const targetLabel = (to: string) =>
    nodes.find((n) => n.id === to)?.label ?? to;
  // In a schema view: the functions that write or read the field `field`
  // of the type `id`, writers first.
  const usesOf = (id: string, field: string) =>
    (detail?.definition?.uses ?? [])
      .filter((use) => use.node === id && use.field === field)
      .sort((a, b) => Number(b.how === 'writes') - Number(a.how === 'writes'));
  // Opens the place a `path:line` text names.
  function openPlace(place: string) {
    const cut = place.lastIndexOf(':');
    const line = parseInt(place.slice(cut + 1), 10);
    if (cut > 0 && line > 0) app.selectFile(place.slice(0, cut), line);
  }
  // On a map: the nodes that the node `id` uses, and the nodes that use it,
  // each with what the link says.
  const linked = (id: string, end: 'from' | 'to') =>
    (detail?.definition?.links ?? [])
      .filter((link) => link[end] === id)
      .map((link) => ({
        other: end === 'from' ? link.to : link.from,
        label: link.label ?? link.kind,
      }));
  // The other artifacts that were made of the file or folder at `path`.
  const madeOf = (path: string) =>
    app.artifacts.filter(
      (one) => one.subject[0] === path && one.id !== artifact?.id,
    );

  // Selects a node here and in the drawing.
  function selectNode(id: string) {
    app.selectedNode = id;
    app.frameSend?.({ cj: 'select', nodeId: id });
  }
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
  const word = $derived(
    isPipeline ? 'pipeline' : isFilm ? 'film' : kindWord(artifact),
  );
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
      <div class="kicker">{following ? 'Current state' : 'Selected'}</div>
      <h3>{node.label}</h3>
      <p>{node.role}</p>
      {#if node.rationale}
        <div class="kicker">Rationale</div>
        <RationaleNote rationale={node.rationale} />
      {/if}
      {#if node.refs?.length}
        <div class="kicker">Code</div>
        <!-- The first reference is the code of the part, shown as lines. Any
             further ones are other places that belong to it, shown as links.
             -->
        {#key `${node.id}/${node.refs[0].path}/${node.refs[0].line}`}
          <CodeExcerpt
            path={node.refs[0].path}
            line={node.refs[0].line}
            end={node.refs[0].end}
          />
        {/key}
        {#each node.refs.slice(1) as ref}
          <button class="ref" onclick={() => openRef(ref.path, ref.line)}
            >{shortPath(ref.path)}:{ref.line}</button
          >
        {/each}
      {/if}
      {#if node.fields?.length}
        <div class="kicker">Fields</div>
        {#each node.fields as field}
          <div class="field-row">
            <span class="field-name" class:key={field.key}
              >{field.name}{field.optional ? '?' : ''}</span
            >
            <span class="field-type">{field.type ?? ''}</span>
          </div>
          {#if field.note}<div class="field-note">{field.note}</div>{/if}
          {#each usesOf(node.id, field.name) as use}
            <div class="field-use">
              {use.how === 'writes' ? 'written by' : 'read by'}
              <button class="ref inline" onclick={() => openPlace(use.ref)}
                >{use.by}</button
              >
            </div>
          {/each}
        {/each}
      {/if}
      {#if isMap}
        {#if node.path}
          {@const path = node.path}
          <div class="kicker">In the workspace</div>
          <button class="ref" onclick={() => app.selectFile(path)}
            >Open {path}</button
          >
          {#each madeOf(path) as made}
            <button class="ref" onclick={() => app.openArtifact(made)}
              >Show its {kindWord(made)} · v{made.currentVersion}</button
            >
          {/each}
        {/if}
        {#each [{ title: 'Uses', end: 'from' as const }, { title: 'Used by', end: 'to' as const }] as side}
          {@const others = linked(node.id, side.end)}
          {#if others.length}
            <div class="kicker">{side.title}</div>
            {#each others as one}
              <div class="transition">
                <button class="ref inline" onclick={() => selectNode(one.other)}
                  >{targetLabel(one.other)}</button
                >
                <span class="muted">{one.label}</span>
              </div>
            {/each}
          {/if}
        {/each}
      {/if}
      {#if node.inputs?.length || node.outputs?.length}
        <div class="io">
          {#if node.inputs?.length}
            <div>
              <div class="kicker">Reads</div>
              {#each node.inputs as one}<div class="io-row">{one}</div>{/each}
            </div>
          {/if}
          {#if node.outputs?.length}
            <div>
              <div class="kicker">Writes</div>
              {#each node.outputs as one}<div class="io-row">{one}</div>{/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if node.transitions?.length}
        <div class="kicker">Goes on to</div>
        {#each node.transitions as one}
          {@const isNode = nodes.some((n) => n.id === one.to)}
          <div class="transition">
            <span class="when">{one.when}</span>
            {#if isNode}
              <button class="ref inline" onclick={() => selectNode(one.to)}
                >→ {targetLabel(one.to)}</button
              >
            {:else}
              <span>→ {one.to}</span>
            {/if}
          </div>
        {/each}
      {/if}
      {#if node.edgeCases?.length}
        <div class="kicker">Edge cases</div>
        {#each node.edgeCases as one}
          <div class="edge-case">
            <div>{one.text}</div>
            <div class="edge-case-foot">
              {#if one.example != null}
                {#if takesInput}
                  <button
                    class="chip"
                    title="Run the step-through on {one.example}"
                    onclick={() =>
                      app.frameSend?.({ cj: 'input', value: one.example })}
                    >Try {one.example}</button
                  >
                {:else}
                  <code>{one.example}</code>
                {/if}
              {/if}
              {#each one.refs as ref}
                <button
                  class="ref inline"
                  onclick={() => openRef(ref.path, ref.line)}
                  >{shortPath(ref.path)}:{ref.line}</button
                >
              {/each}
            </div>
          </div>
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
      <button
        class="btn small"
        disabled={app.artifactBusy}
        onclick={() => app.askRegenerate()}
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
