<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import Icon from './Icon.svelte';

  // What the Visual and Film tabs show for a file that has no artifact of that kind yet: the
  // file's facts and the buttons that make one. For a selected folder it shows how much code
  // the folder holds and what a visual of all of it would cost to make.
  const info = $derived(app.fileInfo);
  const folder = $derived(app.folderInfo);
  const onFilmTab = $derived(app.tab === 'film');
  // True while a job is running for the file or folder on screen.
  const busy = $derived(app.job?.status === 'running' && app.job.subject === app.selected);
  const busyLabel = $derived(app.job?.request.kind === 'animate' ? 'Animating…' : app.job?.request.kind === 'feedback' ? 'Changing…' : 'Visualising…');
  const noAgent = $derived(app.agentsLoaded && !app.activeAgent);
  const blocked = $derived(!info || info.binary || noAgent || app.job?.status === 'running');
  const has = $derived(app.visualArtifact && app.filmArtifact ? 'a visual and a film' : app.visualArtifact ? 'a visual, no film yet' : app.filmArtifact ? 'a film, no visual yet' : 'no visuals yet');
  // An estimate in thousands of tokens, as "about 12 thousand tokens".
  const tokens = (n: number) => (n < 1000 ? 'under a thousand tokens' : `about ${Math.round(n / 1000).toLocaleString()} thousand tokens`);
</script>

<div class="empty">
  <div class="card">
    {#if app.selectedIsFolder}
      <span class="empty-icon"><Icon name="dir" size={34} /></span>
      {#if folder}
        <div class="fname">{folder.name}/</div>
        <div class="path">{folder.relPath}/</div>
        <div class="meta">
          <span>{folder.files.length} code file{folder.files.length === 1 ? '' : 's'}</span><span>·</span>
          <span>{tokens(folder.estimatedTokens)}</span>
        </div>
        <div class="actions">
          {#if busy}
            <button class="btn" disabled>Visualising…</button>
          {:else}
            <button class="btn primary" disabled={folder.tooLarge || folder.files.length === 0 || noAgent || app.job?.status === 'running'} onclick={() => app.askInstructions()}><Icon name="viz" size={16} />Visualise this folder…</button>
          {/if}
        </div>
        {#if folder.files.length === 0}
          <div class="hint warn">This folder holds no code files.</div>
        {:else if folder.tooLarge}
          <div class="warn-box"><b>This folder is too large to draw as one visual.</b> An agent cannot read {folder.files.length} files, {tokens(folder.estimatedTokens)}, at once. Choose a folder inside it, or visualise single files.</div>
        {:else}
          <div class="warn-box"><b>{folder.large ? 'This is a large folder.' : 'A folder costs more than a file.'}</b> The agent reads all {folder.files.length} files, {tokens(folder.estimatedTokens)}, before it draws. That takes longer and uses more of your agent's allowance than one file{folder.large ? ', possibly many times more' : ''}.</div>
        {/if}
        {#if noAgent}<div class="hint warn">{app.agents.find((a) => a.note)?.note ?? 'No agent was found on this machine.'}</div>{/if}
        <div class="hint">A folder's visual shows how its files work together, not the inside of each one.</div>
      {:else}
        <div class="path">Reading…</div>
      {/if}
    {:else}
      <span class="empty-icon"><Icon name="file" size={34} /></span>
      {#if info}
        <div class="fname">{info.name}</div>
        <div class="path">{info.relPath}</div>
        <div class="meta">
          <span>{info.lang ?? 'Unknown type'}</span><span>·</span>
          <span>{info.binary ? 'binary file' : info.lines != null ? `${info.lines.toLocaleString()} lines` : 'very large file'}</span><span>·</span>
          <span>{has}</span>
        </div>
        <div class="actions">
          {#if busy}
            <button class="btn" disabled>{busyLabel}</button>
          {:else if onFilmTab}
            <button class="btn primary" disabled={blocked} onclick={() => app.askAnimate()}><Icon name="play" size={16} />Animate with companions…</button>
            {#if !app.visualArtifact}<button class="btn" disabled={blocked} onclick={() => app.askInstructions()}><Icon name="viz" size={16} />Visualise</button>{/if}
          {:else}
            <button class="btn primary" disabled={blocked} onclick={() => app.askInstructions()}><Icon name="viz" size={16} />Visualise</button>
            <button class="btn" disabled={blocked} onclick={() => app.askAnimate()}><Icon name="play" size={16} />Animate with companions…</button>
          {/if}
        </div>
        {#if noAgent}
          <div class="hint warn">{app.agents.find((a) => a.note)?.note ?? 'No agent was found on this machine.'}</div>
        {/if}
        <div class="hint">
          Visualise draws a still, explorable blueprint. Animate reads companion files and makes a film.<br />
          Output is saved in <code>{app.info?.dotDir ?? '.codjiva'}/</code> as plain HTML.
        </div>
      {:else}
        <div class="path">Reading…</div>
      {/if}
    {/if}
  </div>
</div>
