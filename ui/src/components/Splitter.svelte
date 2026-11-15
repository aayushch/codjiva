<script lang="ts">
  // A thin handle on the edge between two panels. Dragging it reports how far the pointer has
  // moved since the drag began; the parent turns that into a new panel size.
  //
  // `axis` is the direction the handle is dragged in. With 'x' the handle is an upright line
  // between a panel on the left and one on the right. With 'y' it is a level line between a
  // panel above and one below.
  let { ondrag, onstart = () => {}, label, axis = 'x' }: { ondrag: (moved: number) => void; onstart?: () => void; label: string; axis?: 'x' | 'y' } = $props();

  let origin = 0;
  let active = $state(false);
  const positionOf = (event: PointerEvent) => (axis === 'x' ? event.clientX : event.clientY);
</script>

<div class="splitter" class:level={axis === 'y'} class:active role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-label={label}
  onpointerdown={(e) => { active = true; origin = positionOf(e); onstart(); e.currentTarget.setPointerCapture(e.pointerId); }}
  onpointermove={(e) => { if (active) ondrag(positionOf(e) - origin); }}
  onpointerup={() => (active = false)}></div>
