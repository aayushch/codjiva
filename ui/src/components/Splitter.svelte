<script lang="ts">
  // A thin handle on the edge between two panels. Dragging it reports how far the pointer has
  // moved since the drag began; the parent turns that into a new panel size.
  let { ondrag, onstart = () => {}, label }: { ondrag: (dx: number) => void; onstart?: () => void; label: string } = $props();

  let origin = 0;
  let active = $state(false);
</script>

<div class="splitter" class:active role="separator" aria-orientation="vertical" aria-label={label}
  onpointerdown={(e) => { active = true; origin = e.clientX; onstart(); e.currentTarget.setPointerCapture(e.pointerId); }}
  onpointermove={(e) => { if (active) ondrag(e.clientX - origin); }}
  onpointerup={() => (active = false)}></div>
