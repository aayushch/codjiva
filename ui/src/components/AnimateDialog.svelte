<script lang="ts">
  import { tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { api, type Suggestion } from '$lib/ipc';
  import { orderOf } from '$lib/companions';
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
  // The files that match `query` are `hits`. They are shown in a list that
  // lies over the dialog, below the search field, so the dialog keeps its
  // height whatever the number of files is. The list scrolls when it has more
  // files than fit.
  let query = $state('');
  let hits = $state<{ relPath: string; name: string }[]>([]);
  // How many matching files the search asks for at most.
  const HIT_LIMIT = 40;
  // The greatest height of the list of matching files, in pixels.
  const LIST_HEIGHT = 264;
  // The list opens above the search field when less than this many pixels are
  // free below the field and more are free above it.
  const LIST_ROOM = 120;
  // The space between the search field and the list, in pixels.
  const LIST_GAP = 4;
  // The space the list keeps from the top and the bottom edge of the window,
  // in pixels.
  const WINDOW_EDGE = 12;
  // The element that holds the search field and the list.
  let finder: HTMLDivElement | undefined = $state();
  // The search field.
  let field: HTMLInputElement | undefined = $state();
  // True while the list of matching files is shown.
  let listOpen = $state(false);
  // Where the list is in the window, in pixels. `left` and `width` are those
  // of the search field. A list below the field has `top` and no `bottom`. A
  // list above the field has `bottom`, counted from the bottom edge of the
  // window, and no `top`. `height` is the greatest height the list has there.
  let listPlace = $state<{
    left: number;
    width: number;
    top: number | null;
    bottom: number | null;
    height: number;
  } | null>(null);

  // Works out `listPlace` from where the search field is in the window.
  function placeList() {
    if (!field) return;
    const box = field.getBoundingClientRect();
    const below = window.innerHeight - box.bottom - LIST_GAP - WINDOW_EDGE;
    const above = box.top - LIST_GAP - WINDOW_EDGE;
    const up = below < LIST_ROOM && above > below;
    listPlace = {
      left: box.left,
      width: box.width,
      top: up ? null : box.bottom + LIST_GAP,
      bottom: up ? window.innerHeight - box.top + LIST_GAP : null,
      height: Math.max(0, Math.min(LIST_HEIGHT, up ? above : below)),
    };
  }

  // While the list is shown, it follows the search field when the window
  // changes its size, and it is closed by a press of the pointer outside the
  // search field and the list. It is also closed when the dialog or the list
  // of companion files is scrolled, because the search field moves then.
  // Scrolling the list itself does not close it.
  $effect(() => {
    if (!listOpen) return;
    const onPress = (event: PointerEvent) => {
      if (!finder?.contains(event.target as Node)) listOpen = false;
    };
    const onScroll = (event: Event) => {
      if (!finder?.contains(event.target as Node)) listOpen = false;
    };
    window.addEventListener('resize', placeList);
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', placeList);
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  });

  // The position in `hits` of the file that Enter adds. It is drawn like a
  // file under the pointer. It is the first file when the list is filled,
  // the arrow keys move it, and the pointer moves it to the file it is over.
  let cursor = $state(0);
  // The element of the list of matching files.
  let list: HTMLDivElement | undefined = $state();

  // Moves `cursor` by `step` files, not past either end of the list, and
  // scrolls the list so that the file at `cursor` is in view.
  async function moveCursor(step: number) {
    cursor = Math.max(0, Math.min(hits.length - 1, cursor + step));
    await tick();
    const row = list?.children[cursor] as HTMLElement | undefined;
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    const rowEnd = row.offsetTop + row.offsetHeight;
    if (rowEnd > list.scrollTop + list.clientHeight)
      list.scrollTop = rowEnd - list.clientHeight;
  }

  // The keys of the search field and the list, while the list is shown.
  //   - The down and the up arrow move `cursor` to the next and the previous
  //     file.
  //   - Enter in the search field adds the file at `cursor`. Enter on a file
  //     that has the keyboard focus is left to that file's button, which
  //     adds it.
  //   - Escape closes the list and leaves the dialog open. The key press is
  //     kept from the handler of the window, which closes the dialog.
  function onFinderKey(event: KeyboardEvent) {
    if (!listOpen || !hits.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void moveCursor(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && event.target === field) {
      event.preventDefault();
      const hit = hits[cursor];
      if (hit) void addFile(hit.relPath);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      listOpen = false;
    }
  }

  // The keyboard focus left the search field or the list. The list is closed
  // when the focus went to an element outside both. `relatedTarget` is that
  // element. It is null when the focus went to nothing, which is what WebKit
  // reports while a file of the list is being clicked, so the list stays open
  // then and the click reaches the file.
  function onFinderFocusOut(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && !finder?.contains(next)) listOpen = false;
  }

  // Suggestions that score at least this much are ticked when the dialog opens.
  // A direct import scores 10 and a file of the same name 8; a file that only
  // mentions a name scores less.
  const TICK_FROM = 8;

  // Fills the list once, when the dialog opens. A regeneration starts from the
  // companions of the film on screen, all ticked, with the suggestions added
  // unticked. `shown` puts the rows in the order they are listed in.
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

  // The paths the user took the tick off by hand, the last one first.
  let unticked = $state<string[]>([]);
  // The rows in the order they are shown: the ticked files first, then the
  // files whose tick the user took off, then the other files. `orderOf` has
  // the details. A row moves to its new place when its file is ticked or its
  // tick is taken off.
  const shown = $derived(orderOf(rows, ticked, unticked));
  const chosen = $derived(
    shown.filter((row) => ticked[row.path]).map((row) => row.path),
  );

  // How long a row takes to move to a new place in the list, in
  // milliseconds.
  const MOVE_MS = 220;
  // The path of the file whose tick box the user changed last, or null when
  // that was more than `MOVE_MS` ago. Its row is drawn over the rows it
  // moves past.
  let moving = $state<string | null>(null);
  let movingTimer: ReturnType<typeof setTimeout> | undefined;

  // The user changed the tick box of the file at `path`, and `on` says
  // whether it is ticked now.
  function onTick(path: string, on: boolean) {
    unticked = unticked.filter((other) => other !== path);
    if (!on) unticked = [path, ...unticked];
    clearTimeout(movingTimer);
    moving = path;
    movingTimer = setTimeout(() => (moving = null), MOVE_MS);
  }

  // Moves a row from the place it had before the order of the rows changed,
  // `from`, to the place it has now, `to`. Svelte calls this for every row
  // whose position in the list changed. A user who asked the operating
  // system for less motion gets the rows in their new places at once.
  function slide(_row: Element, { from, to }: { from: DOMRect; to: DOMRect }) {
    const moved = from.top - to.top;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {
      duration: moved && !still ? MOVE_MS : 0,
      easing: cubicOut,
      css: (_done: number, left: number) =>
        `transform: translateY(${left * moved}px)`,
    };
  }
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

  // Reads the files that match `query` and shows them in the list.
  async function search() {
    const wanted = query.trim();
    hits = wanted
      ? (await api.filesSearch(wanted, HIT_LIMIT)).filter(
          (hit) => hit.relPath !== ask?.subject,
        )
      : [];
    cursor = 0;
    placeList();
    listOpen = true;
  }

  // How long the row of a file stays highlighted after the file was added
  // with the search, in milliseconds. It is the length of the
  // `companion-added` animation in the styles below.
  const ADDED_MS = 1200;
  // The path of the companion file whose row is highlighted, or null when no
  // row is highlighted.
  let added = $state<string | null>(null);
  let addedTimer: ReturnType<typeof setTimeout> | undefined;
  // The element of the list of companion files.
  let companions: HTMLDivElement | undefined = $state();

  // Adds the file at `path` to the list of companion files and ticks it. A
  // file that is already in the list is only ticked. The list is then
  // scrolled to the row of the file, and the row is highlighted for a
  // moment, so that the user sees where the file is.
  async function addFile(path: string) {
    if (!rows.some((row) => row.path === path))
      rows = [...rows, { path, why: 'added by you' }];
    ticked[path] = true;
    query = '';
    hits = [];
    // The highlight is taken off first, so that it starts from the beginning
    // for a file whose row is still highlighted.
    clearTimeout(addedTimer);
    added = null;
    await tick();
    added = path;
    addedTimer = setTimeout(() => (added = null), ADDED_MS);
    await tick();
    companions
      ?.querySelector('.companion.added')
      ?.scrollIntoView({ block: 'nearest' });
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
      <div
        class="companions"
        role="group"
        aria-label="Companion files"
        bind:this={companions}
      >
        {#if loading}
          <p class="lead">Looking for files this one uses…</p>
        {:else if rows.length === 0}
          <p class="lead">
            No related files were found. The agent will work from this file
            alone, or you can add files below.
          </p>
        {/if}
        {#each shown as row (row.path)}
          <div
            class="companion"
            class:added={row.path === added}
            class:moving={row.path === moving}
            animate:slide
          >
            <label class="check"
              ><input
                type="checkbox"
                bind:checked={ticked[row.path]}
                onchange={(event) =>
                  onTick(row.path, event.currentTarget.checked)}
              />
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
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="field add-file"
        bind:this={finder}
        onkeydown={onFinderKey}
        onfocusout={onFinderFocusOut}
      >
        <input
          class="input"
          placeholder="Add another file by name…"
          spellcheck="false"
          bind:this={field}
          bind:value={query}
          oninput={search}
          onfocus={() => {
            if (query.trim() && !listOpen) void search();
          }}
          aria-label="Add a companion file"
        />
        {#if listOpen && hits.length && listPlace}
          <div
            class="hits"
            style:left="{listPlace.left}px"
            style:width="{listPlace.width}px"
            style:top={listPlace.top == null ? null : `${listPlace.top}px`}
            style:bottom={listPlace.bottom == null
              ? null
              : `${listPlace.bottom}px`}
            style:max-height="{listPlace.height}px"
            role="listbox"
            aria-label="Matching files"
            bind:this={list}
          >
            {#each hits as hit, i (hit.relPath)}<button
                class="hit"
                class:on={i === cursor}
                role="option"
                aria-selected={i === cursor}
                onclick={() => void addFile(hit.relPath)}
                onmousemove={() => (cursor = i)}>{hit.relPath}</button
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
    position: relative;
    background: var(--shell-bar);
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--shell-border-soft);
  }
  .companion:last-child {
    border-bottom: 0;
  }
  /* The row whose tick box was changed moves over the rows it passes. The
     rows have the background of the dialog, so the text of the rows below
     does not show through the moving row. */
  .companion.moving {
    z-index: 1;
  }
  /* The row of a file that was just added with the search. A pale layer of
     the accent colour lies over the row and fades out. The layer is as wide
     as the list, which has 12 pixels of padding on each side of the row. */
  .companion.added::after {
    content: '';
    position: absolute;
    inset: 0 -12px;
    background: var(--main);
    opacity: 0;
    pointer-events: none;
    animation: companion-added 1200ms ease-out;
  }
  @keyframes companion-added {
    0%,
    25% {
      opacity: 0.18;
    }
    100% {
      opacity: 0;
    }
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
  /* The list of matching files. It is placed in the window and not in the
     dialog, so it takes no room in the dialog and the scrolling box of the
     dialog does not cut it off. The script gives it its place, its width and
     its greatest height. Scrolling past its end does not scroll the dialog. */
  .hits {
    position: fixed;
    z-index: 1;
    display: grid;
    border: 1px solid var(--shell-border);
    border-radius: 6px;
    background: var(--ground);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .hit {
    border: 0;
    background: var(--ground);
    color: var(--ink);
    font: inherit;
    text-align: left;
    padding: 6px 10px;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  /* The file that Enter adds. The pointer moves this to the file it is
     over, so a file under the pointer is drawn the same way. */
  .hit.on {
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
