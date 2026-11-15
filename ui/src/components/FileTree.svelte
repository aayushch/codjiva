<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import { ancestorsOf } from '$lib/tree';
  import Icon from './Icon.svelte';

  // Every row is ROW_HEIGHT pixels tall, so the rows in view can be worked out
  // from the scroll position alone. Only those rows, plus OVERSCAN above and
  // below, are in the page. That keeps a folder with tens of thousands of files
  // as fast as a small one.
  const ROW_HEIGHT = 26;
  const OVERSCAN = 12;

  let viewport: HTMLDivElement | undefined = $state();
  let scrollTop = $state(0);
  let height = $state(600);
  // The row that arrow keys move from. It follows the selection, and moves with
  // the keys.
  let cursor = $state(0);

  const rows = $derived(app.rows);

  // For each file or folder that is the subject of an artifact: whether any of
  // those artifacts is stale. A folder's subject path ends with a slash, which
  // the tree's own paths do not.
  const badges = $derived.by(() => {
    const found = new Map<string, boolean>();
    for (const artifact of app.artifacts) {
      for (const subject of artifact.subject) {
        const path = subject.replace(/\/$/, '');
        found.set(path, (found.get(path) ?? false) || artifact.stale);
      }
    }
    return found;
  });
  // For each folder, how many files and folders somewhere inside it have a
  // visual or a film. The row of such a folder is tinted, so that a closed
  // folder shows that it leads to one.
  const holds = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const path of badges.keys()) {
      for (const dir of ancestorsOf(path))
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    return counts;
  });
  // The path of the selected row. A selected folder's path is stored with a
  // trailing slash.
  const selectedPath = $derived(app.selected?.replace(/\/$/, '') ?? null);
  const first = $derived(
    Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN),
  );
  const last = $derived(
    Math.min(
      rows.length,
      Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
    ),
  );
  const visible = $derived(rows.slice(first, last));

  $effect(() => {
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      height = viewport!.clientHeight;
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  });

  // Keeps the cursor on the selected file and scrolls its row into view when
  // the selection changes from outside the tree, for example through
  // quick-open.
  $effect(() => {
    const index = rows.findIndex((r) => r.entry.relPath === selectedPath);
    if (index >= 0) {
      cursor = index;
      reveal(index);
    }
  });

  function reveal(index: number) {
    if (!viewport) return;
    const top = index * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = top + ROW_HEIGHT - viewport.clientHeight;
  }

  function activate(index: number) {
    const row = rows[index];
    if (!row) return;
    cursor = index;
    if (row.entry.kind === 'dir') app.toggleDir(row.entry.relPath);
    else app.selectFile(row.entry.relPath);
  }

  function onKey(event: KeyboardEvent) {
    const row = rows[cursor];
    let next = cursor;
    if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, cursor + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, cursor - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(cursor);
      return;
    } else if (event.key === 'ArrowRight' && row?.entry.kind === 'dir') {
      // Right opens a closed folder, and steps into an open one.
      if (!row.expanded) app.toggleDir(row.entry.relPath);
      else next = Math.min(rows.length - 1, cursor + 1);
    } else if (event.key === 'ArrowLeft' && row) {
      // Left closes an open folder. On anything else it moves to the folder
      // that contains it.
      if (row.entry.kind === 'dir' && row.expanded)
        app.toggleDir(row.entry.relPath);
      else
        for (let i = cursor - 1; i >= 0; i--)
          if (rows[i].depth < row.depth) {
            next = i;
            break;
          }
    } else return;
    event.preventDefault();
    cursor = next;
    reveal(next);
  }
</script>

<div
  class="tree"
  role="tree"
  tabindex="0"
  aria-label="Files"
  bind:this={viewport}
  onscroll={() => (scrollTop = viewport!.scrollTop)}
  onkeydown={onKey}
>
  <div class="tree-sizer" style:height="{rows.length * ROW_HEIGHT}px">
    <div style:transform="translateY({first * ROW_HEIGHT}px)">
      {#each visible as row, i (row.entry.relPath)}
        {@const index = first + i}
        {@const inside = holds.get(row.entry.relPath) ?? 0}
        <div
          class="row"
          class:selected={row.entry.relPath === selectedPath}
          class:cursor={index === cursor}
          class:holds={inside > 0}
          style:--depth={row.depth}
          role="treeitem"
          aria-selected={row.entry.relPath === selectedPath}
          aria-expanded={row.entry.kind === 'dir' ? row.expanded : undefined}
          tabindex="-1"
          title={inside
            ? `${row.entry.relPath} · ${inside} inside ${inside === 1 ? 'has' : 'have'} a visual or a film`
            : row.entry.relPath}
          onclick={() => activate(index)}
          onkeydown={() => {}}
        >
          <span class="chev"
            >{row.entry.kind === 'dir' ? (row.expanded ? '▾' : '▸') : ''}</span
          >
          <Icon name={row.entry.kind === 'dir' ? 'dir' : 'file'} />
          <span class="name">{row.entry.name}</span>
          {#if row.entry.kind === 'dir'}
            <button
              class="tb-btn folder-viz tip-end"
              title=""
              data-tip="Visualise this folder as a whole"
              aria-label="Visualise the folder {row.entry.name}"
              onclick={(e) => {
                e.stopPropagation();
                cursor = index;
                app.selectFolder(row.entry.relPath);
              }}><Icon name="viz" size={13} /></button
            >
          {/if}
          {#if badges.has(row.entry.relPath)}
            <span
              class="badge dot"
              class:hollow={badges.get(row.entry.relPath)}
              title={badges.get(row.entry.relPath)
                ? 'Has a visual that is stale'
                : 'Has a visual'}
            ></span>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
