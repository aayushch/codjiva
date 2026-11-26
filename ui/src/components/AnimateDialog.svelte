<script lang="ts">
  import { api, type Suggestion } from '$lib/ipc';
  import { scopeTitle } from '$lib/discuss';
  import { app, FILM_SECONDS } from '$lib/state/app.svelte';
  import IgnoreDialog from './IgnoreDialog.svelte';
  import JobEstimate from './JobEstimate.svelte';

  // The step between clicking Animate and the job starting. The user chooses
  // which other files the agent reads with the file, says what the film should
  // show, and picks its length.
  const ask = $derived(app.animateAsk);
  const fileName = $derived(ask?.subject.split('/').pop() ?? '');
  // What the film is of: the file, or for a film of a part of the file that
  // part and the file, such as "Queue.Push in queue.go".
  const subjectName = $derived(
    ask?.scope ? `${scopeTitle(ask.scope)} in ${fileName}` : fileName,
  );
  const limit = $derived(app.settings?.maxCompanionFiles ?? 12);

  // The companion files on offer, each with the reason it is listed, and which
  // are ticked.
  let rows = $state<{ path: string; why: string }[]>([]);
  let ticked = $state<Record<string, boolean>>({});
  let loading = $state(true);
  let text = $state(app.animateAsk?.initial ?? '');
  let length = $state<keyof typeof FILM_SECONDS>(
    app.settings?.filmLength ?? 'standard',
  );

  // The file search under the list, for adding a file that was not suggested.
  let query = $state('');
  let hits = $state<{ relPath: string; name: string }[]>([]);

  // Suggestions that score at least this much are ticked when the dialog opens.
  // A direct import scores 10 and a file of the same name 8; a file that only
  // mentions a name scores less.
  const TICK_FROM = 8;

  // Fills the list once, when the dialog opens. A regeneration starts from the
  // companions of the film on screen, all ticked, with the suggestions added
  // below them unticked.
  $effect(() => {
    const current = app.animateAsk;
    if (!current) return;
    const kept = current.companions.map((path) => ({
      path,
      why: 'used for the film on screen',
    }));
    api
      .companionsSuggest(current.subject)
      .then((suggested: Suggestion[]) => {
        const extra = suggested
          .filter((s) => !current.companions.includes(s.path))
          .map((s) => ({ path: s.path, why: s.why }));
        rows = [...kept, ...extra];
        const preselect = current.regenerate
          ? []
          : suggested
              .filter((s) => s.score >= TICK_FROM)
              .slice(0, limit)
              .map((s) => s.path);
        ticked = Object.fromEntries(
          [...current.companions, ...preselect].map((path) => [path, true]),
        );
      })
      .catch((error) => {
        rows = kept;
        app.fail(error);
      })
      .finally(() => {
        loading = false;
      });
  });

  // The companion file whose "Ignore always" button was clicked. While it is
  // set, IgnoreDialog is shown over this dialog.
  let ignoring = $state<string | null>(null);

  // Runs after IgnoreDialog saved a new ignore pattern. `matched` are the
  // listed files the pattern matches. They are removed from the list. The
  // suggestions are then asked for again, because files that did not fit in the
  // list before can take the freed places. A new suggestion is ticked by the
  // same rule as when the dialog opens.
  async function afterIgnore(matched: string[]) {
    ignoring = null;
    const current = app.animateAsk;
    if (!current) return;
    rows = rows.filter((row) => !matched.includes(row.path));
    for (const path of matched) delete ticked[path];
    try {
      const suggested = await api.companionsSuggest(current.subject);
      const fresh = suggested.filter(
        (s) => !rows.some((row) => row.path === s.path),
      );
      rows = [...rows, ...fresh.map((s) => ({ path: s.path, why: s.why }))];
      if (!current.regenerate)
        for (const s of fresh)
          if (s.score >= TICK_FROM && chosen.length < limit)
            ticked[s.path] = true;
    } catch (error) {
      app.fail(error);
    }
    app.notify(
      matched.length
        ? `Added to the ignore list. ${matched.length} file${matched.length === 1 ? ' was' : 's were'} removed from this list.`
        : 'Added to the ignore list.',
    );
  }

  const chosen = $derived(
    rows.filter((row) => ticked[row.path]).map((row) => row.path),
  );
  const tooMany = $derived(chosen.length > limit);

  // Phrases the user can add with one click. They name aspects of code, not a
  // language.
  const CHIPS = [
    'limits and modes',
    'error paths',
    'lifecycle: setup and teardown',
    'the happy path only',
    'when work is flushed or committed',
  ];

  function addChip(chip: string) {
    const sentence = 'Emphasise ' + chip + '.';
    text = text.trim() ? text.trim() + ' ' + sentence : sentence;
  }

  async function search() {
    const wanted = query.trim();
    hits = wanted
      ? (await api.filesSearch(wanted, 6)).filter(
          (hit) => hit.relPath !== ask?.subject,
        )
      : [];
  }

  function addFile(path: string) {
    if (!rows.some((row) => row.path === path))
      rows = [...rows, { path, why: 'added by you' }];
    ticked[path] = true;
    query = '';
    hits = [];
  }

  // The job as it would start now, without the instructions, for the line
  // that says how long the film usually takes to make. It is null while the
  // companion files are still being looked for.
  const planned = $derived(
    ask && !loading
      ? {
          kind: 'animate' as const,
          subject: [ask.subject],
          companions: chosen,
          lengthSeconds: FILM_SECONDS[length],
          scope: ask.scope,
        }
      : null,
  );

  function start() {
    if (!ask || tooMany) return;
    if (app.settings && length !== app.settings.filmLength)
      app.saveSettings({ ...app.settings, filmLength: length });
    app.startJob({
      kind: 'animate',
      subject: [ask.subject],
      companions: chosen,
      instructions: text.trim(),
      lengthSeconds: FILM_SECONDS[length],
      scope: ask.scope,
      thread: ask.thread,
    });
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      start();
    }
  }

  const LENGTHS: [keyof typeof FILM_SECONDS, string][] = [
    ['short', 'Short · ~1 min'],
    ['standard', 'Standard · ~3 min'],
    ['deep', 'Deep · ~5 min'],
  ];
</script>

{#if ask}
  <div
    class="scrim"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) app.dialog = null;
    }}
  >
    <div class="dialog animate" role="dialog" aria-labelledby="animate-title">
      <h2 id="animate-title">
        {ask.regenerate ? 'Make the film again for' : 'Animate'}
        {subjectName}
      </h2>
      <p class="lead">
        The agent follows one piece of work through this file and the companion
        files you tick, and makes a narrated film of it.
      </p>

      <div class="kicker">Companion files</div>
      <div class="companions" role="group" aria-label="Companion files">
        {#if loading}
          <p class="lead">Looking for files this one uses…</p>
        {:else if rows.length === 0}
          <p class="lead">
            No related files were found. The agent will work from this file
            alone, or you can add files below.
          </p>
        {/if}
        {#each rows as row (row.path)}
          <div class="companion">
            <label class="check"
              ><input type="checkbox" bind:checked={ticked[row.path]} />
              <span
                >{row.path}
                <div class="why">{row.why}</div></span
              ></label
            >
            <button
              class="ignore"
              type="button"
              title="Never suggest this file, or a folder it is in, as a companion"
              onclick={() => (ignoring = row.path)}>Ignore always…</button
            >
          </div>
        {/each}
      </div>
      <div class="field add-file">
        <input
          class="input"
          placeholder="Add another file by name…"
          spellcheck="false"
          bind:value={query}
          oninput={search}
          aria-label="Add a companion file"
        />
        {#if hits.length}
          <div class="hits">
            {#each hits as hit (hit.relPath)}<button
                class="hit"
                onclick={() => addFile(hit.relPath)}>{hit.relPath}</button
              >{/each}
          </div>
        {/if}
      </div>
      <div class="why" class:warn={tooMany}>
        {chosen.length} of at most {limit} companion files ticked.{tooMany
          ? ' Untick some: every file is read in full and costs time and tokens.'
          : ''}
      </div>

      <div class="field">
        <label for="animate-text">What the film should show (optional)</label>
        <textarea
          id="animate-text"
          class="input"
          rows="3"
          bind:value={text}
          onkeydown={onKey}
          placeholder="For example: follow one order from Submit to the store, and show what happens when the limit is hit"
        ></textarea>
      </div>
      <div class="chips">
        {#each CHIPS as chip}<button
            class="chip"
            type="button"
            onclick={() => addChip(chip)}>+ {chip}</button
          >{/each}
      </div>

      <div class="field">
        <span class="label">Length</span>
        <div class="seg">
          {#each LENGTHS as [value, label]}<button
              class="btn"
              class:on={length === value}
              onclick={() => (length = value)}>{label}</button
            >{/each}
        </div>
        <JobEstimate request={planned} />
      </div>
      {#if app.visualArtifact}<div class="why">
          The film starts from the blueprint this file already has, so the two
          show the same plant.
        </div>{/if}

      <div class="foot">
        <span class="pill version"
          >{app.activeAgent ? app.activeAgent.name : 'No agent available'}</span
        >
        <button class="btn" onclick={() => (app.dialog = null)}>Cancel</button>
        <button
          class="btn primary"
          disabled={!app.activeAgent || tooMany || loading}
          onclick={start}>{ask.regenerate ? 'Make it again' : 'Animate'}</button
        >
      </div>
    </div>
  </div>
  {#if ignoring}
    <IgnoreDialog
      path={ignoring}
      listed={rows.map((row) => row.path)}
      onclose={() => (ignoring = null)}
      onadded={afterIgnore}
    />
  {/if}
{/if}

<style>
  .companions {
    max-height: 232px;
    overflow: auto;
    border: 1px solid var(--shell-border-soft);
    border-radius: 8px;
    padding: 0 12px;
  }
  .companions .lead {
    margin: 10px 0;
  }
  /* One companion file: its tick box and name, and the button that ignores it
     for good. The button is faint until the pointer is over the row or the
     button has the keyboard focus. */
  .companion {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--shell-border-soft);
  }
  .companion:last-child {
    border-bottom: 0;
  }
  .companion :global(.check) {
    border-bottom: 0;
    min-width: 0;
  }
  .companion :global(.check span) {
    overflow-wrap: anywhere;
  }
  .ignore {
    height: 24px;
    padding: 0 10px;
    border-radius: 12px;
    border: 1px solid var(--shell-border);
    background: none;
    font-size: 11px;
    color: var(--shell-text-2);
    white-space: nowrap;
    opacity: 0.55;
  }
  .companion:hover .ignore,
  .ignore:focus-visible {
    opacity: 1;
  }
  .ignore:hover {
    border-color: var(--main);
    color: var(--main);
  }
  .add-file {
    position: relative;
    margin-top: 8px;
  }
  .add-file .input {
    width: 100%;
  }
  .hits {
    display: grid;
    border: 1px solid var(--shell-border);
    border-radius: 6px;
    margin-top: 4px;
    overflow: hidden;
  }
  .hit {
    border: 0;
    background: var(--ground);
    color: var(--ink);
    font: inherit;
    text-align: left;
    padding: 6px 10px;
    cursor: pointer;
  }
  .hit:hover {
    background: var(--shell-hover);
    color: var(--second);
  }
  .why {
    font-size: 11px;
    color: var(--muted);
    margin-top: 6px;
  }
  .why.warn {
    color: var(--main);
  }
</style>
