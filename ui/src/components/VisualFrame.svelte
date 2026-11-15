<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import ArtifactFrame from './ArtifactFrame.svelte';

  // Shows a still visual in the sandboxed frame, with zoom controls over its
  // corner. Panning, zooming with the wheel, hovering and clicking are handled
  // by the visual itself.
  let {
    src,
    title,
    onselect = () => {},
  }: {
    src: string;
    title: string;
    onselect?: (nodeId: string | null) => void;
  } = $props();

  let frame: ReturnType<typeof ArtifactFrame> | undefined = $state();
  let canvas: HTMLDivElement | undefined = $state();
  let problem = $state<string | null>(null);

  export function send(message: Record<string, unknown>) {
    frame?.send(message);
  }

  function onmessage(message: any) {
    if (message.cj === 'selected') onselect(message.nodeId);
    else if (message.cj === 'picked') {
      // The user pointed at an element for their feedback.
      app.picked =
        message.selector || message.part ? { ...message, cj: undefined } : null;
      app.picking = false;
      if (!app.picked)
        app.notify(
          'Nothing with a name is drawn there. Click a part, a label or a marker.',
        );
    } else if (message.cj === 'error') problem = message.message;
  }

  // While this visual is on screen, the rest of the app reaches it through
  // `app.frameSend`, for example to switch a layer from the inspector, and asks
  // `app.frameRect` where it is.
  $effect(() => {
    const rect = () => canvas?.getBoundingClientRect() ?? null;
    app.frameSend = send;
    app.frameRect = rect;
    return () => {
      if (app.frameSend === send) app.frameSend = null;
      if (app.frameRect === rect) app.frameRect = null;
    };
  });
</script>

<div class="canvas" bind:this={canvas}>
  <ArtifactFrame bind:this={frame} {src} {title} {onmessage} />
  {#if problem}<div class="frame-problem">{problem}</div>{/if}
  <div class="zoomctl">
    <button
      class="btn tip-up tip-end"
      aria-label="Zoom out"
      data-tip="Zoom out"
      onclick={() => send({ cj: 'zoom', factor: 0.8 })}>−</button
    >
    <button
      class="btn tip-up tip-end"
      aria-label="Fit"
      data-tip="Fit the whole visual"
      onclick={() => send({ cj: 'fit' })}>⤢</button
    >
    <button
      class="btn tip-up tip-end"
      aria-label="Zoom in"
      data-tip="Zoom in"
      onclick={() => send({ cj: 'zoom', factor: 1.25 })}>+</button
    >
  </div>
</div>
