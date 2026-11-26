<script lang="ts">
  import {
    NOTES_RUNTIME,
    olderThan,
    targetKey,
    type ShownNote,
    type Target,
  } from '$lib/discuss';
  import type { AskAbout, VisualNode } from '$lib/ipc';
  import { kindWord, showsFilm } from '$lib/artifacts';
  import { formatTime } from '$lib/tree';
  import { app } from '$lib/state/app.svelte';
  import { discuss } from '$lib/state/discuss.svelte';
  import AnswerText from './AnswerText.svelte';

  // The discussion about a visual or about a part of a file: the questions
  // the user asked, the answers, and the box in which the next question is
  // written. The inspector shows it beside a visual, and the panel beside
  // the source view shows it for the selected code.
  //
  // The props:
  //   - `target` says what the discussion is about and which visual is on
  //     screen (see `Target`).
  //   - `about` is what the user is looking at now: the part selected in the
  //     visual, or the moment of a film. It is sent with a question.
  //   - `aboutLabel` is that as a few words for the user, or null.
  //   - `nodes` are the parts of the visual, to name the part a note is on.
  //   - `runtimeVersion` is the runtime the version on screen was built
  //     with, or null when no visual is on screen.
  //   - `onnote` is called when the user clicks a note in an answer, so
  //     that the component that holds the visual can show the note there.
  //   - `focus` is a number. The question box takes the keyboard focus
  //     whenever it changes.
  //
  // A target can have several discussions. The newest is shown, a menu
  // chooses another, and "New discussion" starts one. A question continues
  // the conversation the agent already has about the target, so it is
  // answered by an agent that has read the code.
  //
  // Notes. An answer about a visual can put notes on parts of it. They are
  // listed under the answer, and a click on one shows it on the visual. A
  // visual that was built before the runtime could draw notes shows a line
  // that offers to build it again, which takes no agent.
  let {
    target,
    about = {},
    aboutLabel = null,
    nodes = [],
    runtimeVersion = null,
    onnote = () => {},
    focus = 0,
  }: {
    target: Target;
    about?: AskAbout;
    aboutLabel?: string | null;
    nodes?: VisualNode[];
    runtimeVersion?: string | null;
    onnote?: (note: ShownNote) => void;
    focus?: number;
  } = $props();

  const key = $derived(targetKey(target));
  const threads = $derived(discuss.threadsFor(target));
  const thread = $derived(discuss.shown(target));
  const artifact = $derived(target.artifact ?? null);
  // What the thing on screen is called in a sentence: "blueprint", "film",
  // or "code" when no visual is on screen.
  const word = $derived(artifact ? kindWord(artifact) : 'code');
  const isFilm = $derived(showsFilm(artifact));
  // The question that is waiting for its answer, when it was asked here.
  const pending = $derived(
    discuss.pending?.key === key ? discuss.pending : null,
  );
  // The notes on the visual on screen, with their numbers.
  const notes = $derived(artifact ? discuss.notesFor(artifact.id) : []);
  const numberOf = (id: string) => notes.find((one) => one.id === id)?.n;
  // True when the version on screen was built before notes could be drawn.
  const tooOld = $derived(
    runtimeVersion != null && olderThan(runtimeVersion, NOTES_RUNTIME),
  );
  // True while a job is making a new version of the visual on screen. A
  // question would continue the same agent conversation, so none is asked
  // meanwhile.
  const busy = $derived(
    !!artifact &&
      app.jobs.some(
        (job) => job.status === 'running' && job.artifactId === artifact.id,
      ),
  );

  let box: HTMLTextAreaElement | undefined = $state();
  let log: HTMLDivElement | undefined = $state();
  // A second click on the delete button confirms it.
  let confirming = $state(false);

  function send() {
    const text = discuss.drafts[key] ?? '';
    if (!text.trim() || pending || busy) return;
    discuss.ask(target, text, about);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  }

  // What a note is on, for the user: the name of its part, or the moment of
  // the film.
  const placeOf = (note: ShownNote) =>
    note.time != null
      ? formatTime(note.time)
      : (nodes.find((node) => node.id === note.part)?.label ?? note.part ?? '');

  function showNote(note: ShownNote) {
    discuss.focusNote = note.id;
    discuss.notesOn = true;
    onnote(note);
  }

  const when = (iso: string) =>
    new Date(iso).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });

  // Keeps the newest message in view: when a question is asked, while the
  // agent works, and when the answer arrives.
  $effect(() => {
    void [thread?.messages.length, pending?.said, pending?.activity, key];
    if (log) log.scrollTop = log.scrollHeight;
  });

  $effect(() => {
    if (focus) box?.focus();
  });
</script>

<div class="ask">
  {#if threads.length}
    <div class="ask-head">
      {#if threads.length > 1 || !thread}
        <select
          class="select"
          aria-label="Discussion"
          value={thread?.id ?? ''}
          onchange={(event) => {
            const id = event.currentTarget.value;
            if (id) discuss.choose(target, id);
            else discuss.startNew(target);
          }}
        >
          {#if !thread}<option value="">New discussion</option>{/if}
          {#each threads as one (one.id)}
            <option value={one.id}>{one.title}</option>
          {/each}
        </select>
      {:else}
        <span class="ask-title" title={thread.title}>{thread.title}</span>
      {/if}
      {#if thread}
        <button
          class="btn small"
          title="Start another discussion about this {word}"
          onclick={() => {
            discuss.startNew(target);
            box?.focus();
          }}>New</button
        >
        <button
          class="btn small"
          class:armed={confirming}
          title={confirming
            ? 'Click again to delete this discussion and its notes'
            : 'Delete this discussion'}
          disabled={!!pending}
          onclick={() => {
            if (!confirming) return void (confirming = true);
            confirming = false;
            discuss.deleteThread(thread.id);
          }}
          onblur={() => (confirming = false)}
          >{confirming ? 'Delete?' : 'Delete'}</button
        >
      {/if}
    </div>
  {/if}

  {#if artifact && notes.length}
    <div class="ask-notes">
      <button
        class="layer"
        role="switch"
        aria-checked={discuss.notesOn}
        onclick={() => (discuss.notesOn = !discuss.notesOn)}
      >
        <span class="switch" class:on={discuss.notesOn}></span>Notes on the {word}
        · {notes.length}
      </button>
      {#if tooOld && target.version != null}
        {@const version = target.version}
        <p class="ask-old">
          This {word} was built before notes could be drawn on it.
          <button
            class="btn small"
            disabled={discuss.updating !== null || busy}
            onclick={() => discuss.update(artifact, version)}
            >{discuss.updating === artifact.id
              ? 'Updating…'
              : 'Update it'}</button
          >
          No agent is needed.
        </p>
      {/if}
    </div>
  {/if}

  <div class="ask-log" bind:this={log}>
    {#if !thread && !pending}
      <p class="muted">
        {#if artifact}
          Ask anything about this {word} or the code behind it. The agent that drew
          it answers, and can put notes on its parts.
        {:else}
          Ask anything about this code. The answer names the lines it relies on.
        {/if}
      </p>
    {/if}
    {#each thread?.messages ?? [] as message, at (at)}
      {#if message.role === 'user'}
        <div class="ask-q">
          <div class="ask-who">
            {message.author || 'You'} · {when(message.createdAt)}
          </div>
          <div class="ask-words">{message.text}</div>
        </div>
      {:else}
        <div class="ask-a">
          <div class="ask-who">
            {message.author}{message.model ? ' · ' + message.model : ''}
          </div>
          <AnswerText text={message.text} refs={message.refs ?? []} />
          {#each message.notes ?? [] as raw (raw.id)}
            {@const note = notes.find((one) => one.id === raw.id)}
            {#if note}
              <button
                class="ask-note"
                class:flag={note.kind === 'flag'}
                class:on={discuss.focusNote === note.id}
                title="Show this note on the {word}"
                onclick={() => showNote(note)}
              >
                <span class="n">{numberOf(note.id)}</span>
                <span class="where">{placeOf(note)}</span>
                {#if note.text}<span class="t">{note.text}</span>{/if}
              </button>
            {/if}
          {/each}
          {#if artifact && target.version != null && thread && at === (thread.messages.length ?? 0) - 1}
            {@const version = target.version}
            <button
              class="btn small ask-apply"
              disabled={busy || !!pending || !app.activeAgent}
              title="Make a new version of the {word} that shows what this discussion found"
              onclick={() => discuss.apply(artifact, version, thread)}
              >Change the {word} from this…</button
            >
          {/if}
        </div>
      {/if}
    {/each}
    {#if pending}
      <div class="ask-q">
        <div class="ask-who">You</div>
        <div class="ask-words">{pending.text}</div>
      </div>
      <div class="ask-a waiting">
        <div class="ask-who">
          {pending.agent ?? 'Starting the agent'}{pending.continues
            ? ' · continues the conversation'
            : ''}
        </div>
        {#if pending.notice}<p class="muted">{pending.notice}</p>{/if}
        {#if pending.said}
          <AnswerText text={pending.said} />
        {:else}
          <p class="muted">{pending.activity || 'Thinking'}…</p>
        {/if}
        <button class="btn small" onclick={() => discuss.cancel()}>Stop</button>
      </div>
    {/if}
  </div>

  <div class="ask-box">
    <textarea
      class="input"
      rows="2"
      bind:this={box}
      bind:value={discuss.drafts[key]}
      onkeydown={onKey}
      aria-label="Question"
      placeholder={artifact
        ? isFilm
          ? 'Ask about this film. For example: why is the batch kept here?'
          : 'Ask about this ' + word + '. For example: where can this fail?'
        : 'Ask about this code. For example: when is this called?'}></textarea>
    <div class="line">
      {#if aboutLabel}<span class="pill" title="Sent with your question"
          >{aboutLabel}</span
        >{/if}
      <span class="grow"></span>
      <button
        class="btn small primary"
        disabled={!(discuss.drafts[key] ?? '').trim() ||
          !!discuss.pending ||
          busy ||
          !app.activeAgent}
        title={busy
          ? `A new version of this ${word} is being made. Ask when that job has finished.`
          : discuss.pending && !pending
            ? 'Another question is waiting for its answer.'
            : undefined}
        onclick={send}>Ask</button
      >
    </div>
  </div>
</div>
