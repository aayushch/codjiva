<script lang="ts">
  import { untrack } from 'svelte';
  import { api, type IgnoreCheck } from '$lib/ipc';
  import { scopesFor } from '$lib/ignore';
  import { app } from '$lib/state/app.svelte';

  // A small dialog over the Animate dialog. It adds one pattern to the `companionIgnore`
  // setting, so that a suggested companion file, or a whole folder it is in, is never suggested
  // again for any file.
  //
  // `path` is the companion file the user clicked "Ignore always" on. `listed` are the paths of
  // all companion files the Animate dialog lists at the moment. `onclose` is called when the
  // dialog should be removed. `onadded` is called after the pattern was saved, with the paths
  // from `listed` that the new pattern matches.
  let { path, listed, onclose, onadded }: { path: string; listed: string[]; onclose: () => void; onadded: (matchedPaths: string[]) => void } = $props();

  // The file itself, then each folder it is in, from the nearest folder up to the top one.
  const scopes = $derived(scopesFor(path));
  // The pattern that will be saved. It starts as the pattern for the file itself. Choosing a
  // folder from the list replaces it, and the user can also edit it by hand.
  let pattern = $state(untrack(() => scopesFor(path)[0].pattern));
  let check = $state<IgnoreCheck | null>(null);
  let saving = $state(false);

  const trimmed = $derived(pattern.trim());
  const already = $derived(!!app.settings?.companionIgnore.includes(trimmed));
  const invalid = $derived(!!check && check.invalid.length > 0);
  // A pattern that does not match the file the user clicked on is allowed, but the user is told.
  const missesFile = $derived(!!check && !invalid && !check.matchedPaths.includes(path));

  // Asks the desktop app what the pattern matches, a short moment after the last keystroke.
  $effect(() => {
    const wanted = trimmed;
    check = null;
    if (!wanted) return;
    const timer = setTimeout(() => {
      api.companionsIgnoreCheck([wanted], listed).then((result) => { if (wanted === pattern.trim()) check = result; }).catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  });

  async function add() {
    if (!app.settings || !trimmed || invalid || already || saving) return;
    saving = true;
    // The check on screen can be for an older text of the pattern, so it is made again for the
    // text that is saved.
    const result = await api.companionsIgnoreCheck([trimmed], listed).catch(() => null);
    await app.saveSettings({ ...app.settings, companionIgnore: [...app.settings.companionIgnore, trimmed] });
    saving = false;
    onadded(result?.matchedPaths ?? []);
  }

  // Escape closes only this dialog. The key press is handled before it reaches the app's own
  // key handler, which would close the Animate dialog under it.
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onclose();
  }
</script>

<svelte:window onkeydowncapture={onKey} />

<div class="scrim over" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="dialog ignore" role="dialog" aria-labelledby="ignore-title">
    <h2 id="ignore-title">Never suggest as a companion</h2>
    <p class="lead">Choose how much to ignore. Files that match are left out of the companion list of every file, in every workspace.</p>

    <div class="scopes" role="radiogroup" aria-label="What to ignore">
      {#each scopes as scope (scope.pattern)}
        <label class="scope" class:on={trimmed === scope.pattern}>
          <input type="radio" name="ignore-scope" checked={trimmed === scope.pattern} onchange={() => (pattern = scope.pattern)} />
          <span class="what">{scope.shown}</span>
          <span class="kind">{scope.folder ? 'this folder and everything in it' : 'only this file'}</span>
        </label>
      {/each}
    </div>

    <div class="field">
      <label for="ignore-pattern">Pattern</label>
      <input id="ignore-pattern" class="input" spellcheck="false" autocomplete="off" bind:value={pattern} onkeydown={(e) => { if (e.key === 'Enter') add(); }} />
      <div class="why" class:warn={invalid || missesFile}>
        {#if !trimmed}Type a pattern, or choose a line above.
        {:else if already}This pattern is already in the ignore list.
        {:else if invalid}This cannot be read as a pattern.
        {:else if check}
          Matches {check.matched} code file{check.matched === 1 ? '' : 's'} in this workspace{check.matchedPaths.length ? `, ${check.matchedPaths.length} of them in the list of companions` : ''}.
          {#if missesFile} It does not match {path.split('/').pop()}.{/if}
        {:else}Checking…{/if}
      </div>
      <div class="why">Written like a line of a <code>.gitignore</code> file. A leading <code>/</code> means the top of the workspace, so <code>/vendor/</code> is that one folder and <code>vendor/</code> is every folder of that name. <code>*</code> stands for any part of a name, as in <code>*.pb.go</code>.</div>
    </div>

    <div class="foot">
      <span class="why note">Change the list later in Settings, under Companion files.</span>
      <button class="btn" onclick={onclose}>Cancel</button>
      <button class="btn primary" disabled={!trimmed || invalid || already || saving} onclick={add}>Ignore always</button>
    </div>
  </div>
</div>

<style>
  /* Drawn over the Animate dialog, which has its own backdrop. */
  .scrim.over { z-index:60 }
  .dialog.ignore { width:min(560px, 92vw) }
  .scopes { display:grid; border:1px solid var(--shell-border-soft); border-radius:8px; max-height:190px; overflow:auto }
  .scope { display:grid; grid-template-columns:18px minmax(0, 1fr) auto; gap:10px; align-items:center; padding:7px 12px; cursor:pointer; border-bottom:1px solid var(--shell-border-soft) }
  .scope:last-child { border-bottom:0 }
  .scope:hover, .scope.on { background:var(--shell-button) }
  .scope .what { color:var(--second); overflow-wrap:anywhere }
  .scope .kind { font-size:11px; color:var(--muted) }
  .field .input { width:100% }
  .why { font-size:11px; color:var(--muted) }
  .why.warn { color:var(--main) }
  .why.note { flex:1; min-width:0 }
  .foot .btn { flex:none; white-space:nowrap }
</style>
