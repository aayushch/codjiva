<script lang="ts">
  import { formatTime } from '$lib/tree';
  import { app } from '$lib/state/app.svelte';
  import { discuss } from '$lib/state/discuss.svelte';
  import ArtifactFrame from './ArtifactFrame.svelte';
  import Icon from './Icon.svelte';

  import type { Chapter } from '$lib/ipc';

  // Shows a film in the sandboxed frame with the app's own transport bar under
  // it. The film keeps its own clock; this component sends it commands and
  // mirrors the state it reports.
  //
  // With `feedback` set, the player also serves the feedback box in the
  // inspector: it keeps `app.filmMoment` up to date, lets the user pin a moment
  // by holding Alt while clicking the scrubber, and passes on the element the
  // user pointed at.
  //
  // Notes. `artifactId` is the id of the artifact the film is, or null for a
  // film that is not an artifact of the workspace, which has no notes. The
  // notes that answers of discussions put on that artifact are
  // sent to the film when it is ready, and again whenever they change or are
  // switched on or off. The film shows each note for a few seconds from its
  // moment. Each note also has a mark on the scrubber. A film built before
  // notes existed ignores the message, and only the marks show.
  let {
    src,
    title,
    feedback = false,
    artifactId = null,
    onready = () => {},
    onchapter = () => {},
  }: {
    src: string;
    title: string;
    feedback?: boolean;
    artifactId?: string | null;
    onready?: (chapters: Chapter[]) => void;
    onchapter?: (index: number) => void;
  } = $props();

  let canvas: HTMLDivElement | undefined = $state();

  let frame: ReturnType<typeof ArtifactFrame> | undefined = $state();
  let bar: HTMLDivElement | undefined = $state();
  let ready = $state(false);
  let duration = $state(0);
  let chapters = $state<Chapter[]>([]);
  let t = $state(0);
  let chapter = $state(0);
  let playing = $state(false);
  let muted = $state(true);
  let rate = $state(1);
  let problem = $state<string | null>(null);
  let dragging = false;

  const notes = $derived(artifactId ? discuss.notesFor(artifactId) : []);
  $effect(() => {
    const list = notes.map((note) => ({
      id: note.id,
      n: note.n,
      time: note.time,
      kind: note.kind,
      text: note.text,
    }));
    if (ready) frame?.send({ cj: 'notes', notes: list, on: discuss.notesOn });
  });

  // The speeds on offer, as multiples of the film's normal speed.
  const SPEEDS = [0.75, 1, 1.25, 2, 4];
  // The fastest speed this film can play at. A film keeps the player code it
  // was built with, and films built by older versions of the app play at 2x at
  // most. `setSpeed` lowers this when the film does not reach the speed it was
  // asked for.
  let fastest = $state(4);

  // Asks the film for a speed. A short moment later the speed the film reports
  // is compared with the one asked for. If the film reports less, it cannot go
  // faster, so the faster speeds are disabled and the user is told why.
  function setSpeed(x: number) {
    frame?.send({ cj: 'speed', x });
    setTimeout(() => {
      if (rate >= x || rate >= fastest) return;
      fastest = rate;
      app.notify(
        `This film was made before ${x}× was added, so ${rate}× is its fastest speed. Make the film again to play it faster.`,
      );
    }, 400);
  }

  function onmessage(message: any) {
    if (message.cj === 'ready' && message.kind === 'film') {
      ready = true;
      duration = message.duration;
      chapters = message.chapters;
      onready(chapters);
      if (app.settings && !app.settings.soundOnByDefault)
        frame?.send({ cj: 'mute', on: true });
      // A film that was on screen before continues where the user left it. Back
      // and Forward name that moment in `app.resumeFilmAt`. Without it, the
      // time this film last reported is used. A film that had reached its end
      // starts again from the beginning.
      if (feedback) {
        const resumeAt = app.resumeFilmAt ?? app.filmTimes.get(src) ?? null;
        app.resumeFilmAt = null;
        if (resumeAt != null && resumeAt > 0 && resumeAt < duration - 1)
          seek(resumeAt);
      }
    } else if (message.cj === 'time') {
      if (!dragging) t = message.t;
      if (message.chapter !== chapter) onchapter(message.chapter);
      chapter = message.chapter;
      playing = message.playing;
      muted = message.muted;
      rate = message.rate;
      if (feedback && ready) app.filmTimes.set(src, message.t);
      if (feedback)
        app.filmMoment = {
          t: message.t,
          chapter: message.chapter,
          chapterTitle: chapters[message.chapter]?.title ?? '',
          scene: message.scene ?? '',
          sceneT: message.sceneT ?? 0,
        };
    } else if (message.cj === 'picked' && feedback) {
      app.picked =
        message.selector || message.part ? { ...message, cj: undefined } : null;
      app.picking = false;
      if (!app.picked)
        app.notify(
          'Nothing with a name is drawn there. Click a part, a label or a bubble.',
        );
    } else if (message.cj === 'key' && message.key === 'f') {
      app.setTheater(!app.theater);
    } else if (message.cj === 'error') {
      problem = message.message;
    }
  }

  const seek = (x: number) => {
    t = Math.max(0, Math.min(duration, x));
    frame?.send({ cj: 'seek', t });
  };

  // While this film is on screen, the rest of the app reaches it through
  // `app.frameSend`, for example to seek to a chapter from the inspector, and
  // asks `app.frameRect` where it is.
  $effect(() => {
    if (!feedback) return;
    const send = (message: Record<string, unknown>) => frame?.send(message);
    const rect = () => canvas?.getBoundingClientRect() ?? null;
    app.frameSend = send;
    app.frameRect = rect;
    return () => {
      if (app.frameSend === send) app.frameSend = null;
      if (app.frameRect === rect) app.frameRect = null;
    };
  });

  // A press on the scrubber seeks. With Alt held it also pins that moment for
  // the feedback box.
  function onScrubDown(event: PointerEvent) {
    dragging = true;
    bar!.setPointerCapture(event.pointerId);
    const at = timeAt(event);
    if (feedback && event.altKey) {
      frame?.send({ cj: 'pause' });
      app.pinnedTime = Math.round(at * 10) / 10;
    }
    seek(at);
  }
  const toggle = () => frame?.send({ cj: playing ? 'pause' : 'play' });

  const timeAt = (event: PointerEvent) => {
    const r = bar!.getBoundingClientRect();
    return (
      Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * duration
    );
  };

  // The same keys the film handles when it has the keyboard itself.
  function onKey(event: KeyboardEvent) {
    const el = event.target as HTMLElement;
    if (app.dialog || el.closest('input, textarea, select, [role="tree"]'))
      return;
    // A key pressed with Alt, Control or Command belongs to the app, for
    // example Back.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space') {
      event.preventDefault();
      toggle();
    } else if (event.key === 'ArrowRight') seek(t + 5);
    else if (event.key === 'ArrowLeft') seek(t - 5);
    else if (event.key === 'PageDown') frame?.send({ cj: 'chapter', dir: 1 });
    else if (event.key === 'PageUp') frame?.send({ cj: 'chapter', dir: -1 });
    else if (event.key === 'm' || event.key === 'M')
      frame?.send({ cj: 'mute', on: !muted });
    else if (event.key === 'f' || event.key === 'F')
      app.setTheater(!app.theater);
    else if (event.key === 'Escape' && app.theater) app.setTheater(false);
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="canvas" bind:this={canvas}>
  <ArtifactFrame bind:this={frame} {src} {title} {onmessage} />
  {#if problem}<div class="frame-problem">{problem}</div>{/if}
</div>
<div class="player" class:waiting={!ready}>
  <button
    class="ibtn tip-up tip-start"
    aria-label={playing ? 'Pause' : 'Play'}
    data-tip="{playing ? 'Pause' : 'Play'} (Space)"
    onclick={toggle}
    ><Icon name={playing ? 'pause' : 'play'} size={16} /></button
  >
  <span class="chap"
    >{chapters.length
      ? `${chapter + 1} / ${chapters.length} · ${chapters[chapter]?.name ?? ''}`
      : ''}</span
  >
  <div
    class="scrub"
    bind:this={bar}
    role="slider"
    tabindex="0"
    aria-label="Position"
    aria-valuemin={0}
    aria-valuemax={Math.round(duration)}
    aria-valuenow={Math.round(t)}
    title={feedback
      ? 'Click to seek. Hold Alt and click to pin a moment for your feedback.'
      : 'Seek'}
    onpointerdown={onScrubDown}
    onpointermove={(e) => {
      if (dragging) seek(timeAt(e));
    }}
    onpointerup={() => (dragging = false)}
  >
    <div
      class="fill"
      style:width="{duration ? (t / duration) * 100 : 0}%"
    ></div>
    <div class="knob" style:left="{duration ? (t / duration) * 100 : 0}%"></div>
    {#each chapters.slice(1) as c (c.id)}<span
        class="mark"
        style:left="{(c.start / duration) * 100}%"
        title={c.name}
      ></span>{/each}
    {#if discuss.notesOn && duration}
      {#each notes as note (note.id)}
        {#if note.time != null}<span
            class="note-mark"
            class:flag={note.kind === 'flag'}
            style:left="{(note.time / duration) * 100}%"
            title="Note {note.n}: {note.text}"
          ></span>{/if}
      {/each}
    {/if}
    {#if feedback && app.pinnedTime != null && duration}<span
        class="pin"
        style:left="{(app.pinnedTime / duration) * 100}%"
        title="Pinned for your feedback"
      ></span>{/if}
  </div>
  <span class="time">{formatTime(t)} / {formatTime(duration)}</span>
  <select
    class="select"
    aria-label="Speed"
    title="Playback speed"
    value={String(rate)}
    onchange={(e) => setSpeed(Number(e.currentTarget.value))}
  >
    {#each SPEEDS as speed}<option
        value={String(speed)}
        disabled={speed > fastest}>{speed}×</option
      >{/each}
  </select>
  <button
    class="ibtn tip-up"
    aria-label={muted ? 'Turn sound on' : 'Mute'}
    data-tip="{muted ? 'Turn sound on' : 'Mute'} (M)"
    onclick={() => frame?.send({ cj: 'mute', on: !muted })}
    ><Icon name={muted ? 'sound-off' : 'sound-on'} size={16} /></button
  >
  <button
    class="ibtn tip-up tip-end"
    aria-label="Full screen"
    data-tip="{app.theater ? 'Leave full screen' : 'Full screen'} (F)"
    onclick={() => app.setTheater(!app.theater)}
    ><Icon name="full" size={16} /></button
  >
</div>
