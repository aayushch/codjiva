<script lang="ts">
  import { api, type IgnoreCheck, type Settings } from '$lib/ipc';
  import { parsePatterns } from '$lib/ignore';
  import {
    app,
    CODE_FONT_DEFAULT,
    CODE_FONT_MAX,
    CODE_FONT_MIN,
    codeFontSize,
  } from '$lib/state/app.svelte';
  import { updater } from '$lib/state/updater.svelte';
  import ApiProviders from './ApiProviders.svelte';

  // The Settings dialog. The list on the left names the sections, and the area
  // on the right shows the section that is chosen. Every change is saved at
  // once; there is no Save button.
  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (!app.settings) return;
    app.saveSettings({ ...app.settings, [key]: value });
  }

  const SECTIONS = [
    ['agent', 'Agent', 'Which coding agent draws your blueprints and films.'],
    [
      'keys',
      'API keys',
      'With a key, the app talks to a model provider itself and no agent program is needed.',
    ],
    ['jobs', 'Jobs', 'How much effort and money one job may take.'],
    ['films', 'Films', 'How new films are made and played.'],
    [
      'companions',
      'Companion files',
      'Which other files are suggested when you animate a file.',
    ],
    ['editor', 'Source code', 'How files open in your own editor.'],
    [
      'appearance',
      'Appearance',
      'The colours of the app and the size of code.',
    ],
    ['updates', 'Updates', 'Newer versions of Codjiva.'],
  ] as const;
  type Section = (typeof SECTIONS)[number][0];
  let section = $state<Section>('agent');
  const current = $derived(SECTIONS.find(([id]) => id === section)!);

  const lengths: [Settings['filmLength'], string][] = [
    ['short', '~1 min'],
    ['standard', '~3 min'],
    ['deep', '~5 min'],
  ];
  const efforts: [Settings['effort'], string][] = [
    ['auto', 'Automatic'],
    ['low', 'Low'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['agent', 'Agent decides'],
  ];
  // The size of code that the Appearance section shows and changes by one
  // pixel at a time.
  const codeSize = $derived(codeFontSize(app.settings?.codeFontSize));
  const themes: [Settings['theme'], string][] = [
    ['system', 'Match the system'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ];

  // The Updates section. `checked` is what the check the user asked for
  // found: 'latest' if this app is the newest version, 'failed' if the
  // release could not be asked, and null before a check and when a newer
  // version was found, which the section shows by itself.
  let checked = $state<'latest' | 'failed' | null>(null);
  async function checkNow() {
    checked = null;
    const asked = await updater.check();
    if (!asked) checked = 'failed';
    else if (updater.status === 'idle') checked = 'latest';
  }
  const lastChecked = $derived(
    updater.lastCheckedAt == null
      ? 'not yet'
      : new Date(updater.lastCheckedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
  );

  // What the saved ignore patterns match in the open workspace. It is asked for
  // again whenever the Companion files section is shown or the patterns change.
  let ignoreCheck = $state<IgnoreCheck | null>(null);
  $effect(() => {
    const patterns = app.settings?.companionIgnore;
    if (section !== 'companions' || !patterns) return;
    ignoreCheck = null;
    api
      .companionsIgnoreCheck(patterns, [])
      .then((result) => {
        ignoreCheck = result;
      })
      .catch(() => {});
  });
</script>

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) app.dialog = null;
  }}
>
  <div class="dialog settings" role="dialog" aria-labelledby="settings-title">
    <nav class="sections" aria-label="Settings sections">
      <h2 id="settings-title">Settings</h2>
      <div role="tablist" aria-orientation="vertical">
        {#each SECTIONS as [id, name] (id)}
          <button
            class="section"
            class:on={section === id}
            role="tab"
            aria-selected={section === id}
            aria-controls="settings-pane"
            onclick={() => (section = id)}>{name}</button
          >
        {/each}
      </div>
    </nav>

    <div
      class="pane"
      id="settings-pane"
      role="tabpanel"
      aria-label={current[1]}
    >
      <h3>{current[1]}</h3>
      <p class="lead">{current[2]}</p>
      {#if app.settings}
        {@const s = app.settings}

        {#if section === 'agent'}
          {#each app.agents as agent (agent.id)}
            <label class="check" class:off={!agent.ok}>
              <input
                type="radio"
                name="agent"
                disabled={!agent.ok}
                checked={app.activeAgent?.id === agent.id}
                onchange={() => set('agent', agent.id)}
              />
              <span
                >{agent.name}{agent.version ? ' · ' + agent.version : ''}
                <div class="why">
                  {agent.ok ? (agent.path ?? '') : 'Not available'}{agent.note
                    ? (!agent.ok || agent.path ? ' · ' : '') + agent.note
                    : ''}
                </div>
                {#if agent.ok && agent.limits}<div class="why limits">
                    {agent.limits}
                  </div>{/if}</span
              >
            </label>
          {:else}
            <p class="lead">
              {app.agentsLoaded
                ? 'No agents are known to this version of the app.'
                : 'Looking for agents…'}
            </p>
          {/each}
          {#if app.activeAgent && app.activeAgent.kind !== 'api'}
            <div class="field">
              <label for="set-model">Model for {app.activeAgent.name}</label>
              <input
                id="set-model"
                class="input"
                value={s.models[app.activeAgent.id] ?? ''}
                placeholder={app.activeAgent.defaultModel ??
                  "the agent's own default"}
                spellcheck="false"
                onchange={(e) =>
                  set('models', {
                    ...s.models,
                    [app.activeAgent!.id]: e.currentTarget.value.trim(),
                  })}
              />
              <div class="why">
                {#if app.activeAgent.defaultModel}Leave empty to use <code
                    >{app.activeAgent.defaultModel}</code
                  >, which is quick and draws well. Type another model's name to
                  use that one.{:else}Leave empty to use the model the agent
                  chooses by itself.{/if}
              </div>
            </div>
          {/if}
          {#if app.activeAgent?.plainArgs?.length}
            <label class="check"
              ><input
                type="checkbox"
                checked={s.agentCustomizations}
                onchange={(e) =>
                  set('agentCustomizations', e.currentTarget.checked)}
              />
              <span
                >Let {app.activeAgent.name} load my own setup
                <div class="why">
                  With this off, Codjiva starts {app.activeAgent.name} with
                  <code>{app.activeAgent.plainArgs.join(' ')}</code>, which
                  keeps out {app.activeAgent.plainNote ||
                    'the setup you made for it'}, so that it does not change
                  what a job draws. Turn this on to start it without
                  <code>{app.activeAgent.plainArgs.join(' ')}</code>.
                </div></span
              ></label
            >
          {/if}
          <button class="btn small rescan" onclick={() => app.loadAgents(true)}
            >Look for agents again</button
          >
        {:else if section === 'keys'}
          <ApiProviders />
        {:else if section === 'jobs'}
          <div class="field">
            <span class="label">Thinking effort</span>
            <div class="seg">
              {#each efforts as [value, label]}<button
                  class="btn"
                  class:on={s.effort === value}
                  onclick={() => set('effort', value)}>{label}</button
                >{/each}
            </div>
            <div class="why">
              How long the model thinks before it draws. Higher effort takes
              longer and costs more. Automatic uses low effort for a blueprint
              and medium for a film.
            </div>
          </div>
          <div class="field">
            <label for="set-budget">Spending limit per job (US dollars)</label>
            <input
              id="set-budget"
              class="input"
              type="number"
              min="0"
              step="0.5"
              value={s.maxBudgetUsd ?? ''}
              placeholder="none"
              onchange={(e) =>
                set(
                  'maxBudgetUsd',
                  e.currentTarget.value === ''
                    ? null
                    : Math.max(0, Number(e.currentTarget.value)),
                )}
            />
            <div class="why">
              Applies to agents that can enforce a limit. Leave empty for no
              limit.
            </div>
          </div>
          <div class="field">
            <label for="set-fix">Fix rounds</label>
            <input
              id="set-fix"
              class="input"
              type="number"
              min="0"
              max="6"
              value={s.maxFixIterations}
              onchange={(e) =>
                set(
                  'maxFixIterations',
                  Math.min(
                    6,
                    Math.max(0, Math.round(Number(e.currentTarget.value)) || 0),
                  ),
                )}
            />
            <div class="why">
              How many times a result that fails its checks is sent back to the
              agent before you are asked. A round that only repairs a result
              that could not be built or drawn is not counted, once per job.
            </div>
          </div>
        {:else if section === 'films'}
          <div class="field">
            <span class="label">Length of new films</span>
            <div class="seg">
              {#each lengths as [value, label]}<button
                  class="btn"
                  class:on={s.filmLength === value}
                  onclick={() => set('filmLength', value)}>{label}</button
                >{/each}
            </div>
          </div>
          <label class="check"
            ><input
              type="checkbox"
              checked={s.soundOnByDefault}
              onchange={(e) => set('soundOnByDefault', e.currentTarget.checked)}
            />
            <span
              >Start films with sound on
              <div class="why">Films start muted unless this is on.</div></span
            ></label
          >
          <div class="field">
            <label for="set-speed">Base playback speed</label>
            <input
              id="set-speed"
              class="input"
              type="number"
              min="0.3"
              max="1"
              step="0.05"
              value={s.basePlaybackSpeed}
              onchange={(e) =>
                set(
                  'basePlaybackSpeed',
                  Math.min(
                    1,
                    Math.max(0.3, Number(e.currentTarget.value) || 0.6),
                  ),
                )}
            />
            <div class="why">
              How fast new films run between explanations. 0.6 is easy to
              follow. The speed control under a film multiplies this.
            </div>
          </div>
        {:else if section === 'companions'}
          <div class="field">
            <label for="set-companions">Most companion files</label>
            <input
              id="set-companions"
              class="input"
              type="number"
              min="1"
              max="40"
              value={s.maxCompanionFiles}
              onchange={(e) =>
                set(
                  'maxCompanionFiles',
                  Math.min(
                    40,
                    Math.max(
                      1,
                      Math.round(Number(e.currentTarget.value)) || 12,
                    ),
                  ),
                )}
            />
            <div class="why">
              The most files an Animate job reads besides the file itself.
            </div>
          </div>
          <div class="field">
            <label for="set-ignore">Never suggest these files and folders</label
            >
            <textarea
              id="set-ignore"
              class="input patterns"
              rows="8"
              spellcheck="false"
              autocomplete="off"
              placeholder={'vendor/\n/internal/generated/\n*.pb.go'}
              value={s.companionIgnore.join('\n')}
              onchange={(e) =>
                set('companionIgnore', parsePatterns(e.currentTarget.value))}
            ></textarea>
            <div class="why">
              One pattern per line, written like a line of a <code
                >.gitignore</code
              > file. The list applies to every workspace.
            </div>
            <ul class="why forms">
              <li>
                <code>vendor/</code> every folder named vendor, with everything in
                it
              </li>
              <li>
                <code>/internal/generated/</code> that one folder, counted from the
                top of the workspace
              </li>
              <li><code>*.pb.go</code> every file whose name ends that way</li>
              <li>
                <code>!vendor/ours/</code> an exception to an earlier line
              </li>
            </ul>
            {#if ignoreCheck}
              {#if ignoreCheck.invalid.length}<div class="why warn">
                  Cannot be read as a pattern, and matches nothing: {#each ignoreCheck.invalid as bad}<code
                      >{bad}</code
                    >{' '}{/each}
                </div>{/if}
              {#if app.workspace}<div class="why matched">
                  These patterns match {ignoreCheck.matched} code file{ignoreCheck.matched ===
                  1
                    ? ''
                    : 's'} in {app.workspace.name}{ignoreCheck.examples.length
                    ? ', for example ' +
                      ignoreCheck.examples.slice(0, 2).join(' and ')
                    : ''}.
                </div>{/if}
            {/if}
            <div class="why">
              A file you add by name in the Animate dialog is used even when a
              pattern matches it. The Animate dialog can also add to this list:
              use “Ignore always…” next to a suggested file.
            </div>
          </div>
        {:else if section === 'editor'}
          <div class="field">
            <label for="set-editor">External editor command</label>
            <input
              id="set-editor"
              class="input"
              value={s.externalEditorCommand}
              spellcheck="false"
              onchange={(e) =>
                set('externalEditorCommand', e.currentTarget.value)}
            />
            <div class="why">
              <code>{'{file}'}</code> is replaced by the file's path and
              <code>{'{line}'}</code> by the line number.
            </div>
          </div>
        {:else if section === 'appearance'}
          <div class="field">
            <span class="label">Theme</span>
            <div class="seg">
              {#each themes as [value, label]}<button
                  class="btn"
                  class:on={s.theme === value}
                  aria-pressed={s.theme === value}
                  onclick={() => set('theme', value)}>{label}</button
                >{/each}
            </div>
            <div class="why">
              The colours of the window, and of the blueprints and films shown
              in it. A blueprint or a film made by an earlier version of the app
              stays dark until it is made again. An exported film is dark.
            </div>
          </div>
          <div class="field">
            <span class="label">Code size</span>
            <div class="stepper">
              <button
                class="btn"
                aria-label="Smaller code"
                disabled={codeSize <= CODE_FONT_MIN}
                onclick={() => set('codeFontSize', codeSize - 1)}>−</button
              >
              <span class="stepper-value" aria-live="polite">{codeSize} px</span
              >
              <button
                class="btn"
                aria-label="Larger code"
                disabled={codeSize >= CODE_FONT_MAX}
                onclick={() => set('codeFontSize', codeSize + 1)}>+</button
              >
              <button
                class="btn"
                disabled={codeSize === CODE_FONT_DEFAULT}
                onclick={() => set('codeFontSize', CODE_FONT_DEFAULT)}
                >Reset</button
              >
            </div>
            <div class="why">The size of the code in the source view.</div>
          </div>
        {:else if section === 'updates'}
          <div class="field">
            <span class="label">This version</span>
            <div class="update-row">
              {#if updater.status === 'ready'}
                <span>Version {updater.version} is installed.</span>
                <button class="btn primary" onclick={() => updater.relaunch()}
                  >Restart to use it</button
                >
              {:else if updater.status === 'downloading'}
                <span
                  >Downloading version {updater.version} · {updater.progress}%</span
                >
              {:else if updater.status === 'available'}
                <span>Version {updater.version} is available.</span>
                <button class="btn primary" onclick={() => updater.install()}
                  >Download and install</button
                >
              {:else}
                <span>Codjiva {app.info?.version}</span>
                <button
                  class="btn"
                  disabled={updater.status === 'checking'}
                  onclick={checkNow}
                  >{updater.status === 'checking'
                    ? 'Checking…'
                    : 'Check for updates'}</button
                >
                {#if checked === 'latest'}<span class="update-note"
                    >This is the newest version.</span
                  >{/if}
              {/if}
            </div>
            {#if updater.status === 'error'}
              <div class="why warn">
                {updater.version
                  ? 'The update could not be installed.'
                  : 'The check failed.'}
                {updater.error}
                <button class="link" onclick={() => api.openReleases()}
                  >Open the downloads page</button
                >
              </div>
            {/if}
            {#if updater.notes && updater.status !== 'idle'}
              <div class="why notes">{updater.notes}</div>
            {/if}
            <div class="why">
              Last checked: {lastChecked}. Codjiva asks GitHub for the newest
              release, downloads the installer for this system when you say so,
              and checks its signature before it installs it.
            </div>
          </div>
          <label class="check"
            ><input
              type="checkbox"
              checked={s.checkForUpdates}
              onchange={(e) => set('checkForUpdates', e.currentTarget.checked)}
            />
            <span
              >Look for updates automatically
              <div class="why">
                A few seconds after the app starts, and every two hours while it
                is open. With this off, Codjiva looks only when you click the
                button above.
              </div></span
            ></label
          >
        {/if}
      {/if}
    </div>

    <div class="foot">
      <span class="pill version"
        >{app.info?.name}
        {app.info?.version} · runtime {app.info?.runtimeVersion}</span
      ><span class="saved">Changes are saved as you make them.</span><button
        class="btn primary"
        onclick={() => (app.dialog = null)}>Done</button
      >
    </div>
  </div>
</div>

<style>
  /* The dialog has a fixed size so that it does not change shape from one
     section to the next. The list of sections is the left column over the full
     height. The right column holds the chosen section, which scrolls, and the
     bar with the Done button under it. */
  .dialog.settings {
    width: min(860px, 94vw);
    height: min(660px, 88vh);
    max-height: none;
    padding: 0;
    overflow: hidden;
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .sections {
    grid-row: 1 / 3;
    padding: 20px 10px;
    background: var(--shell-window);
    border-right: 1px solid var(--shell-border-soft);
    overflow: auto;
  }
  .sections h2 {
    margin: 0 0 14px;
    padding: 0 12px;
    font-size: 18px;
  }
  .sections [role='tablist'] {
    display: grid;
    gap: 2px;
  }
  .section {
    height: 32px;
    padding: 0 10px;
    border: 0;
    border-left: 2px solid transparent;
    border-radius: 6px;
    background: none;
    font: inherit;
    color: var(--shell-text-2);
    text-align: left;
  }
  .section:hover {
    background: var(--shell-button);
    color: var(--second);
  }
  .section.on {
    background: var(--shell-button);
    border-left-color: var(--main);
    color: var(--second);
    font-weight: 700;
  }
  .pane {
    padding: 20px 24px;
    overflow: auto;
  }
  .pane h3 {
    margin: 0 0 4px;
    font-size: 16px;
    color: var(--second);
  }
  .pane .seg {
    flex-wrap: wrap;
  }
  /* The "Look for agents again" button, below the last option of the Agent
     section. */
  .rescan {
    margin-top: 12px;
  }
  .patterns {
    width: 100%;
    resize: vertical;
    line-height: 1.6;
    min-height: 120px;
  }
  .forms {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 2px;
  }
  .why.warn {
    color: var(--main);
  }
  .why.matched {
    color: var(--shell-text-2);
  }
  /* The Updates section: the version, the button for the next step, and a
     short note after a check, on one line. */
  .update-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .update-note {
    color: var(--shell-text-2);
  }
  /* The text of a release keeps its own line breaks. */
  .why.notes {
    white-space: pre-wrap;
    max-height: 120px;
    overflow: auto;
  }
  .link {
    border: 0;
    padding: 0;
    background: none;
    font: inherit;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
  }
  .foot {
    grid-column: 2;
    margin: 0;
    padding: 12px 24px;
    border-top: 1px solid var(--shell-border-soft);
  }
  .saved {
    font-size: 11px;
    color: var(--muted);
  }
</style>
