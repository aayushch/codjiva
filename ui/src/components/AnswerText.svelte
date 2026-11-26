<script lang="ts">
  import { answerBlocks, type AnswerPiece } from '$lib/discuss';
  import type { AnswerRef } from '$lib/ipc';
  import { app } from '$lib/state/app.svelte';

  // The text of one answer of a discussion. An agent writes an answer as
  // plain text with a few marks: backticks around names from the code, lines
  // that start with "-" for a list, and three backticks around lines of
  // code. This component shows those as code chips, a list and a code block.
  //
  // `refs` are the places in the code that the answer names and that the
  // core found to exist. Each is shown as a link that opens the file at that
  // line. A place that is not in `refs` stays plain, because it may not
  // exist.
  let { text, refs = [] }: { text: string; refs?: AnswerRef[] } = $props();
  const blocks = $derived(answerBlocks(text, refs));
</script>

{#snippet line(pieces: AnswerPiece[])}
  {#each pieces as piece}{#if piece.kind === 'ref'}<button
        class="ref inline"
        title="Open {piece.ref.path} at line {piece.ref.line}"
        onclick={() => app.selectFile(piece.ref.path, piece.ref.line)}
        >{piece.text}</button
      >{:else if piece.kind === 'code'}<code>{piece.text}</code
      >{:else}{piece.text}{/if}{/each}
{/snippet}

<div class="answer-text">
  {#each blocks as block}
    {#if block.kind === 'paragraph'}
      <p>{@render line(block.pieces)}</p>
    {:else if block.kind === 'list'}
      <ul>
        {#each block.items as item}<li>{@render line(item)}</li>{/each}
      </ul>
    {:else}
      <pre>{block.text}</pre>
    {/if}
  {/each}
</div>
