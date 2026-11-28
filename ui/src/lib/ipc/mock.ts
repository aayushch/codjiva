// An in-memory Api for running the interface in a plain browser, without the
// desktop app. `npm run dev` opened in a browser uses it, and so do the
// end-to-end tests. It holds one small made-up workspace.

import stepthroughVisual from '../../../../runtime/reference/stepthrough/visual.json';
import lanesView from '../../../../runtime/reference/views/lanes/view.json';
import mapView from '../../../../runtime/reference/views/map/view.json';
import schemaView from '../../../../runtime/reference/views/schema/view.json';
import structureView from '../../../../runtime/reference/views/structure/view.json';
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
  GitChange,
  GitHunk,
  GitSide,
  FileInfo,
  FileKind,
  JobEvent,
  NavKind,
  NavLookup,
  NavReference,
  NavTarget,
  Scope,
  ScopeCandidates,
  Settings,
  StoreStatus,
  Thread,
  TreeEntry,
  ViewSuggestion,
  ValidateRequest,
  ValidationReport,
  WorkspaceSession,
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
// A PNG picture that is 2 pixels wide and 1 pixel high.
const MOCK_PICTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4GBgYEJAA4MAgFkU6uKAAAAAElFTkSuQmCC';
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
  agentCustomizations: false,
  filmLength: 'standard',
  soundOnByDefault: false,
  basePlaybackSpeed: 0.6,
  externalEditorCommand: 'code -g {file}:{line}',
  maxCompanionFiles: 12,
  companionIgnore: ['vendor/', 'third_party/', 'node_modules/'],
  theme: 'system',
  codeFontSize: 13,
  maxBudgetUsd: null,
  layout: {
    sidebarOpen: true,
    sidebarWidth: 280,
    inspectorOpen: true,
    inspectorWidth: 320,
    dockHeight: null,
    libraryOpen: true,
    libraryHeight: null,
    stepPanelHeight: null,
    sourcePanelWidth: 380,
    sourceSplit: 40,
    sourceSwapped: false,
    diffSplit: false,
    diffWholeFile: false,
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
    scope?: Scope;
    // The runtime the version was built with. A version without it was
    // built with the runtime `mockDetail` names.
    runtimeVersion?: string;
  }
>();

// The discussions of the made-up workspace, the one that was added to last
// first. A mock question adds to this list.
let threads: Thread[] = [];
let mockAsksStarted = 0;

// The scope for lines `start` to `end` of the file at `path`, with the
// definition `symbol` when it is anchored to one. The id is made from the
// name or the lines alone, so the same selection always gives the same scope.
function mockScope(
  path: string,
  start: number,
  end: number,
  symbol?: string,
): Scope {
  return {
    id: symbol
      ? symbol.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
      : `l${start}_${end}`,
    path,
    symbol,
    startLine: start,
    endLine: end,
    textHash: 'sha256:mock',
  };
}

// The definitions of the file at `path` that have a body, each with its name
// and its first and last line, counted from 1. A definition starts at a line
// that begins with `func` or `type` and ends at the next line that is a
// closing brace alone, which is how the made-up files are written.
function mockExtents(path: string) {
  const lines = (FILES[path] ?? '').split('\n');
  const found: { name: string; first: number; last: number }[] = [];
  lines.forEach((text, row) => {
    const head = text.match(
      /^(?:func\s*(?:\(\w+\s+\*?(\w+)\)\s*)?|type\s+)(\w+)/,
    );
    if (!head) return;
    const close = lines.findIndex((line, at) => at >= row && line === '}');
    if (close < 0) return;
    found.push({
      name: head[1] ? `${head[1]}.${head[2]}` : head[2],
      first: row + 1,
      last: close + 1,
    });
  });
  return found;
}

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

// The visual.json of the reference step-through, which every mock
// step-through shows.
const STEPTHROUGH_DEFINITION =
  stepthroughVisual as unknown as ArtifactDetail['definition'];

// The view.json of each reference view, which a mock view of that name
// shows.
const VIEW_DEFINITIONS: Record<string, ArtifactDetail['definition']> = {
  schema: schemaView as unknown as ArtifactDetail['definition'],
  lanes: lanesView as unknown as ArtifactDetail['definition'],
  structure: structureView as unknown as ArtifactDetail['definition'],
  map: mapView as unknown as ArtifactDetail['definition'],
};

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
    // The runtime a version was built with, unless its job recorded another
    // one in `extras`, which is spread over this object below.
    runtimeVersion: '1.5.0',
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
  // A mock step-through shows the reference step-through, so its definition
  // is that step-through's visual.json, with the detail of every state. A
  // mock view has the view.json of the reference view of its name.
  definition:
    summary.kind === 'stepthrough'
      ? STEPTHROUGH_DEFINITION
      : (VIEW_DEFINITIONS[summary.kind] ?? mockDefinition(summary)),
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

// The definition of every mock artifact that is not a step-through: two nodes
// of the reference visual, and the chapters of the reference film.
const mockDefinition = (
  summary: ArtifactSummary,
): ArtifactDetail['definition'] => ({
  title: summary.title,
  layers: { data: [], control: [], errors: [], labels: [] },
  nodes: [
    {
      id: 'submit',
      label: 'Submit()',
      role: 'Entry point. Refuses, de-duplicates and asks the limiter about each order',
      refs: [{ path: 'internal/orders/handler.go', line: 20, end: 26 }],
      select: ['submit'],
      inputs: ['o: the order', 'h.mode: the load mode'],
      outputs: ['Outcome: what was done with the order'],
      transitions: [
        { when: 'the order is valid', to: 'flush' },
        { when: 'h.mode is ModeStopped', to: 'the caller, with ErrOverloaded' },
      ],
      edgeCases: [
        {
          text: "An order with a repeated ID is counted as a duplicate before the limiter is asked, so it does not use up the customer's rate.",
          example: 'two orders with the ID 7',
          refs: [{ path: 'internal/orders/handler.go', line: 22 }],
        },
      ],
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
});

let settings: Settings = { ...DEFAULT_SETTINGS };
let store: StoreStatus = {
  git: 'not_ignored',
  gitignoreChoice: null,
  askAboutGitignore: true,
};
let opened = false;
// The path of the open workspace, and what was open in each workspace when it
// was last used, by that path. Both last until the page is loaded again.
let openedRoot = '';
const sessions = new Map<string, WorkspaceSession>();
const fsListeners = new Set<(changes: Changes) => void>();
// How to stop each running mock job, by job id.
const cancelledJobs = new Map<string, () => void>();
// How many mock jobs have been started. The count is part of each job's id, so
// that two jobs started in the same millisecond get different ids.
let mockJobsStarted = 0;

// Code navigation over the made-up workspace. It stands in for the core's
// navigation and is much simpler: a definition is a name after a keyword
// such as `func`, `type` or `class`, a use is the same word anywhere in a
// file with the same ending, and nothing is known about scopes. That is
// enough for the interface's own behaviour to be tried and tested.
const KEYWORD = 'func(?:\\s*\\([^)]*\\))?|type|class|def|function|const|var';
const DEFINED = new RegExp(`\\b(${KEYWORD})\\s+([A-Za-z_]\\w*)`, 'g');
const KINDS: Record<string, NavKind> = {
  type: 'struct',
  class: 'class',
  const: 'constant',
  var: 'variable',
};
const endingOf = (path: string) => path.split('.').pop() ?? '';
// What the stand-in agent answers when it is asked which kind of artifact
// suits a file: an order of the six kinds that depends only on the file's
// ending, so that a test knows it. `suggestions` holds the answers given so
// far, by path.
const SUGGESTED: Record<string, FileKind[]> = {
  go: ['visual', 'film', 'lanes', 'stepthrough', 'schema', 'structure'],
  py: ['schema', 'visual', 'structure', 'film', 'lanes', 'stepthrough'],
  ts: ['lanes', 'visual', 'film', 'schema', 'stepthrough', 'structure'],
};
const suggestions = new Map<string, ViewSuggestion>();
// The text of the file at `path` as lines.
const fileLines = (path: string) => (FILES[path] ?? '').split('\n');
// Every definition named `name` in files with the same ending as `from`,
// those of `from` itself first. With `name` null, every definition there is.
function definitionsIn(from: string, name: string | null): NavTarget[] {
  const found: NavTarget[] = [];
  for (const path of Object.keys(FILES)) {
    if (name !== null && endingOf(path) !== endingOf(from)) continue;
    fileLines(path).forEach((text, row) => {
      for (const match of text.matchAll(DEFINED)) {
        if (name !== null && match[2] !== name) continue;
        const column = match.index + match[0].length - match[2].length;
        found.push({
          path,
          line: row + 1,
          column,
          endColumn: column + match[2].length,
          kind:
            KINDS[match[1]] ?? (match[1].includes('(') ? 'method' : 'function'),
          container: null,
          declaration: false,
          group: path === from ? 'file' : 'folder',
          text,
        });
      }
    });
  }
  return found.sort(
    (a, b) => Number(a.path !== from) - Number(b.path !== from),
  );
}
// Every place where `name` stands as a whole word in the file at `path`.
function usesIn(path: string, name: string): NavReference[] {
  const word = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g');
  return fileLines(path).flatMap((text, row) =>
    Array.from(text.matchAll(word), (match) => ({
      path,
      line: row + 1,
      column: match.index,
      endColumn: match.index + name.length,
      role: 'use' as const,
      text,
    })),
  );
}
// The word at a place of a file, with its columns, or null.
function wordIn(path: string, line: number, column: number) {
  const text = fileLines(path)[line - 1] ?? '';
  let start = column;
  let end = column;
  while (start > 0 && /\w/.test(text[start - 1])) start--;
  while (end < text.length && /\w/.test(text[end])) end++;
  return start === end || /\d/.test(text[start])
    ? null
    : { name: text.slice(start, end), column: start, endColumn: end };
}

// The history of a file of the mock workspace: its commits, newest first,
// each with the text the file had after it, and whether the file has
// changes that are not committed.
//
// The end-to-end test gives a file a history by putting it in
// `window.__mockGitHistory` under the path of the file. Every other file
// has one commit, which created it with the text it has now.
type MockHistory = {
  pending: boolean;
  commits: {
    commit: string;
    author: string;
    time: number;
    summary: string;
    text: string;
  }[];
};
function mockHistoryOf(path: string): MockHistory {
  const given = (window as any).__mockGitHistory?.[path];
  if (given) return given;
  return {
    pending: false,
    commits: [
      {
        commit: '9dbe5110c0ffee00000000000000000000000001',
        author: 'Ada Writer',
        time: Math.floor(Date.now() / 1000) - 8 * 86_400,
        summary: 'Add ' + path.split('/').pop(),
        text: FILES[path] ?? '',
      },
    ],
  };
}

// The runs of lines that differ between two texts, in the form git gives
// them. The lines the texts share at their start and at their end are set
// aside first. The lines between are compared with a table of the longest
// common run of lines, which is enough for the short files of the mock
// workspace.
function mockHunks(oldText: string, newText: string): GitHunk[] {
  const linesOf = (text: string) =>
    text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  // `longest[i][j]` is the length of the longest run of lines that the
  // parts from line `i` of the old text and from line `j` of the new text
  // have in common.
  const longest = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      longest[i][j] =
        a[head + i] === b[head + j]
          ? longest[i + 1][j + 1] + 1
          : Math.max(longest[i + 1][j], longest[i][j + 1]);
  const hunks: GitHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[head + i] === b[head + j]) {
      i++;
      j++;
      continue;
    }
    const fromOld = i;
    const fromNew = j;
    while (i < n || j < m) {
      if (i < n && j < m && a[head + i] === b[head + j]) break;
      if (j >= m || (i < n && longest[i + 1][j] >= longest[i][j + 1])) i++;
      else j++;
    }
    const oldLines = i - fromOld;
    const newLines = j - fromNew;
    hunks.push({
      oldStart: head + fromOld + (oldLines ? 1 : 0),
      oldLines,
      newStart: head + fromNew + (newLines ? 1 : 0),
      newLines,
    });
  }
  return hunks;
}

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
    openedRoot = path;
    return {
      root: path,
      name: path.split('/').filter(Boolean).pop() ?? path,
      store,
    };
  },
  async workspaceClose() {
    opened = false;
  },
  async workspaceSessionGet() {
    return (
      sessions.get(openedRoot) ?? {
        openFiles: [],
        selected: null,
        bookmarks: {},
      }
    );
  },
  async workspaceSessionSet(session) {
    sessions.set(openedRoot, session);
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
  // No folder is opened again at the start, unless the end-to-end test has
  // put the path of one in the browser's session storage under
  // `mockLastWorkspace`. The storage is used because the test loads the page
  // again to start the app, and that clears everything else.
  async workspaceLast() {
    return sessionStorage.getItem('mockLastWorkspace');
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
  // An SVG file of the mock workspace is its own text. Every other image is
  // one picture of 2 by 1 pixels.
  async fileImage(relPath) {
    const text = FILES[relPath];
    if (text == null) throw fail('not_found', 'Could not read that file.');
    if (relPath.endsWith('.svg'))
      return {
        relPath,
        dataUrl: `data:image/svg+xml;base64,${btoa(text)}`,
        bytes: text.length,
      };
    return { relPath, dataUrl: MOCK_PICTURE, bytes: 70 };
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
  // Every line of a file of the mock workspace was last changed by one
  // commit, made eight days ago. The user is its author on the odd lines.
  // The files under `nav/`, which the end-to-end test adds, are not tracked.
  // Git reports no changes, unless the end-to-end test has put a list of
  // them in `window.__mockGitStatus`.
  async gitStatus() {
    return (window as any).__mockGitStatus ?? [];
  },
  // The changes of a file of the mock workspace (see `mockHistoryOf`).
  async gitFileHistory(relPath) {
    if (!(relPath in FILES)) return null;
    const history = mockHistoryOf(relPath);
    const side = (commit: string | null) => ({ commit, path: relPath });
    const changes: GitChange[] = history.commits.map((commit, at) => ({
      commit: commit.commit,
      author: commit.author,
      time: commit.time,
      summary: commit.summary,
      old: at < history.commits.length - 1 ? side(commit.commit + '^') : null,
      new: side(commit.commit),
    }));
    if (history.pending)
      changes.unshift({
        commit: null,
        author: '',
        time: 0,
        summary: '',
        old: history.commits.length ? side('HEAD') : null,
        new: side(null),
      });
    return { changes, more: false };
  },
  async gitFileDiff(old, next) {
    await sleep((window as any).__mockDiffDelay ?? 0);
    // The text of a version: the file itself for the version on disk, and
    // the text the history has for a commit. `HEAD` is the newest commit,
    // and a hash with `^` is the commit before that one.
    const textOf = (side: GitSide) => {
      if (side.commit == null) return FILES[side.path] ?? '';
      const commits = mockHistoryOf(side.path).commits;
      if (side.commit === 'HEAD') return commits[0]?.text ?? '';
      const before = side.commit.endsWith('^');
      const hash = side.commit.replace(/\^$/, '');
      const at = commits.findIndex((commit) => commit.commit === hash);
      return commits[at + (before ? 1 : 0)]?.text ?? '';
    };
    const oldText = old ? textOf(old) : '';
    const newText = textOf(next);
    return {
      oldText,
      newText,
      hunks: mockHunks(oldText, newText),
      binary: false,
      tooLarge: false,
    };
  },
  async gitBlame(relPath, line) {
    if (!(relPath in FILES) || relPath.startsWith('nav/')) return null;
    return {
      committed: true,
      commit: '9dbe5110c0ffee00000000000000000000000001',
      author: 'Ada Writer',
      byUser: line % 2 === 1,
      time: Math.floor(Date.now() / 1000) - 8 * 86_400,
      summary: 'Refuse an order when the batch is full',
      body: 'The batch holds at most 64 orders.\nA full batch is flushed first.',
    };
  },
  async navLookup(relPath, line, column): Promise<NavLookup | null> {
    const word = wordIn(relPath, line, column);
    if (!word) return null;
    const definitions = definitionsIn(relPath, word.name);
    // The definitions in the clicked file are the likely ones when there
    // are any. Otherwise all are equally likely.
    const here = definitions.filter((one) => one.path === relPath).length;
    // The type of a name that the clicked line builds, as `Meter` for
    // `meter` in `meter := &Meter{}`.
    const built = new RegExp(`\\b${word.name}\\s*:=\\s*&?([A-Z]\\w*)`);
    const typeName = fileLines(relPath)[line - 1]?.match(built)?.[1] ?? null;
    const types = typeName ? definitionsIn(relPath, typeName) : [];
    return {
      name: word.name,
      line,
      column: word.column,
      endColumn: word.endColumn,
      basis: 'name',
      role: 'use',
      occurrences: usesIn(relPath, word.name),
      definitions,
      likely: here || definitions.length,
      typeName: types.length ? typeName : null,
      types,
      certain: definitions.length === 1,
      indexing: false,
    };
  },
  async navReferences(relPath, line, column, onEvent) {
    const word = wordIn(relPath, line, column);
    const paths = [
      relPath,
      ...Object.keys(FILES).filter(
        (path) => path !== relPath && endingOf(path) === endingOf(relPath),
      ),
    ];
    const found = word ? paths.map((path) => usesIn(path, word.name)) : [];
    const references = found.flat();
    // The answer comes a moment later, as it does from the core.
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (references.length) onEvent({ type: 'found', references });
    onEvent({
      type: 'done',
      total: references.length,
      files: found.filter((of) => of.length).length,
      exact: false,
      truncated: false,
    });
  },
  async navCancel() {},
  async navSymbols(query, limit = 50) {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return [];
    return definitionsIn('', null)
      .map((target) => ({
        ...target,
        name: target.text.slice(target.column, target.endColumn),
      }))
      .filter((hit) => hit.name.toLowerCase().includes(wanted))
      .slice(0, limit);
  },
  async navRefresh() {},
  async suggestCached(relPath) {
    return suggestions.get(relPath) ?? null;
  },
  async suggestViews(relPath): Promise<ViewSuggestion> {
    if (FILES[relPath] == null)
      throw fail('not_found', 'Could not read that file.');
    // The answer comes a moment later, as it does from an agent.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const name = relPath.split('/').pop()!;
    const order = SUGGESTED[endingOf(relPath)] ?? SUGGESTED.go;
    const made: ViewSuggestion = {
      path: relPath,
      ranked: order.map((kind, place) => ({
        kind,
        reason:
          place === 0
            ? `The stand-in agent puts this first for ${name}.`
            : `Shows less of ${name} than the kinds above it.`,
      })),
      agent: 'Mock Agent',
      model: 'small',
      createdAt: new Date().toISOString(),
      sourceHash: 'sha256:mock',
    };
    suggestions.set(relPath, made);
    return made;
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
  async gitignoreStopAsking() {
    store = { ...store, askAboutGitignore: false };
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
      plainArgs: ['--plain'],
      plainNote: 'your own instruction files and plugins',
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
          : request.kind === 'stepthrough'
            ? 320
            : request.kind === 'view'
              ? 160
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
    const jobId = `mock-${Date.now()}-${++mockJobsStarted}`;
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
          : request.kind === 'stepthrough'
            ? 'stepthrough'
            : request.kind === 'view'
              ? (request.view ?? 'schema')
              : 'visual');
    const form =
      request.kind === 'compose'
        ? request.film
          ? ('film' as const)
          : ('visual' as const)
        : extras.get(`${base?.id}/${request.baseVersion}`)?.form;
    const scope = base?.scope ?? request.scope;
    const id =
      base?.id ??
      `${kind}-` +
        subject.replace(/[^a-z0-9]+/gi, '_').toLowerCase() +
        (scope ? `-${scope.id}` : '') +
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
              : request.kind === 'view'
                ? [
                    [80, phase('reading')],
                    [150, tool(`Read ${subject}`)],
                    [150, phase('analysing')],
                    [200, tool(`Write ${dir}/model.json`)],
                    [150, phase('annotating')],
                    [250, tool(`Write ${dir}/src/view.json`)],
                  ]
                : request.kind === 'stepthrough'
                  ? [
                      [80, phase('reading')],
                      [150, tool(`Read ${subject}`)],
                      [150, phase('analysing')],
                      [200, tool(`Write ${dir}/model.json`)],
                      [150, phase('drawing')],
                      [250, tool(`Write ${dir}/src/plant.js`)],
                      [150, phase('stepping')],
                      [250, tool(`Write ${dir}/src/sim.js`)],
                      [150, phase('annotating')],
                      [200, tool(`Write ${dir}/src/visual.json`)],
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
        scope,
        // The end-to-end test sets `window.__mockRuntime` to make the version
        // look as if an older app had built it.
        runtimeVersion: (window as any).__mockRuntime,
      });
      const recorded = extras.get(`${id}/${version}`);
      if (existing) {
        existing.versions.push(entry);
        existing.currentVersion = version;
      } else
        artifacts.push({
          id,
          kind,
          title: scope
            ? `${scope.symbol ?? `lines ${scope.startLine}–${scope.endLine}`} · ${subject.split('/').pop()}`
            : kind === 'pipeline'
              ? 'Orders: from the handler to the store'
              : kind === 'film'
                ? 'How an order moves through the orders Handler'
                : kind in VIEW_DEFINITIONS
                  ? (VIEW_DEFINITIONS[kind]?.title ?? kind)
                  : kind === 'stepthrough'
                    ? `Limiter.Allow · ${subject.split('/').pop()}`
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
          scope,
          scopeNow: scope && {
            startLine: scope.startLine,
            endLine: scope.endLine,
            state: 'same',
          },
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
  // Adds a version that is a copy of `version` and records the current
  // runtime. The end-to-end test sets `window.__mockRebuildFails` to try the
  // case that the new page does not pass its checks.
  async artifactRebuild(id, version) {
    const summary = artifacts.find((a) => a.id === id);
    const from = summary?.versions.find((v) => v.version === version);
    if (!summary || !from)
      throw fail('not_found', 'That version of the artifact does not exist.');
    await sleep(200);
    if ((window as any).__mockRebuildFails)
      throw fail(
        'rebuild_failed',
        'The page that the current runtime builds from this version does not pass the checks, so the version was left as it is. Regenerate it to get one that does.',
      );
    const made = summary.versions.length + 1;
    summary.versions.push({
      ...from,
      version: made,
      createdAt: new Date().toISOString(),
      parent: version,
    });
    summary.currentVersion = made;
    extras.set(`${id}/${made}`, {
      ...extras.get(`${id}/${version}`),
      feedback: undefined,
      runtimeVersion: '1.5.0',
    });
    return made;
  },
  async threadList() {
    return threads.map((thread) => ({
      ...thread,
      messages: [...thread.messages],
    }));
  },
  // Plays a made-up question: the agent reads the file and answers a moment
  // later. The answer names a line of the file, and one that does not
  // exist, which is not among its `refs`.
  //   - A question about a visual gets a note on the first part of the
  //     visual, and a question with the word "flag" in it a flag on the
  //     second part as well.
  //   - A question about a film gets a note at the moment the film is at.
  //   - A question with the word "fail" in it is refused, as it is when the
  //     agent reports an error.
  async threadAsk(request, askId, onEvent) {
    (window as any).__mockLastAsk = request;
    const number = ++mockAsksStarted;
    let cancelled = false;
    cancelledJobs.set(askId, () => {
      cancelled = true;
    });
    const existing = threads.find((one) => one.id === request.threadId);
    const path = existing?.path ?? request.scope?.path ?? request.path;
    onEvent({
      type: 'started',
      agent: 'Mock Agent',
      continues: !!existing || !!request.about.artifactId,
    });
    await sleep(150);
    onEvent({ type: 'text', text: 'I will read the code first.' });
    onEvent({ type: 'tool', name: 'Read', summary: path });
    await sleep((window as any).__mockAskDelay ?? 250);
    if (cancelled) throw fail('cancelled', 'The question was cancelled.');
    if (/\bfail\b/i.test(request.text))
      throw fail('ask_failed', 'Mock Agent reported an error: Not logged in');
    const shown = artifacts.find((a) => a.id === request.about.artifactId);
    const scope = existing?.scope ?? request.scope;
    const what = scope
      ? (scope.symbol ?? `Lines ${scope.startLine} to ${scope.endLine}`)
      : (path.split('/').pop() ?? path);
    const place =
      FILES[path] != null ? `${path}:20` : 'internal/orders/handler.go:20';
    const text =
      `${what} queues the order and flushes when the batch is full, see \`${place}\`.\n\n` +
      '- It refuses an order that is not valid.\n' +
      `- It asks \`limiter\` first, which is not at \`${path}:9000\`.`;
    onEvent({ type: 'text', text });
    const nodes = shown
      ? (mockDetail(shown, shown.currentVersion).definition?.nodes ?? [])
      : [];
    const isFilm = shown?.kind === 'film' || shown?.form === 'film';
    const thread: Thread = existing ?? {
      id: `t-mock-${number}`,
      title: request.text.trim().split('\n')[0].slice(0, 80),
      path,
      scope: request.scope,
      artifactId: request.scope ? undefined : request.about.artifactId,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      messages: [],
      scopeNow: request.scope && {
        startLine: request.scope.startLine,
        endLine: request.scope.endLine,
        state: 'same',
      },
    };
    const noteId = (n: number) =>
      `${thread.id}-${thread.messages.length / 2 + 1}-${n}`;
    const notes: NonNullable<Thread['messages'][number]['notes']> = [];
    if (shown && isFilm)
      notes.push({
        id: noteId(1),
        artifactId: shown.id,
        time: request.about.time ?? 5,
        kind: 'note',
        text: 'This is the moment the batch is written.',
      });
    else if (shown && nodes[0]) {
      notes.push({
        id: noteId(1),
        artifactId: shown.id,
        part: nodes[0].id,
        kind: 'note',
        text: `${nodes[0].label} is where the order comes in.`,
      });
      if (/\bflag\b/i.test(request.text) && nodes[1])
        notes.push({
          id: noteId(2),
          artifactId: shown.id,
          part: nodes[1].id,
          kind: 'flag',
          text: `${nodes[1].label} keeps the batch when the write fails.`,
        });
    }
    const now = new Date().toISOString();
    thread.messages = [
      ...thread.messages,
      {
        role: 'user',
        text: request.text.trim(),
        createdAt: now,
        author: 'Mock User',
        about: request.about,
      },
      {
        role: 'agent',
        text,
        createdAt: now,
        author: 'Mock Agent',
        model: 'mock-model',
        refs: [{ text: place, path: place.split(':')[0], line: 20 }],
        notes,
      },
    ];
    thread.updatedAt = now;
    threads = [thread, ...threads.filter((one) => one.id !== thread.id)];
    return { ...thread, messages: [...thread.messages] };
  },
  async threadDelete(id) {
    threads = threads.filter((one) => one.id !== id);
  },
  async scopeForSelection(relPath, startLine, endLine) {
    const lines = (FILES[relPath] ?? '').split('\n');
    const blank = (line: number) => !(lines[line - 1] ?? '').trim();
    let first = Math.min(Math.max(1, startLine), lines.length);
    let last = Math.min(Math.max(first, endLine), lines.length);
    while (first < last && blank(first)) first++;
    while (last > first && blank(last)) last--;
    if (FILES[relPath] == null || blank(first))
      throw fail('bad_request', 'Select at least one line of code first.');
    const around = mockExtents(relPath)
      .filter((one) => one.first <= first && one.last >= last)
      .sort((a, b) => a.last - a.first - (b.last - b.first))[0];
    const found: ScopeCandidates = {
      lines: mockScope(relPath, first, last),
      symbol:
        around && mockScope(relPath, around.first, around.last, around.name),
      exact: !!around && around.first === first && around.last === last,
    };
    return found;
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
  // The browser has no menu bar, so the handler is never called.
  async onMenuOpenFolder() {
    return () => {};
  },
  // The end-to-end test server serves the built reference pages under this
  // path. A mock film shows the reference film, a mock step-through the
  // reference step-through, a mock pipeline the reference pipeline, and
  // every other mock artifact the reference visual.
  artifactUrl(path) {
    if (path.startsWith('artifact/film-'))
      return '/__artifact/reference/film.html';
    if (path.startsWith('artifact/stepthrough-'))
      return '/__artifact/reference/stepthrough.html';
    // A mock view shows the reference view of the same name.
    const view = Object.keys(VIEW_DEFINITIONS).find((name) =>
      path.startsWith(`artifact/${name}-`),
    );
    if (view) return `/__artifact/reference/view-${view}.html`;
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
