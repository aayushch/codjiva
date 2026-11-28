<script lang="ts">
  import { VIEWS } from '$lib/artifacts';
  import { targetOfArtifact } from '$lib/jobs';
  import type { ArtifactKind } from '$lib/ipc';
  import { GIT_LETTER, gitTitle, statusOf } from '$lib/gitStatus';
  import { isPicture, previewKindOf } from '$lib/preview';
  import { app, type MenuItem } from '$lib/state/app.svelte';
  import { ancestorsOf, type TreeRow } from '$lib/tree';
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
  // visual or a film. The row of such a folder has a small dot at its right
  // end, so that a closed folder shows that it leads to one. The dot is
  // smaller than the one a file or folder has for its own visual.
  //
  // The background of a row is left for two things only: the selected row
  // and the row under the mouse.
  const holds = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const path of badges.keys()) {
      for (const dir of ancestorsOf(path))
        counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
    return counts;
  });
  // What git says about the file or folder of a row, or null when git
  // reports no change for it. The name of such a row has the colour of the
  // status. The row of a file also has the letter of the status at its right
  // end. A folder has the colour only, and it has the colour when a changed
  // file is somewhere inside it, so that the way to a changed file can be
  // followed through closed folders.
  const gitOf = (row: TreeRow) =>
    statusOf(app.gitMarks, row.entry.relPath, row.entry.kind === 'dir');
  // The tooltip of a row: its path, then what git says about it, then how
  // many files and folders inside it have a visual or a film. `inside` is
  // that number.
  function titleOf(row: TreeRow, inside: number) {
    const parts = [row.entry.relPath];
    const git = gitOf(row);
    if (git) parts.push(gitTitle(git, row.entry.kind === 'dir'));
    if (inside)
      parts.push(
        `${inside} inside ${inside === 1 ? 'has' : 'have'} a blueprint or a film`,
      );
    return parts.join(' · ');
  }
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

  // The selected path whose row the effect below has scrolled to. It is a
  // plain variable and not `$state`, so that writing it does not run the
  // effect again.
  let revealed: string | null = null;

  // When the selection changes, this effect moves the cursor to the selected
  // row. A selection can be made outside the tree, for example through
  // quick-open or a file tab, and its row may be scrolled out of view at that
  // moment. In that case the tree is scrolled so that the row is in the
  // middle, with its neighbours above and below it. A row that is already in
  // view stays where it is, so that a click on a row never moves the tree.
  //
  // It does this once for each selection. The effect also runs when `rows`
  // changes, because the selected row can be added to `rows` after the
  // selection was made. Once the row of the selected path has been scrolled
  // to, a change of `rows` does nothing here. So the user can scroll away
  // from the selected file and open or close other folders, and the tree
  // stays where they scrolled it.
  $effect(() => {
    if (!viewport || selectedPath === revealed) return;
    if (selectedPath == null) {
      revealed = null;
      return;
    }
    const index = rows.findIndex((r) => r.entry.relPath === selectedPath);
    if (index < 0) return;
    revealed = selectedPath;
    cursor = index;
    if (!inView(index)) centre(index);
  });

  // True when the whole row at `index` is in the visible part of the tree.
  function inView(index: number) {
    if (!viewport) return false;
    const top = index * ROW_HEIGHT;
    return (
      top >= viewport.scrollTop &&
      top + ROW_HEIGHT <= viewport.scrollTop + viewport.clientHeight
    );
  }

  // Scrolls the tree so that the row at `index` is in the middle of the
  // visible part. For a row near the start or the end of the tree, the
  // browser stops at the end of the scroll range, so the row is as close to
  // the middle as the tree allows.
  function centre(index: number) {
    if (!viewport) return;
    viewport.scrollTop =
      index * ROW_HEIGHT - (viewport.clientHeight - ROW_HEIGHT) / 2;
  }

  // Scrolls the tree just far enough that the row at `index` is in view.
  // The arrow keys use this, so that the tree moves one row at a time.
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

  // The commands of the context menu of a row.
  //
  // A file has Visualise, Animate and Step through. A folder has Visualise
  // only, because a film and a step-through follow one file. When the file or
  // folder has an artifact of that kind already, the command says "again"
  // and its dialog starts from the instructions of that version.
  //
  // A command that starts a job is disabled while no agent is available, and
  // while a job is already making that visual or that film.
  //
  // Below those are the views that the runtime draws from data: the schema,
  // lanes and structure views for a file, and the map for a folder.
  //
  // Both kinds of row can copy their path: the full path on this computer,
  // or the path inside the workspace.
  function menuFor(row: TreeRow): MenuItem[] {
    const isDir = row.entry.kind === 'dir';
    // A folder is selected by its path with a slash at the end.
    const path = row.entry.relPath + (isDir ? '/' : '');
    const noAgent = app.agentsLoaded && !app.activeAgent;
    const has = (kind: ArtifactKind) =>
      app.artifacts.some(
        (a) => a.kind === kind && a.subject[0] === path && !a.scope,
      );
    const making = (kind: ArtifactKind) =>
      app.isBusy(targetOfArtifact({ kind, subject: [path] }));
    const items: MenuItem[] = [
      {
        label: isDir
          ? has('visual')
            ? 'Visualise this folder again…'
            : 'Visualise this folder…'
          : has('visual')
            ? 'Visualise again…'
            : 'Visualise…',
        disabled: noAgent || making('visual'),
        action: () => app.visualise(path),
      },
    ];
    if (!isDir)
      items.push(
        {
          label: has('film') ? 'Animate again…' : 'Animate…',
          disabled: noAgent || making('film'),
          action: () => app.animate(path),
        },
        {
          label: has('stepthrough') ? 'Step through again…' : 'Step through…',
          disabled: noAgent || making('stepthrough'),
          action: () => app.stepThrough(path),
        },
      );
    // The views: a map for a folder, and the other three for a file.
    items.push('separator');
    for (const view of VIEWS) {
      if ((view.name === 'map') !== isDir) continue;
      const what =
        view.name === 'map' ? 'Map this folder' : view.label + ' view';
      items.push({
        label: what + (has(view.name) ? ' again…' : '…'),
        disabled: noAgent || making(view.name),
        action: () => app.makeView(path, view.name),
      });
    }
    // A file that can be shown rendered, such as an SVG picture or an HTML
    // page, has a command that opens it that way.
    if (!isDir && previewKindOf(path))
      items.push('separator', {
        label: 'Preview',
        action: () => app.openPreview(path),
      });
    // In a git repository, a file of text can show its changes. A file
    // that git reports as changed opens on what is not committed, and the
    // command says so.
    if (!isDir && app.gitRepo && !isPicture(path))
      items.push('separator', {
        label: gitOf(row) ? 'Show changes' : 'Show history',
        action: () => app.openDiff(path),
      });
    items.push(
      'separator',
      { label: 'Copy path', action: () => app.copyPath(path, true) },
      { label: 'Copy relative path', action: () => app.copyPath(path) },
    );
    return items;
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
        {@const git = gitOf(row)}
        <div
          class="row"
          class:selected={row.entry.relPath === selectedPath}
          class:cursor={index === cursor}
          style:--depth={row.depth}
          data-git={git}
          role="treeitem"
          aria-selected={row.entry.relPath === selectedPath}
          aria-expanded={row.entry.kind === 'dir' ? row.expanded : undefined}
          tabindex="-1"
          title={titleOf(row, inside)}
          onclick={() => activate(index)}
          onkeydown={() => {}}
          oncontextmenu={(event) => {
            cursor = index;
            app.openMenu(event, menuFor(row));
          }}
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
          {#if git && row.entry.kind === 'file'}
            <span class="git-letter">{GIT_LETTER[git]}</span>
          {/if}
          {#if badges.has(row.entry.relPath)}
            <span
              class="badge dot"
              class:hollow={badges.get(row.entry.relPath)}
              title={badges.get(row.entry.relPath)
                ? 'Has a blueprint that is stale'
                : 'Has a blueprint'}
            ></span>
          {:else if inside > 0}
            <span class="dot inside"></span>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
