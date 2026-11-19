<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import ArtifactFrame from './ArtifactFrame.svelte';

  // Shows a still visual or a step-through in the sandboxed frame, with zoom
  // controls over its corner. Panning, zooming with the wheel, hovering and
  // clicking are handled by the visual itself.
  //
  // `steps` is true for a step-through. A step-through has a strip of panels
  // along the bottom of its frame, so the zoom controls are placed above that
  // strip and not in the corner, where they would cover it.
  //
  // The height of the strip. The page inside the frame draws the strip, and
  // the user sets its height by dragging the strip's top edge there. The page
  // and this component exchange the height in `panel` messages.
  //   - When the page reports `ready` for a step-through, this component
  //     sends it `app.stepPanelHeight`, the height the user chose last, or
  //     null if they never chose one.
  //   - The page reports the height the strip has whenever it changes. That
  //     height is kept in `stripHeight` and places the zoom controls. It can
  //     be less than the height sent, because the page keeps room for the
  //     drawing in a low window.
  //   - When the report says the user dragged the strip (`byUser`), the
  //     height also becomes `app.stepPanelHeight`, which the app saves with
  //     its layout.
  // A step-through built before the strip could be resized ignores the
  // message and reports nothing. Its strip is always STRIP_DEFAULT tall.
  let {
    src,
    title,
    steps = false,
    onselect = () => {},
  }: {
    src: string;
    title: string;
    steps?: boolean;
    onselect?: (nodeId: string | null) => void;
  } = $props();

  let frame: ReturnType<typeof ArtifactFrame> | undefined = $state();
  let canvas: HTMLDivElement | undefined = $state();
  let problem = $state<string | null>(null);
  // The height of the strip, in pixels, until the page reports another.
  const STRIP_DEFAULT = 190;
  let stripHeight = $state(STRIP_DEFAULT);

  export function send(message: Record<string, unknown>) {
    frame?.send(message);
  }

  function onmessage(message: any) {
    if (message.cj === 'selected') onselect(message.nodeId);
    // A step-through reports the state that the step on screen is in.
    else if (message.cj === 'step') app.stepNode = message.nodeId ?? null;
    else if (message.cj === 'ready') {
      if (message.stepper) send({ cj: 'panel', height: app.stepPanelHeight });
    } else if (message.cj === 'panel') {
      if (typeof message.height !== 'number') return;
      stripHeight = message.height;
      if (message.byUser) app.stepPanelHeight = message.height;
    } else if (message.cj === 'picked') {
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
  <div
    class="zoomctl"
    class:above-strip={steps}
    style:--strip-h="{stripHeight}px"
  >
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
