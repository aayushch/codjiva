<script lang="ts">
  // A thin handle on the edge between two panels. Dragging it reports how far the pointer has
  // moved since the drag began; the parent turns that into a new panel size.
  //
  // `axis` is the direction the handle is dragged in. With 'x' the handle is an upright line
  // between a panel on the left and one on the right. With 'y' it is a level line between a
  // panel above and one below.
  //
  // `onend` is called when the pointer is released, with the distance it had moved by then. A
  // distance near zero means the handle was clicked and not dragged.
  let { ondrag, onstart = () => {}, onend = () => {}, label, hint, axis = 'x' }: {
    ondrag: (moved: number) => void; onstart?: () => void; onend?: (moved: number) => void; label: string; hint?: string; axis?: 'x' | 'y';
  } = $props();

  let origin = 0;
  let moved = 0;
  let active = $state(false);
  const positionOf = (event: PointerEvent) => (axis === 'x' ? event.clientX : event.clientY);
  function end() {
    if (!active) return;
    active = false;
    onend(moved);
  }
</script>

<div class="splitter" class:level={axis === 'y'} class:active role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label} title={hint}
  onpointerdown={(e) => { active = true; moved = 0; origin = positionOf(e); onstart(); e.currentTarget.setPointerCapture(e.pointerId); }}
  onpointermove={(e) => { if (active) { moved = positionOf(e) - origin; ondrag(moved); } }}
  onpointerup={end} onpointercancel={end}></div>
