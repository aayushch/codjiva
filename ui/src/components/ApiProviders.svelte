<script lang="ts">
  // The part of Settings where the user sets up API providers: a key, a model
  // and, when the provider is not reached at its usual address, the address.
  // Each provider is one row that opens to show its fields.
  import { api, type ApiProvider } from '$lib/ipc';
  import { app } from '$lib/state/app.svelte';

  // The key being typed for each provider, by provider id. A key is cleared
  // from here as soon as it is saved, so it does not stay in the page.
  let typed = $state<Record<string, string>>({});
  // The result of the last connection test of each provider, by provider id.
  let tests = $state<
    Record<string, { state: 'running' | 'ok' | 'failed'; text: string }>
  >({});

  $effect(() => {
    app.loadApiProviders();
  });

  function keyStatus(p: ApiProvider): string {
    if (p.keySource === 'saved') return 'key saved';
    if (p.keySource === 'environment') return 'key from the environment';
    return p.keyOptional ? 'no key' : 'needs a key';
  }

  async function saveKey(p: ApiProvider) {
    if (await app.saveApiKey(p.id, typed[p.id] ?? '')) {
      typed[p.id] = '';
      delete tests[p.id];
    }
  }

  // The result of an earlier connection test says nothing about the provider
  // once its key is gone, so it is removed with the key.
  async function removeKey(p: ApiProvider) {
    await app.clearApiKey(p.id);
    delete tests[p.id];
  }

  function setModel(p: ApiProvider, value: string) {
    if (app.settings)
      app.saveSettings({
        ...app.settings,
        models: { ...app.settings.models, [p.id]: value.trim() },
      });
  }

  function setAddress(p: ApiProvider, value: string) {
    if (app.settings)
      app.saveSettings({
        ...app.settings,
        apiBaseUrls: { ...app.settings.apiBaseUrls, [p.id]: value.trim() },
      });
  }

  async function test(p: ApiProvider) {
    tests[p.id] = { state: 'running', text: 'Asking…' };
    try {
      const model = await api.apiCheck(p.id);
      tests[p.id] = {
        state: 'ok',
        text: model ? `Works. ${model} answered.` : 'Works.',
      };
    } catch (error) {
      const message =
        typeof error === 'object' && error && 'message' in error
          ? String(error.message)
          : String(error);
      tests[p.id] = { state: 'failed', text: message };
    }
  }
</script>

<p class="lead">
  Keys are kept in this computer's credential store, never in a file. A provider
  that is ready can be chosen under Agent.
</p>
{#each app.apiProviders as p (p.id)}
  <details class="provider" data-provider={p.id}>
    <summary>
      <span class="name">{p.name}</span>
      <span class="pill" class:ready={p.ok}
        >{p.ok ? 'ready' : keyStatus(p)}</span
      >
    </summary>
    <div class="body">
      {#if p.note}<div class="why need">{p.note}</div>{/if}
      <div class="field">
        <label for="key-{p.id}"
          >API key{p.keyOptional ? ' (optional)' : ''}</label
        >
        <div class="line">
          <input
            id="key-{p.id}"
            class="input"
            type="password"
            autocomplete="off"
            spellcheck="false"
            bind:value={typed[p.id]}
            placeholder={p.keySource === 'saved'
              ? 'a key is saved; type a new one to replace it'
              : 'paste the key'}
            onkeydown={(e) => {
              if (e.key === 'Enter') saveKey(p);
            }}
          />
          <button
            class="btn small"
            disabled={!(typed[p.id] ?? '').trim()}
            onclick={() => saveKey(p)}>Save</button
          >
          {#if p.keySource === 'saved'}<button
              class="btn small"
              onclick={() => removeKey(p)}>Remove</button
            >{/if}
        </div>
        <div class="why">
          {#if p.keySource === 'saved'}A key is saved for this provider.
          {:else if p.keySource === 'environment'}Using the key from an
            environment variable. A key saved here is used first.
          {:else if p.envVars.length}Or set <code>{p.envVars[0]}</code> before starting
            the app.
          {:else}Leave empty for a local server that needs no key.{/if}
        </div>
      </div>
      <div class="field">
        <label for="model-{p.id}">Model</label>
        <input
          id="model-{p.id}"
          class="input"
          spellcheck="false"
          value={app.settings?.models[p.id] ?? ''}
          placeholder={p.defaultModel ??
            "the model's name, as the provider spells it"}
          onchange={(e) => setModel(p, e.currentTarget.value)}
        />
        {#if p.defaultModel}<div class="why">
            Leave empty to use <code>{p.defaultModel}</code>.
          </div>{/if}
      </div>
      <div class="field">
        <label for="address-{p.id}">Address</label>
        <input
          id="address-{p.id}"
          class="input"
          spellcheck="false"
          value={app.settings?.apiBaseUrls[p.id] ?? ''}
          placeholder={p.defaultBaseUrl ?? 'http://localhost:11434/v1'}
          onchange={(e) => setAddress(p, e.currentTarget.value)}
        />
        <div class="why">
          {p.defaultBaseUrl
            ? 'Only needed when requests go through a proxy or gateway.'
            : 'The address of the server, up to and including /v1.'}
        </div>
      </div>
      {#if p.id === 'api-anthropic'}
        <div class="why">
          If a Claude model declines a request for safety reasons, Anthropic
          answers it with its default fallback model, billed at that model's
          price.
        </div>
      {/if}
      <div class="line">
        <button
          class="btn small"
          disabled={!p.ok || tests[p.id]?.state === 'running'}
          onclick={() => test(p)}>Test the connection</button
        >
        {#if tests[p.id]}<span
            class="why test"
            class:ok={tests[p.id].state === 'ok'}
            class:failed={tests[p.id].state === 'failed'}
            >{tests[p.id].text}</span
          >{/if}
      </div>
    </div>
  </details>
{/each}

<style>
  .provider {
    border: 1px solid var(--shell-border);
    border-radius: 8px;
    margin: 6px 0;
    background: var(--panel);
  }
  .provider summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    cursor: pointer;
    list-style: none;
  }
  .provider summary::-webkit-details-marker {
    display: none;
  }
  .provider summary::before {
    content: '›';
    color: var(--shell-text-2);
    transition: transform 0.12s;
    width: 8px;
  }
  .provider[open] summary::before {
    transform: rotate(90deg);
  }
  .provider .name {
    flex: 1;
    color: var(--second);
  }
  .provider .pill.ready {
    border-color: var(--accent);
    color: var(--accent);
  }
  .provider .body {
    padding: 2px 12px 12px 30px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }
  .provider .body :global(.field) {
    margin: 0;
  }
  .provider .line {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .provider .line .input {
    flex: 1;
    min-width: 0;
  }
  .provider .line .test {
    flex: 1;
    min-width: 12em;
  }
  .provider .why {
    font-size: 11px;
    color: var(--muted);
  }
  .provider .why.need,
  .provider .why.test.failed {
    color: var(--main);
  }
  .provider .why.test.ok {
    color: var(--accent);
  }
</style>
