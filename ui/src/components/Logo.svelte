<script lang="ts">
  // The Codjiva mark: code brackets with a packet of work between them.
  let { size = 16 }: { size?: number } = $props();
</script>

<svg width={size * 1.125} height={size} viewBox="0 0 18 16" fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M5.5 3.5 2 8l3.5 4.5" stroke="var(--accent)" />
  <path d="M12.5 3.5 16 8l-3.5 4.5" stroke="var(--ink)" />
  <rect x="6.6" y="5.9" width="4.8" height="4.2" rx="1" fill="var(--main)" />
</svg>
