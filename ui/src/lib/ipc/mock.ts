// An in-memory Api for running the interface in a plain browser, without the
// desktop app. `npm run dev` opened in a browser uses it, and so do the
// end-to-end tests. It holds one small made-up workspace.

import type {
  AgentInfo,
  Api,
  ApiProvider,
  AppError,
  ArtifactDetail,
  Chapter,
  Join,
  Outline,
  Part,
  Port,
  ArtifactSummary,
  Changes,
  FileContent,
  FileInfo,
  JobEvent,
  Settings,
  StoreStatus,
  TreeEntry,
  ValidateRequest,
  ValidationReport,
} from './types';

const GO_HANDLER = `package orders

import (
	"context"
	"errors"
)

// maxBatch is the most orders one flush may carry.
const maxBatch = 50

var ErrQueueFull = errors.New("orders: queue full")

type Handler struct {
	queue   []Order
	limiter *Limiter
	store   Store
}

// Submit validates an order and queues it. It flushes when the batch is full.
func (h *Handler) Submit(ctx context.Context, o Order) error {
	if err := o.Validate(); err != nil {
		return err
	}
	if !h.limiter.Allow(o.Customer) {
		return ErrQueueFull
	}
	h.queue = append(h.queue, o)
	if len(h.queue) >= maxBatch {
		return h.Flush(ctx)
	}
	return nil
}

func (h *Handler) Flush(ctx context.Context) error {
	batch := h.queue
	h.queue = nil
	return h.store.WriteBatch(ctx, batch)
}
`;

const FILES: Record<string, string> = {
  'README.md':
    '# shop\n\nA made-up workspace for trying the Codjiva interface in a browser.\n',
  'go.mod': 'module example.com/shop\n\ngo 1.23\n',
  'internal/orders/handler.go': GO_HANDLER,
  'internal/orders/handler_test.go':
    'package orders\n\nimport "testing"\n\nfunc TestSubmit(t *testing.T) {}\n',
  'internal/orders/limiter.go':
    'package orders\n\ntype Limiter struct{ perCustomer int }\n\nfunc (l *Limiter) Allow(customer string) bool { return true }\n',
  'internal/orders/store.go':
    'package orders\n\nimport "context"\n\ntype Store interface {\n\tWriteBatch(ctx context.Context, batch []Order) error\n}\n',
  'internal/billing/ledger.py':
    'class Ledger:\n    def insert(self, row):\n        self.rows.append(row)\n',
  'web/src/cart.ts':
    'export function checkout(cart: Cart): Promise<Receipt> {\n  return post("/checkout", cart);\n}\n',
  'web/src/api.ts':
    'export async function post<T>(path: string, body: unknown): Promise<T> {\n  throw new Error("not implemented");\n}\n',
  Makefile: 'build:\n\tgo build ./...\n',
};

const LANGS: Record<string, [string, string]> = {
  go: ['Go', 'go'],
  py: ['Python', 'python'],
  ts: ['TypeScript', 'typescript'],
  md: ['Markdown', 'markdown'],
  h: ['C++', 'cpp'],
  cpp: ['C++', 'cpp'],
  mod: ['Go module', ''],
};
const langOf = (name: string): [string | null, string] => {
  if (name === 'Makefile') return ['Makefile', 'makefile'];
  const found = LANGS[name.split('.').pop() ?? ''];
  return found ? [found[0], found[1]] : [null, ''];
};

const fail = (code: string, message: string): AppError => ({ code, message });

const DEFAULT_SETTINGS: Settings = {
  agent: null,
  models: {},
  effort: 'auto',
  apiBaseUrls: {},
  agentPaths: {},
  maxFixIterations: 3,
  filmLength: 'standard',
  soundOnByDefault: false,
  basePlaybackSpeed: 0.6,
  externalEditorCommand: 'code -g {file}:{line}',
  maxCompanionFiles: 12,
  companionIgnore: ['vendor/', 'third_party/', 'node_modules/'],
  theme: 'system',
  parallelJobs: 1,
  maxBudgetUsd: null,
  layout: {
    sidebarOpen: true,
    sidebarWidth: 280,
    inspectorOpen: true,
    inspectorWidth: 320,
    dockHeight: null,
    libraryOpen: true,
    libraryHeight: null,
  },
  checkForUpdates: true,
};

// A small stand-in for the desktop app's pattern matching. It knows the three
// forms the interface itself writes and the usual hand-written ones: a pattern
// that ends with a slash is a folder, a pattern that starts with a slash or has
// a slash inside is tied to the workspace root, and `*` stands for any
// characters within one name.
function ignoreMatches(patterns: string[], path: string): boolean {
  const escape = (text: string) =>
    text.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return patterns.some((raw) => {
    const pattern = raw.trim();
    if (!pattern || pattern.startsWith('#')) return false;
    const folder = pattern.endsWith('/');
    const body = pattern.replace(/^\/|\/$/g, '');
    const rooted = pattern.startsWith('/') || body.includes('/');
    return new RegExp(
      `${rooted ? '^' : '(^|/)'}${escape(body)}${folder ? '/' : '(/|$)'}`,
    ).test(path);
  });
}

// The API providers of the mock, with the same rules as the real app for what
// each one needs.
const PROVIDERS: Pick<
  ApiProvider,
  'id' | 'name' | 'envVars' | 'defaultModel' | 'defaultBaseUrl' | 'keyOptional'
>[] = [
  {
    id: 'api-anthropic',
    name: 'Anthropic API',
    envVars: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-opus-5-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyOptional: false,
  },
  {
    id: 'api-openai',
    name: 'OpenAI API',
    envVars: ['OPENAI_API_KEY'],
    defaultModel: null,
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyOptional: false,
  },
  {
    id: 'api-google',
    name: 'Google Gemini API',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    defaultModel: null,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    keyOptional: false,
  },
  {
    id: 'api-compatible',
    name: 'OpenAI-compatible endpoint',
    envVars: [],
    defaultModel: null,
    defaultBaseUrl: null,
    keyOptional: true,
  },
];
// Keys typed into the mock's Settings. They live only in this page.
const savedKeys = new Map<string, string>();
function providerStatus(spec: (typeof PROVIDERS)[number]): ApiProvider {
  const model = settings.models[spec.id]?.trim() || spec.defaultModel;
  const baseUrl = settings.apiBaseUrls[spec.id]?.trim() || spec.defaultBaseUrl;
  const keySource = savedKeys.has(spec.id) ? ('saved' as const) : null;
  let note = '';
  if (!baseUrl) note = "Enter the endpoint's address in Settings.";
  else if (!keySource && !spec.keyOptional)
    note = `Add an API key in Settings, or set ${spec.envVars[0]} before starting the app.`;
  else if (!model) note = 'Choose a model in Settings.';
  return { ...spec, keySource, model, baseUrl, ok: note === '', note };
}

// The artifacts the made-up workspace has. A mock job adds to this list.
let artifacts: ArtifactSummary[] = [];
// What a mock job recorded about a version besides its summary, by "<artifact
// id>/<version>".
const extras = new Map<
  string,
  {
    feedback?: string;
    chapters?: Chapter[];
    durationSec?: number;
    companions?: { path: string; why: string }[];
    form?: 'visual' | 'film';
    parts?: Part[];
    joins?: Join[];
  }
>();

// The ports a mock artifact records, by the name of its file. The handler sends
// batches to the store, so the two can be joined into a pipeline.
function mockPorts(subject: string): Port[] {
  const port = (
    id: string,
    symbol: string,
    line: number,
    carries: string,
  ): Port => ({
    id,
    dir: id.startsWith('in:') ? 'in' : 'out',
    symbol,
    ref: `${subject}:${line}`,
    carries,
    kind: 'call',
    anchor: null,
  });
  if (subject.endsWith('handler.go'))
    return [
      port('in:Handler.Submit', 'Submit(o Order)', 20, 'one order'),
      port('out:Store.WriteBatch', 'Store.WriteBatch', 30, 'a batch of orders'),
    ];
  if (subject.endsWith('store.go'))
    return [
      port(
        'in:Store.WriteBatch',
        'WriteBatch(orders []Order)',
        5,
        'a batch of orders',
      ),
    ];
  return [];
}

// The outline a mock Animate job reports.
const MOCK_OUTLINE: Outline = {
  schemaVersion: 1,
  title: 'How an order moves through the handler',
  chapters: [
    {
      id: 'overview',
      title: 'The assembly line',
      summary: 'One order runs the whole path, from Submit to the store.',
      beats: [{ what: 'an order enters' }],
    },
    {
      id: 'queue',
      title: '2 · Queueing',
      summary: 'Orders wait in the queue until a batch is full.',
      beats: [{ what: 'the queue fills' }],
    },
    {
      id: 'flush',
      title: '3 · Flush',
      summary: 'A full batch is written to the store in one call.',
      beats: [{ what: 'the batch leaves' }],
    },
  ],
};
const validateListeners = new Set<(request: ValidateRequest) => void>();
// Self-tests the mock has asked the window to run, by token.
const pendingValidations = new Map<
  string,
  (report: ValidationReport) => void
>();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const mockDetail = (
  summary: ArtifactSummary,
  version: number,
): ArtifactDetail => ({
  manifest: {
    artifactId: summary.id,
    version,
    kind: summary.kind,
    title: summary.title,
    subject: summary.subject,
    companions: [
      { path: 'internal/orders/store.go', why: 'receives the flushed batch' },
    ],
    sources: Object.fromEntries(
      summary.sources.map((path) => [path, 'sha256:mock']),
    ),
    instructions:
      summary.versions.find((v) => v.version === version)?.instructions ?? '',
    agent: {
      kind: 'mock',
      version: null,
      model: 'mock-model',
      sessionId: null,
    },
    promptVersion: '1.0.0',
    runtimeVersion: '1.0.0',
    validation: { passed: true, iterations: 1, errors: 0, warnings: 1 },
    createdAt:
      summary.versions.find((v) => v.version === version)?.createdAt ?? '',
    costUsd: 0.42,
    ...Object.fromEntries(
      Object.entries(extras.get(`${summary.id}/${version}`) ?? {}).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  },
  definition: {
    title: summary.title,
    layers: { data: [], control: [], errors: [], labels: [] },
    nodes: [
      {
        id: 'submit',
        label: 'Submit()',
        role: 'Entry point. Refuses, de-duplicates and asks the limiter about each order',
        refs: [{ path: 'internal/orders/handler.go', line: 20 }],
        select: ['submit'],
      },
      {
        id: 'flush',
        label: 'flushLocked()',
        role: 'Writes the batch to the Store, and keeps it in memory if the write fails',
        refs: [
          { path: 'internal/orders/handler.go', line: 34 },
          { path: 'internal/orders/store.go', line: 5 },
        ],
        rationale: {
          text: 'After a failed write the batch stays in memory, so the next flush writes it again and no order is lost. See `flushLocked`.',
          basis: 'stated',
          refs: [{ path: 'internal/orders/handler.go', line: 33 }],
        },
        select: ['flush'],
      },
    ],
    // The chapters of the reference film, which the mock shows for every
    // film, with the two rationales the inspector lists for it.
    scenes: [
      { id: 'overview', title: 'How an order moves', bubbles: [] },
      {
        id: 'routing',
        title: '2 · Routing',
        bubbles: [
          {
            kicker: 'ROUTING · PRIORITY',
            html: 'A priority order is written at once.',
            rationale: {
              text: 'A priority order whose write fails is taken out of `seen` again, so the client may submit the same order once more.',
              basis: 'inferred',
              refs: [{ path: 'internal/orders/handler.go', line: 20 }],
            },
          },
        ],
      },
      { id: 'budget', title: '3 · The budget', bubbles: [] },
      {
        id: 'flush',
        title: '4 · The flush',
        bubbles: [
          {
            kicker: 'FLUSH · flushLocked()',
            html: 'The tick writes the whole batch.',
            rationale: {
              text: 'After a failed write the batch stays in memory, so the next flush writes it again and no order is lost.',
              basis: 'stated',
              refs: [{ path: 'internal/orders/handler.go', line: 33 }],
            },
          },
        ],
      },
    ],
  },
  model: {
    unit: { primary: 'order' },
    modes: [
      {
        name: 'batching',
        trigger: 'len(queue) >= maxBatch',
        ref: 'internal/orders/handler.go:28',
      },
    ],
    limits: [
      {
        name: 'maxBatch',
        scope: 'per handler',
        effect: 'flush the queue',
        ref: 'internal/orders/handler.go:9',
      },
    ],
    omitted: [{ what: 'logging', why: 'not part of the flow' }],
  },
  validation: {
    ok: true,
    issues: [
      {
        check: 'packet-size',
        severity: 'warning',
        message: 'Packets of kind "tally" are drawn at different sizes.',
      },
    ],
  },
  bytes: 212_000,
});

let settings: Settings = { ...DEFAULT_SETTINGS };
let store: StoreStatus = {
  git: 'not_ignored',
  gitignoreChoice: null,
  askAboutGitignore: true,
};
let opened = false;
const fsListeners = new Set<(changes: Changes) => void>();
// How to stop each running mock job, by job id.
const cancelledJobs = new Map<string, () => void>();

export const mockApi: Api = {
  async appInfo() {
    return {
      name: 'Codjiva',
      version: '0.1.0',
      platform: 'browser',
      runtimeVersion: '1.0.0',
      dotDir: '.codjiva',
    };
  },
  async pickFolder() {
    return '/mock/shop';
  },
  async workspaceOpen(path) {
    opened = true;
    return {
      root: path,
      name: path.split('/').filter(Boolean).pop() ?? path,
      store,
    };
  },
  async workspaceClose() {
    opened = false;
  },
  async workspaceRecent() {
    return [
      { path: '/mock/shop', name: 'shop', openedAt: '2026-11-14T10:00:00Z' },
      {
        path: '/mock/ledger-service',
        name: 'ledger-service',
        openedAt: '2026-11-12T16:20:00Z',
      },
    ];
  },
  async treeChildren(relPath) {
    if (!opened) throw fail('no_workspace', 'Open a folder first.');
    const prefix = relPath ? relPath + '/' : '';
    const seen = new Map<string, TreeEntry>();
    for (const path of Object.keys(FILES)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const name = rest.split('/')[0];
      const isDir = rest.includes('/');
      if (seen.has(name)) continue;
      seen.set(name, {
        name,
        relPath: prefix + name,
        kind: isDir ? 'dir' : 'file',
        lang: isDir ? null : langOf(name)[0],
        size: isDir ? null : FILES[path].length,
      });
    }
    return [...seen.values()].sort(
      (a, b) =>
        Number(a.kind === 'file') - Number(b.kind === 'file') ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  },
  async fileInfo(relPath): Promise<FileInfo> {
    const text = FILES[relPath];
    if (text == null) throw fail('not_found', 'Could not read that file.');
    const name = relPath.split('/').pop()!;
    const [lang, highlighter] = langOf(name);
    return {
      relPath,
      name,
      lang,
      highlighter,
      bytes: text.length,
      lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
      hash: 'sha256:mock',
      binary: false,
    };
  },
  async fileRead(relPath): Promise<FileContent> {
    const text = FILES[relPath];
    if (text == null) throw fail('not_found', 'Could not read that file.');
    return {
      relPath,
      text,
      truncated: false,
      highlighter: langOf(relPath.split('/').pop()!)[1],
    };
  },
  async filesSearch(query, limit = 50) {
    const needle = query.toLowerCase().replace(/\s+/g, '');
    if (!needle) return [];
    const matches = (path: string) => {
      let at = 0;
      for (const c of path.toLowerCase()) if (c === needle[at]) at++;
      return at === needle.length;
    };
    return Object.keys(FILES)
      .filter(matches)
      .slice(0, limit)
      .map((relPath) => ({ relPath, name: relPath.split('/').pop()! }));
  },
  async watchDirs() {},
  async storeEnsure() {
    return store;
  },
  async gitignoreAdd() {
    store = {
      git: 'ignored',
      gitignoreChoice: 'added',
      askAboutGitignore: false,
    };
    return store;
  },
  async gitignoreKeepTracked() {
    store = {
      git: 'not_ignored',
      gitignoreChoice: 'tracked',
      askAboutGitignore: false,
    };
    return store;
  },
  async settingsGet() {
    return settings;
  },
  async settingsSet(next) {
    settings = { ...next };
    return settings;
  },
  async openExternal() {},
  async reveal() {},
  async setFullscreen() {},
  async setWindowTheme() {},
  async agentsDetect() {
    const mock: AgentInfo = {
      id: 'mock',
      name: 'Mock Agent',
      kind: 'replay',
      path: null,
      version: '1.0',
      ok: true,
      note: 'A stand-in for an agent, for trying the interface in a browser.',
      supportsResume: true,
      verified: true,
    };
    const providers: AgentInfo[] = PROVIDERS.map(providerStatus).map((p) => ({
      id: p.id,
      name: p.name,
      kind: 'api',
      path: null,
      version: p.model,
      ok: p.ok,
      note: p.note,
      supportsResume: true,
      verified: true,
    }));
    return [mock, ...providers];
  },
  async apiProviders() {
    return PROVIDERS.map(providerStatus);
  },
  async apiKeySet(providerId, key) {
    if (!key.trim()) throw fail('key_empty', 'Type or paste a key first.');
    savedKeys.set(providerId, key.trim());
  },
  async apiKeyClear(providerId) {
    savedKeys.delete(providerId);
  },
  // The mock accepts any key except one that starts with "bad", so both
  // outcomes can be tried.
  async apiCheck(providerId) {
    const status = providerStatus(PROVIDERS.find((p) => p.id === providerId)!);
    if (!status.ok)
      throw fail(
        'provider_not_ready',
        `${status.name} is not set up. ${status.note}`,
      );
    if (savedKeys.get(providerId)?.startsWith('bad'))
      throw fail(
        'api_key_rejected',
        `${status.name} rejected the API key. Check the key in Settings.`,
      );
    return status.model ?? '';
  },
  async companionsSuggest(relPath) {
    const dir = relPath.includes('/')
      ? relPath.slice(0, relPath.lastIndexOf('/'))
      : '';
    return [
      { path: `${dir}/store.go`, why: 'imported by this file', score: 10 },
      {
        path: `${dir}/handler_test.go`,
        why: 'its test · uses `Handler`',
        score: 13,
      },
      { path: `${dir}/limiter.go`, why: 'uses `Handler`, `Submit`', score: 5 },
      {
        path: 'vendor/github.com/acme/retry/retry.go',
        why: 'imported by this file',
        score: 10,
      },
      {
        path: 'lib/acme/metrics/counter.go',
        why: 'imported by store.go',
        score: 5,
      },
    ]
      .filter(
        (s) =>
          s.path !== relPath &&
          !ignoreMatches(settings.companionIgnore, s.path),
      )
      .sort((a, b) => b.score - a.score);
  },
  // The mock cannot tell a broken pattern from a good one. It reports a pattern
  // as broken when it holds the character range `[z-a]`, which the desktop app
  // also rejects, so the message for a broken pattern can be tried.
  async companionsIgnoreCheck(patterns, paths) {
    const files = [
      ...Object.keys(FILES),
      'vendor/github.com/acme/retry/retry.go',
      'lib/acme/metrics/counter.go',
      'lib/acme/metrics/gauge.go',
      'lib/acme/trace/span.go',
    ];
    const matched = files.filter((file) => ignoreMatches(patterns, file));
    return {
      matched: matched.length,
      examples: matched.slice(0, 5),
      matchedPaths: paths.filter((path) => ignoreMatches(patterns, path)),
      invalid: patterns.filter((pattern) => pattern.includes('[z-a]')),
    };
  },
  // Proposes the one join the mock's ports allow: the handler's out port to the
  // store's in port.
  async composePropose(artifactIds) {
    const parts = artifactIds
      .map((id) => artifacts.find((a) => a.id === id))
      .filter((a) => a != null)
      .map((a) => ({
        artifactId: a.id,
        version: a.currentVersion,
        title: a.title,
        subject: a.subject,
        ports: a.ports,
      }));
    const joins: Join[] = [];
    for (const from of parts)
      for (const to of parts) {
        if (
          from.artifactId === to.artifactId ||
          from.subject[0] === to.subject[0]
        )
          continue;
        for (const out of from.ports.filter((p) => p.dir === 'out'))
          for (const into of to.ports.filter((p) => p.dir === 'in')) {
            const last = (symbol: string) =>
              symbol.split('(')[0].split('.').pop();
            if (last(out.symbol) === last(into.symbol)) {
              joins.push({
                fromArtifact: from.artifactId,
                fromPort: out.id,
                toArtifact: to.artifactId,
                toPort: into.id,
                symbol: into.symbol,
                kind: out.kind,
                carries: out.carries,
                reason: `\`${out.symbol}\` and \`${into.symbol}\` end in the same name.`,
                strength: 'name',
              });
            }
          }
      }
    return { parts, joins };
  },
  // The made-up workspace's folders are small, except `web`, which stands for a
  // large one.
  async folderInfo(relPath) {
    const dir = relPath.replace(/\/+$/, '');
    const files =
      dir === 'internal/orders'
        ? ['handler.go', 'handler_test.go', 'limiter.go', 'store.go'].map(
            (name) => `${dir}/${name}`,
          )
        : [`${dir}/main.go`];
    const estimatedTokens = dir === 'web' ? 120_000 : files.length * 900;
    return {
      relPath: dir,
      name: dir.split('/').pop() ?? dir,
      files,
      bytes: estimatedTokens * 4,
      estimatedTokens,
      large: estimatedTokens >= 80_000,
      tooLarge: false,
    };
  },
  // A browser page cannot take a picture of a sandboxed frame, so the mock has
  // none to give.
  async feedbackCapture() {
    return null;
  },
  // A made-up estimate. It grows with the length of a film and with the
  // number of companion files, so the interface can be seen to follow both.
  // The end-to-end test sets `window.__mockEstimateSamples` to make the
  // estimate say that it was corrected with that many earlier jobs.
  async jobEstimate(request) {
    const typical =
      request.kind === 'feedback'
        ? 60
        : request.kind === 'visualise'
          ? 200
          : (request.kind === 'compose' ? 60 : 240) +
            (request.kind === 'compose' && !request.film
              ? 0
              : 2 * (request.lengthSeconds ?? 180)) +
            30 * (request.companions?.length ?? 0);
    return {
      lowSeconds: Math.round(typical * 0.6),
      highSeconds: Math.round(typical * 1.5),
      typicalSeconds: typical,
      samples: (window as any).__mockEstimateSamples ?? 0,
    };
  },
  // Plays a made-up job: the phases and log lines of a real one, then a
  // self-test of a bundled reference page in the window's hidden frame, then a
  // result. A Visualise job shows the reference visual, an Animate job the
  // reference film, and a feedback job adds a version to the artifact it names.
  async jobStart(request, onEvent) {
    const jobId = `mock-${Date.now()}`;
    (window as any).__mockLastRequest = request;
    const base =
      request.kind === 'feedback'
        ? artifacts.find((a) => a.id === request.artifactId)
        : undefined;
    if (request.kind === 'feedback' && !base)
      throw fail('not_found', 'That version of the artifact does not exist.');
    const partArtifacts = (request.parts ?? [])
      .map((partId) => artifacts.find((a) => a.id === partId))
      .filter((a) => a != null);
    const subject =
      base?.subject[0] ??
      request.subject[0] ??
      partArtifacts[0]?.subject[0] ??
      '';
    const kind =
      base?.kind ??
      (request.kind === 'compose'
        ? 'pipeline'
        : request.kind === 'animate'
          ? 'film'
          : 'visual');
    const form =
      request.kind === 'compose'
        ? request.film
          ? ('film' as const)
          : ('visual' as const)
        : extras.get(`${base?.id}/${request.baseVersion}`)?.form;
    const id =
      base?.id ??
      `${kind}-` +
        subject.replace(/[^a-z0-9]+/gi, '_').toLowerCase() +
        '-mock01';
    const existing = artifacts.find((a) => a.id === id);
    const version = (existing?.versions.length ?? 0) + 1;
    const dir = `.codjiva/artifacts/${id}/v${version}`;
    let cancelled = false;
    cancelledJobs.set(jobId, () => {
      cancelled = true;
    });
    const emit = (event: JobEvent) => {
      if (!cancelled) onEvent(event);
    };
    const phase = (
      name: string,
      extra: { chapter?: number; of?: number } = {},
    ): JobEvent => ({ type: 'phase', phase: name, detail: null, ...extra });
    const tool = (text: string): JobEvent => ({
      type: 'log',
      level: 'tool',
      text,
    });
    (async () => {
      const head: [number, JobEvent][] = [
        [
          80,
          {
            type: 'started',
            jobId,
            artifactId: id,
            version,
            agent: 'Mock Agent',
          },
        ],
      ];
      const body: [number, JobEvent][] =
        request.kind === 'feedback'
          ? [
              [80, phase('revising')],
              [
                200,
                tool(
                  `Read ${dir}/src/${kind === 'film' ? 'film.json' : 'visual.json'}`,
                ),
              ],
              [
                250,
                tool(
                  `Edit ${dir}/src/${kind === 'film' ? 'film.json' : 'visual.json'}`,
                ),
              ],
            ]
          : request.kind === 'compose'
            ? [
                [80, phase('reading')],
                ...partArtifacts.map((part): [number, JobEvent] => [
                  80,
                  tool(
                    `Read .codjiva/artifacts/${part.id}/v${part.currentVersion}/model.json`,
                  ),
                ]),
                [150, phase('joining')],
                [150, tool(`Read ${partArtifacts[0]?.subject[0] ?? ''}`)],
                [150, phase('drawing')],
                [250, tool(`Write ${dir}/src/plant.js`)],
                [150, phase('annotating')],
                [200, tool(`Write ${dir}/src/visual.json`)],
              ]
            : request.kind === 'animate'
              ? [
                  [80, phase('reading')],
                  [120, tool(`Read ${subject}`)],
                  ...(request.companions ?? []).map(
                    (path): [number, JobEvent] => [60, tool(`Read ${path}`)],
                  ),
                  [120, phase('analysing')],
                  [150, tool(`Write ${dir}/model.json`)],
                  [120, phase('outline')],
                  [
                    150,
                    {
                      type: 'outline',
                      outline: request.outline ?? MOCK_OUTLINE,
                    },
                  ],
                  [150, phase('drawing')],
                  [200, tool(`Write ${dir}/src/plant.js`)],
                  [200, phase('chapter', { chapter: 1, of: 3 })],
                  [300, phase('chapter', { chapter: 2, of: 3 })],
                  [300, phase('chapter', { chapter: 3, of: 3 })],
                  [200, tool(`Write ${dir}/src/film.json`)],
                ]
              : [
                  [80, phase('reading')],
                  [150, tool(`Read ${subject}`)],
                  [150, tool('Read internal/orders/store.go')],
                  [150, phase('analysing')],
                  [200, tool(`Write ${dir}/model.json`)],
                  [150, phase('drawing')],
                  [250, tool(`Write ${dir}/src/plant.js`)],
                  [150, phase('annotating')],
                  [200, tool(`Write ${dir}/src/visual.json`)],
                ];
      const tail: [number, JobEvent][] = [
        [
          100,
          {
            type: 'usage',
            costUsd: 0.42,
            inputTokens: 51200,
            outputTokens: 9800,
          },
        ],
        [100, { type: 'guard', violations: [] }],
        [100, phase('building')],
        [150, phase('validating')],
      ];
      for (const [wait, event] of [...head, ...body, ...tail]) {
        await sleep(wait);
        if (cancelled) {
          onEvent({ type: 'cancelled' });
          return;
        }
        emit(event);
      }
      const token = `${jobId}-check`;
      const report = await new Promise<
        ValidationReport & { chapters?: Chapter[] }
      >((done) => {
        pendingValidations.set(token, done);
        validateListeners.forEach((listener) =>
          listener({ token, artifactId: id, version }),
        );
        // Without a window to answer, the mock job still ends.
        setTimeout(() => done({ ok: true, issues: [] }), 20000);
      });
      if (cancelled) {
        onEvent({ type: 'cancelled' });
        return;
      }
      const errors = report.issues.filter((i) => i.severity === 'error').length;
      const warnings = report.issues.filter(
        (i) => i.severity === 'warning',
      ).length;
      emit({ type: 'validation', report, iteration: 0 });
      const previous = existing?.versions.find(
        (v) => v.version === (request.baseVersion ?? existing.currentVersion),
      );
      const entry = {
        version,
        createdAt: new Date().toISOString(),
        passed: errors === 0,
        errors,
        warnings,
        instructions:
          request.kind === 'feedback'
            ? (previous?.instructions ?? '')
            : (request.instructions ?? ''),
        agent: 'mock',
        model: 'mock-model',
        parent: request.baseVersion ?? (version > 1 ? version - 1 : null),
      };
      extras.set(`${id}/${version}`, {
        feedback: request.feedback?.text,
        chapters: report.chapters,
        durationSec: report.duration ?? undefined,
        // A feedback version is made from the same files as the version it
        // changes.
        companions:
          request.kind === 'animate'
            ? (request.companions ?? []).map((path) => ({
                path,
                why: 'chosen in the Animate dialog',
              }))
            : extras.get(`${id}/${request.baseVersion}`)?.companions,
        form,
        // A pipeline names each part by a short key made from its file's name.
        parts:
          request.kind === 'compose'
            ? partArtifacts.map((part) => ({
                key: (part.subject[0].split('/').pop() ?? 'part').split('.')[0],
                artifact: part.id,
                version: part.currentVersion,
              }))
            : extras.get(`${id}/${request.baseVersion}`)?.parts,
        joins:
          request.kind === 'compose'
            ? request.joins
            : extras.get(`${id}/${request.baseVersion}`)?.joins,
      });
      const recorded = extras.get(`${id}/${version}`);
      if (existing) {
        existing.versions.push(entry);
        existing.currentVersion = version;
      } else
        artifacts.push({
          id,
          kind,
          title:
            kind === 'pipeline'
              ? 'Orders: from the handler to the store'
              : kind === 'film'
                ? 'How an order moves through the orders Handler'
                : `Handler.Submit · ${subject.split('/').pop()}`,
          subject:
            kind === 'pipeline'
              ? partArtifacts.map((part) => part.subject[0])
              : [subject],
          currentVersion: version,
          versions: [entry],
          sources:
            kind === 'pipeline'
              ? partArtifacts.flatMap((part) => part.sources)
              : [subject, 'internal/orders/store.go'],
          stale: false,
          staleSources: [],
          durationSec: kind === 'film' ? (report.duration ?? 270) : null,
          ports: kind === 'pipeline' ? [] : mockPorts(subject),
          form: recorded?.form,
          parts: kind === 'pipeline' ? recorded?.parts : undefined,
        });
      emit({
        type: 'result',
        artifactId: id,
        version,
        passed: errors === 0,
        errors,
        warnings,
      });
    })();
    return jobId;
  },
  async jobCancel(jobId) {
    cancelledJobs.get(jobId)?.();
  },
  async jobValidated(token, report) {
    pendingValidations.get(token)?.(report);
    pendingValidations.delete(token);
  },
  async artifactList() {
    return artifacts.map((a) => ({ ...a, versions: [...a.versions] }));
  },
  async artifactDetail(id, version) {
    const summary = artifacts.find((a) => a.id === id);
    if (!summary) throw fail('not_found', 'That artifact does not exist.');
    return mockDetail(summary, version ?? summary.currentVersion);
  },
  async artifactSetCurrent(id, version) {
    const summary = artifacts.find((a) => a.id === id);
    if (summary) summary.currentVersion = version;
  },
  async artifactDelete(id) {
    artifacts = artifacts.filter((a) => a.id !== id);
  },
  async artifactExport(_id, _version, suggestedName) {
    return `/mock/exports/${suggestedName}`;
  },
  async artifactOpenInBrowser() {},
  async artifactReveal() {},
  async guardRevert(violations) {
    return violations.map((v) => ({
      path: v.path,
      reverted: v.tracked,
      note: v.tracked
        ? 'Restored to the last committed content.'
        : 'This file is new. Delete it yourself if you do not want it.',
    }));
  },
  async onValidateRequest(handler) {
    validateListeners.add(handler);
    return () => validateListeners.delete(handler);
  },
  async onFsChanged(handler) {
    fsListeners.add(handler);
    return () => fsListeners.delete(handler);
  },
  // The end-to-end test server serves the built reference pages under this
  // path. A mock film shows the reference film, and every other mock artifact
  // shows the reference visual.
  artifactUrl(path) {
    if (path.startsWith('artifact/film-'))
      return '/__artifact/reference/film.html';
    if (path.startsWith('artifact/pipeline-'))
      return '/__artifact/reference/pipeline.html';
    return path.startsWith('artifact/')
      ? '/__artifact/reference/visual.html'
      : `/__artifact/${path}.html`;
  },
  // No newer version exists unless the page has put one in
  // `window.__mockUpdate`, as the end-to-end test does.
  async updateCheck() {
    await sleep(150);
    return (window as any).__mockUpdate ?? null;
  },
  async updateInstall(onProgress) {
    for (const percent of [20, 55, 90, 100]) {
      await sleep(120);
      onProgress(percent);
    }
  },
  async relaunch() {
    (window as any).__mockRelaunched = true;
  },
  async openReleases() {
    (window as any).__mockOpenedReleases = true;
  },
};

// Lets the end-to-end test simulate an edit to a source file of a mock
// artifact: the artifact becomes stale and the interface is told the file
// changed.
if (typeof window !== 'undefined') {
  (window as any).__mockEditFile = (relPath: string) => {
    for (const artifact of artifacts) {
      if (artifact.sources.includes(relPath)) {
        artifact.stale = true;
        artifact.staleSources = [relPath];
      }
    }
    const dir = relPath.includes('/')
      ? relPath.slice(0, relPath.lastIndexOf('/'))
      : '';
    fsListeners.forEach((listener) =>
      listener({ dirs: [dir], paths: [relPath] }),
    );
  };
  // The end-to-end test sets `window.__mockUpdate` to offer a newer version,
  // and reads `window.__mockRelaunched` to see that a restart was asked for.
  // Lets the end-to-end test simulate that a file was deleted, and read the
  // settings that were last saved.
  // Lets the end-to-end test give a file other text, for example a long one.
  (window as any).__mockSetFile = (relPath: string, text: string) => {
    FILES[relPath] = text;
  };
  (window as any).__mockDeleteFile = (relPath: string) => {
    delete FILES[relPath];
  };
  (window as any).__mockSettings = () => settings;
}
