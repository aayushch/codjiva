<script lang="ts">
  import { app } from '$lib/state/app.svelte';
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <div class="toast" class:error={toast.kind === 'error'}>{toast.text}</div>
  {/each}
</div>
