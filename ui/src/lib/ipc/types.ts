// The shapes that cross between the interface and the Rust core. Each type
// mirrors a struct in crates/codjiva-core or ui/src-tauri; field names are the
// camelCase form of the Rust fields.

export type AppInfo = {
  name: string;
  version: string;
  platform: 'macos' | 'windows' | 'linux' | string;
  runtimeVersion: string;
  dotDir: string;
};

export type GitState = 'not_a_repository' | 'ignored' | 'not_ignored';

export type StoreStatus = {
  git: GitState;
  gitignoreChoice: 'added' | 'tracked' | null;
  askAboutGitignore: boolean;
};

export type WorkspaceInfo = { root: string; name: string; store: StoreStatus };

export type RecentWorkspace = { path: string; name: string; openedAt: string };

// One file tab of a workspace, as it is remembered between two openings of
// the folder. `path` is what the tab stands for, `view` is the view of it
// that was showing, such as `visual` or `source`, and `line` is the line the
// source view was at, or null.
export type SessionTab = { path: string; view: string; line: number | null };
// What was open in a workspace when the user last used it: the file tabs from
// left to right, and the `path` of the tab that was on screen.
export type WorkspaceSession = {
  openFiles: SessionTab[];
  selected: string | null;
};

export type TreeEntry = {
  name: string;
  relPath: string;
  kind: 'file' | 'dir';
  lang: string | null;
  size: number | null;
};

export type FileInfo = {
  relPath: string;
  name: string;
  lang: string | null;
  highlighter: string;
  bytes: number;
  lines: number | null;
  hash: string | null;
  binary: boolean;
};

export type FileContent = {
  relPath: string;
  text: string;
  truncated: boolean;
  highlighter: string;
};

export type FileHit = { relPath: string; name: string };

export type Changes = { dirs: string[]; paths: string[] };

export type Settings = {
  agent: string | null;
  models: Record<string, string>;
  // How much effort the model spends on thinking. `auto` lets the app choose by
  // the kind of job, and `agent` asks for nothing, so the agent uses its own
  // default.
  effort: 'auto' | 'agent' | 'low' | 'medium' | 'high';
  // The address of each API provider, by provider id, when it is not the
  // provider's usual one.
  apiBaseUrls: Record<string, string>;
  agentPaths: Record<string, string>;
  maxFixIterations: number;
  // Whether a command-line agent may load the user's own setup for it, such as
  // CLAUDE.md files, skills, plugins and hooks. With false, an agent that has
  // `plainArgs` is started with them.
  agentCustomizations: boolean;
  filmLength: 'short' | 'standard' | 'deep';
  soundOnByDefault: boolean;
  basePlaybackSpeed: number;
  externalEditorCommand: string;
  maxCompanionFiles: number;
  // Patterns for files and folders that are never suggested as companions,
  // written like the lines of a `.gitignore` file.
  companionIgnore: string[];
  // The colours of the app's own window. `system` follows the operating system.
  theme: 'system' | 'light' | 'dark';
  maxBudgetUsd: number | null;
  layout: Layout;
  // Whether the app looks for a newer version by itself. With false it looks
  // only when the user asks in Settings.
  checkForUpdates: boolean;
};

// A newer version of the app that the latest release offers. `notes` is the
// text of the release, or null if it has none.
export type UpdateInfo = { version: string; notes: string | null };

// The panels around the editor area as the user left them: which are open, and
// their sizes in pixels. A height of null means the height the app chooses.
// `stepPanelHeight` is the height of the strip of panels under a step-through.
// That strip is drawn by the step-through's own page, and null means the
// height that page starts with.
export type Layout = {
  sidebarOpen: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  dockHeight: number | null;
  libraryOpen: boolean;
  libraryHeight: number | null;
  stepPanelHeight: number | null;
};

// An agent that could run jobs, as found on this machine.
export type AgentInfo = {
  id: string;
  name: string;
  kind: 'cli' | 'api' | 'replay' | string;
  path: string | null;
  version: string | null;
  ok: boolean;
  note: string;
  supportsResume: boolean;
  verified: boolean;
  // The model jobs use when Settings names none, for agents that have one.
  defaultModel?: string | null;
  // A small, fast model for a short question, for agents that name one.
  quickModel?: string | null;
  // What the user should know about how far this agent can be confined. Empty
  // for an agent that its own permission rules confine to the folder it writes
  // into.
  limits?: string;
  // The arguments that start this agent without the user's own setup for it,
  // and what they keep out of a job, as the end of the sentence "Codjiva
  // starts this agent without ...". Both are empty or missing for an agent
  // that has no such arguments.
  plainArgs?: string[];
  plainNote?: string;
};

// An API provider and what it still needs before it can run a job.
export type ApiProvider = {
  id: string;
  name: string;
  // Where the key in use came from. null means there is no key.
  keySource: 'saved' | 'environment' | null;
  keyOptional: boolean;
  envVars: string[];
  // The model jobs will use. null means the user still has to choose one.
  model: string | null;
  defaultModel: string | null;
  // The address requests go to. null means the user still has to enter one.
  baseUrl: string | null;
  defaultBaseUrl: string | null;
  ok: boolean;
  // What is missing, as a sentence. Empty when nothing is.
  note: string;
};

// One chapter of a film's outline, as the agent plans it before it draws.
export type OutlineChapter = {
  id: string;
  title: string;
  summary: string;
  beats: { t?: number; what: string }[];
  rewind?: boolean;
};
export type Outline = {
  schemaVersion: 1;
  title: string;
  targetSeconds?: number;
  chapters: OutlineChapter[];
};

// One chapter of a finished film: where it starts and how long it runs, in real
// seconds.
export type Chapter = {
  id: string;
  title: string;
  name: string;
  desc: string;
  start: number;
  dur: number;
};

// The element the user pointed at in an artifact, as the artifact describes it.
// `x` and `y` are where the pointer was, and `box` is the element's box, all in
// stage pixels. A film adds the scene on screen, the film time `t` and that
// scene's animation time `sceneT`.
export type PickedElement = {
  x: number;
  y: number;
  selector?: string;
  part?: string;
  text?: string;
  box?: [number, number, number, number];
  scene?: string;
  t?: number;
  sceneT?: number;
};

// What the user said about a version, and what they were looking at.
export type Feedback = {
  text: string;
  time?: number | null;
  chapter?: string | null;
  scene?: string | null;
  sceneTime?: number | null;
  pointAt?: PickedElement | null;
  selected?: string | null;
  // A picture of the frame, as a path relative to the workspace.
  screenshot?: string | null;
};

// One port of an artifact: a point where work crosses the edge of the code it
// explains.
export type Port = {
  id: string;
  dir: 'in' | 'out';
  symbol: string;
  ref: string;
  carries: string;
  kind: string;
  anchor: [number, number] | null;
};

// The ports of one artifact's current version.
export type ArtifactPorts = {
  artifactId: string;
  version: number;
  title: string;
  subject: string[];
  ports: Port[];
};

// A join between an out port of one artifact and an in port of another.
// `strength` is set for a join the app proposed: the same symbol, the same last
// name, or a mention in the line of code.
export type Join = {
  fromArtifact: string;
  fromPort: string;
  toArtifact: string;
  toPort: string;
  symbol: string;
  kind: string;
  carries: string;
  reason: string;
  strength: 'exact' | 'name' | 'line' | null;
};

// One artifact that a pipeline is composed of, under the short key the pipeline
// gives it.
export type Part = { key: string; artifact: string; version: number };

export type JobRequest = {
  kind:
    'visualise' | 'animate' | 'compose' | 'stepthrough' | 'view' | 'feedback';
  // For a view job: which of the four views to make.
  view?: ViewName;
  // The file the artifact explains. Empty for a feedback job, which names a
  // version instead.
  subject: string[];
  companions?: string[];
  instructions?: string;
  // For a film: its target length in real seconds, and an outline the user
  // approved or edited.
  lengthSeconds?: number;
  outline?: Outline | null;
  // For feedback: the version to change and what the user said.
  artifactId?: string;
  baseVersion?: number;
  feedback?: Feedback;
  // For a pipeline: the artifacts to join, in flow order, the confirmed joins,
  // and whether the pipeline is a film instead of a still visual.
  parts?: string[];
  joins?: Join[];
  film?: boolean;
};

// How long a job is expected to take, in seconds. Most jobs like it finish
// between `lowSeconds` and `highSeconds`. `samples` is the number of earlier
// jobs on this computer the estimate was corrected with. With 0 it comes from
// the size of the code alone.
export type Estimate = {
  lowSeconds: number;
  highSeconds: number;
  typicalSeconds: number;
  samples: number;
};

// What a Visualise job on a whole folder would have to read.
export type FolderInfo = {
  // The folder, relative to the workspace root, without a trailing slash.
  relPath: string;
  name: string;
  // The code files in the folder and below it.
  files: string[];
  bytes: number;
  // A rough count of the tokens an agent reads for those files.
  estimatedTokens: number;
  // True for a folder big enough to deserve a stronger warning.
  large: boolean;
  // True for a folder too big to be visualised as a whole.
  tooLarge: boolean;
};

// A file suggested as a companion for a film, with the reason.
export type Suggestion = { path: string; why: string; score: number };

// What a set of ignore patterns matches in the open workspace.
export type IgnoreCheck = {
  // How many code files of the workspace the patterns match, and the first few
  // of them.
  matched: number;
  examples: string[];
  // Which of the paths that were asked about match.
  matchedPaths: string[];
  // The patterns that could not be read as a pattern.
  invalid: string[];
};

// Code navigation in the source view. The Rust side is the crate
// `codjiva-nav`. A line is counted from 1. A column is counted from 0 and is
// an index into the line's text as a JavaScript string.

// A range of characters on one line: from `column` up to, but not including,
// `endColumn`.
export type NavSpan = { line: number; column: number; endColumn: number };
// What kind of thing a definition is.
export type NavKind =
  | 'function'
  | 'method'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'enum'
  | 'type'
  | 'constant'
  | 'variable'
  | 'field'
  | 'enumerator'
  | 'namespace'
  | 'module'
  | 'macro';
// How close a definition is to the place the name was clicked, closest
// first.
//   - `scope`: the name is a parameter or a local variable, and this is the
//     place in the same function that defines it.
//   - `owner`: the code says what the name belongs to, and this definition
//     belongs to that. `sink.write()` names the owner. A name inside a method
//     of a C++ or Java class can belong to that class without anything in
//     front of it.
//   - `inherited`: this definition belongs to something the owner derives
//     from, such as a base class.
//   - `file`: defined in the file the name was clicked in.
//   - `imported`: defined in a file that file imports.
//   - `folder`: defined in another file of the same folder.
//   - `elsewhere`: defined anywhere else in the workspace.
export type NavGroup =
  | 'scope'
  | 'owner'
  | 'inherited'
  | 'file'
  | 'imported'
  | 'folder'
  | 'elsewhere';
// What one occurrence of a name is. `declaration` is a place that announces
// the name without its body, such as a prototype in a C header. `text` means
// the word was found in a file that is not parsed, so nothing is known about
// how it is used there.
export type NavRole =
  'definition' | 'declaration' | 'call' | 'type' | 'use' | 'text';
// One place that defines a name. `text` is the line of code.
export type NavTarget = NavSpan & {
  path: string;
  kind: NavKind;
  container: string | null;
  declaration: boolean;
  group: NavGroup;
  text: string;
};
// What is known about the name at one place of a file.
export type NavLookup = NavSpan & {
  name: string;
  // How the answer was found.
  //   - `scope`: the name is local to a function and its definition was
  //     found exactly.
  //   - `name`: every definition with this name is a candidate, ranked by how
  //     close it is.
  //   - `text`: the file's language is not parsed, so the name was read as a
  //     word of text.
  basis: 'scope' | 'name' | 'text';
  role: NavRole;
  // Every place in the same file where the name means the same thing.
  occurrences: NavSpan[];
  // The places that define the name, best first.
  definitions: NavTarget[];
  // How many entries at the start of `definitions` the code around the name
  // points to. The entries after them only have the same name. Equal to the
  // length of `definitions` when nothing tells them apart.
  likely: number;
  // The type the code gives the name, as written, when the workspace defines
  // that type, and the places that define it. `types` is empty when
  // `typeName` is null.
  typeName: string | null;
  types: NavTarget[];
  // True when the first definition is the one the name can mean, so the
  // interface can go there without asking.
  certain: boolean;
  // True while the workspace is still being indexed.
  indexing: boolean;
};
// One place where a name is used. `text` is the line of code.
export type NavReference = NavSpan & {
  path: string;
  role: NavRole;
  text: string;
};
// What a search for references reports while it runs: more references, in
// the order they are listed, and at the end how it went. `exact` is true when
// the name is local to a function, so the list is all of its uses and nothing
// else. `truncated` is true when the search stopped at its limit.
export type NavRefsEvent =
  | { type: 'found'; references: NavReference[] }
  | {
      type: 'done';
      total: number;
      files: number;
      exact: boolean;
      truncated: boolean;
    };
// A kind of artifact that can be made of one file.
export type FileKind =
  'visual' | 'film' | 'stepthrough' | 'schema' | 'lanes' | 'structure';
// An agent's answer to which kind of artifact suits a file. `ranked` holds
// the kinds, best first, each with one sentence of reason. A kind the agent
// left out is not listed. `sourceHash` is the hash of the file's content when
// the agent was asked.
export type ViewSuggestion = {
  path: string;
  ranked: { kind: FileKind; reason: string }[];
  agent: string;
  model: string | null;
  createdAt: string;
  sourceHash: string;
};
// One definition found by its name.
export type SymbolHit = NavSpan & {
  name: string;
  kind: NavKind;
  container: string | null;
  path: string;
};

// An area of the window, in CSS pixels from the top-left of the page.
export type Rect = { x: number; y: number; width: number; height: number };

export type Violation = {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  tracked: boolean;
};
export type RevertResult = { path: string; reverted: boolean; note: string };

// One element named by a self-test issue: where it is and what it says.
//
// `box` is the element's box in stage pixels, as the viewer sees it. `world` is
// the same box in world pixels, the coordinates the agent wrote in its files.
// An element outside the drawn world, such as the title, has no `world`.
//
// `drawnBy` and `move` are set for an element the agent cannot find in its
// files by the name in `selector`: a label that a part function of the runtime
// wrote, or a marker of a visual. `drawnBy` names the call or the entry that
// draws the element, and `move` says which arguments of that call place it.
export type IssueElement = {
  selector: string;
  text: string;
  box: [number, number, number, number];
  world?: [number, number, number, number];
  drawnBy?: string;
  move?: string;
};
// `overlap` is set on a `text-overlap` issue between two labels of the drawn
// world. It is how far the two labels reach into each other, as
// `[across, down]` in world pixels.
export type Issue = {
  check: string;
  severity: 'error' | 'warning';
  scene?: string;
  t?: number;
  message?: string;
  hint?: string;
  a?: IssueElement;
  b?: IssueElement;
  overlap?: [number, number];
  count?: number;
};
export type BuildProblem = {
  check: string;
  severity: 'error' | 'warning';
  file: string;
  line: number | null;
  message: string;
};
// The combined result of building a version and running its self-test.
export type ValidationReport = {
  ok: boolean;
  built?: boolean;
  build?: BuildProblem[];
  issues: Issue[];
  stats?: unknown;
  duration?: number | null;
};

export type JobEvent =
  | {
      type: 'started';
      jobId: string;
      artifactId: string;
      version: number;
      agent: string;
    }
  | {
      type: 'phase';
      phase: string;
      detail: string | null;
      chapter?: number | null;
      of?: number | null;
    }
  | { type: 'outline'; outline: Outline }
  | { type: 'log'; level: 'info' | 'tool' | 'warn' | 'error'; text: string }
  | { type: 'guard'; violations: Violation[] }
  | { type: 'validation'; report: ValidationReport; iteration: number }
  | {
      type: 'usage';
      costUsd: number | null;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: 'result';
      artifactId: string;
      version: number;
      passed: boolean;
      errors: number;
      warnings: number;
    }
  | { type: 'failed'; code: string; message: string }
  | { type: 'cancelled' };

// The four views. A view is drawn by the runtime from data that the agent
// wrote, without coordinates. `schema` shows the data shapes of the code,
// `lanes` who talks to whom in time order, `structure` a data structure in
// memory step by step, and `map` a folder level by level.
export type ViewName = 'schema' | 'lanes' | 'structure' | 'map';
// A step-through is a visual that the viewer can run on an input, one step
// at a time.
export type ArtifactKind =
  'visual' | 'film' | 'pipeline' | 'stepthrough' | ViewName;

export type VersionSummary = {
  version: number;
  createdAt: string;
  passed: boolean;
  errors: number;
  warnings: number;
  instructions: string;
  agent: string;
  model: string | null;
  parent: number | null;
};

export type ArtifactSummary = {
  id: string;
  kind: ArtifactKind;
  title: string;
  subject: string[];
  currentVersion: number;
  versions: VersionSummary[];
  sources: string[];
  stale: boolean;
  staleSources: string[];
  durationSec: number | null;
  ports: Port[];
  // For a pipeline: whether its current version is a visual or a film, and its
  // parts.
  form?: 'visual' | 'film';
  parts?: Part[];
};

// A place in the code. `end` is the last line when the reference names a
// range of lines and not one line.
export type CodeRef = { path: string; line: number; end?: number };
// Why the code does what a node of a visual or a bubble of a film describes.
// `text` is plain words with identifiers between backticks. `basis` says
// where the reason comes from: "stated" when a comment or a name in the code
// gives it, "inferred" when the agent concluded it from how the code works.
// `refs` are the places in the code that show the reason.
export type Rationale = {
  text: string;
  basis: 'stated' | 'inferred';
  refs: CodeRef[];
};
// One way the work goes on from a part. `to` is the id of another node, or a
// few words when the target is not drawn.
export type NodeTransition = { when: string; to: string };
// Something the code does that a reader would not expect. `example` is an
// input that shows it. `refs` name the lines that make it so.
export type EdgeCase = { text: string; example?: string; refs: CodeRef[] };
// One part of a visual or a step-through that the viewer can select. Besides
// its name and role it carries the detail the inspector shows for it: the
// code behind it (the first entry of `refs`), what it reads and writes, where
// the work goes next, and its edge cases.
export type VisualNode = {
  id: string;
  label: string;
  role: string;
  refs?: CodeRef[];
  rationale?: Rationale;
  select: string[];
  inputs?: string[];
  outputs?: string[];
  transitions?: NodeTransition[];
  edgeCases?: EdgeCase[];
  // What kind of thing the node is, in a view: `struct` or `enum` in a
  // schema, `service` or `thread` in lanes, `file` or `function` on a map.
  kind?: string;
  // In a schema: the fields of the type, in the order of the code.
  fields?: SchemaField[];
  // On a map: the id of the node this one is inside, and the workspace path
  // of the file or folder it stands for.
  parent?: string;
  path?: string;
};
// One field of a type in a schema view. An enum's values are fields without
// a `type`. `key` is true for a field that identifies the record.
export type SchemaField = {
  name: string;
  type?: string;
  note?: string;
  key?: boolean;
  optional?: boolean;
};
// In a schema view: the function `by` reads or writes the field `field` of
// the node `node`, at the place `ref` names as `path:line`.
export type FieldUse = {
  node: string;
  field: string;
  by: string;
  how: 'reads' | 'writes';
  ref: string;
};
// On a map: the node `from` uses the node `to`.
export type MapLink = {
  from: string;
  to: string;
  kind: string;
  label?: string;
};
// What a step-through adds to a visual, as far as the app reads it.
export type Stepper = {
  input: { label: string; hint?: string };
  presets: { label: string; input: string }[];
};
// One chapter of a film as film.json holds it, as far as the app reads it.
export type FilmScene = {
  id: string;
  title: string;
  name?: string;
  bubbles: { kicker: string; html: string; rationale?: Rationale }[];
};

export type Manifest = {
  artifactId: string;
  version: number;
  kind: ArtifactKind;
  title: string;
  subject: string[];
  companions: { path: string; why: string }[];
  sources: Record<string, string>;
  instructions: string;
  agent: {
    kind: string;
    version: string | null;
    model: string | null;
    sessionId: string | null;
  };
  promptVersion: string;
  runtimeVersion: string;
  validation: {
    passed: boolean;
    iterations: number;
    errors: number;
    warnings: number;
  };
  createdAt: string;
  parent?: number;
  costUsd?: number;
  // For a film: its length in seconds and its chapters.
  durationSec?: number;
  chapters?: Chapter[];
  // The user's feedback that produced this version.
  feedback?: string;
  // For a pipeline: its form, its parts in flow order and the joins between
  // them.
  form?: 'visual' | 'film';
  parts?: Part[];
  joins?: Join[];
};

export type ArtifactDetail = {
  manifest: Manifest;
  // The version's visual.json or film.json.
  definition: {
    title?: string;
    nodes?: VisualNode[];
    // Set for a step-through only.
    stepper?: Stepper;
    // Set for a view: which view it is, and the parts of its data that the
    // inspector shows beside the nodes.
    view?: ViewName;
    uses?: FieldUse[];
    links?: MapLink[];
    layers?: Record<string, string[]>;
    legend?: unknown[];
    // The chapters of a film. A visual has none.
    scenes?: FilmScene[];
  } | null;
  // The agent's analysis of the code, model.json.
  model: Record<string, any> | null;
  validation: ValidationReport | null;
  bytes: number;
};

// What the window is asked to check for a running job: load this version in a
// hidden frame and run its self-test.
export type ValidateRequest = {
  token: string;
  artifactId: string;
  version: number;
};

// An error returned by a command. `code` is stable and may be branched on;
// `message` is a full sentence for the user.
export type AppError = { code: string; message: string; detail?: string };

// Everything the interface can ask the core to do. Two implementations exist:
// one that calls the Tauri commands, and an in-memory one for running the
// interface in a plain browser.
export interface Api {
  appInfo(): Promise<AppInfo>;
  pickFolder(): Promise<string | null>;
  workspaceOpen(path: string): Promise<WorkspaceInfo>;
  workspaceClose(): Promise<void>;
  workspaceRecent(): Promise<RecentWorkspace[]>;
  // The file tabs that were open in the open workspace when it was last
  // used, and keeping the ones that are open now for the next time.
  workspaceSessionGet(): Promise<WorkspaceSession>;
  workspaceSessionSet(session: WorkspaceSession): Promise<void>;
  treeChildren(relPath: string): Promise<TreeEntry[]>;
  fileInfo(relPath: string): Promise<FileInfo>;
  fileRead(relPath: string): Promise<FileContent>;
  filesSearch(query: string, limit?: number): Promise<FileHit[]>;
  watchDirs(dirs: string[]): Promise<void>;
  storeEnsure(): Promise<StoreStatus>;
  gitignoreAdd(): Promise<StoreStatus>;
  gitignoreKeepTracked(): Promise<StoreStatus>;
  settingsGet(): Promise<Settings>;
  settingsSet(settings: Settings): Promise<Settings>;
  openExternal(relPath: string, line?: number): Promise<void>;
  reveal(relPath: string): Promise<void>;
  setFullscreen(on: boolean): Promise<void>;
  // Sets the theme of the window itself. `null` follows the operating system.
  setWindowTheme(theme: 'light' | 'dark' | null): Promise<void>;
  agentsDetect(refresh?: boolean): Promise<AgentInfo[]>;
  apiProviders(): Promise<ApiProvider[]>;
  // Saves a provider's key in the operating system's credential store.
  apiKeySet(providerId: string, key: string): Promise<void>;
  apiKeyClear(providerId: string): Promise<void>;
  // Sends one very small request to the provider. Returns the name of the model
  // that answered.
  apiCheck(providerId: string): Promise<string>;
  // Suggests companion files for a film of this file, best first.
  companionsSuggest(relPath: string): Promise<Suggestion[]>;
  // Reports what the ignore patterns match in the open workspace and which of
  // `paths` they match. Saves nothing.
  companionsIgnoreCheck(
    patterns: string[],
    paths: string[],
  ): Promise<IgnoreCheck>;
  folderInfo(relPath: string): Promise<FolderInfo>;
  // Reads the ports of the given artifacts and proposes joins between them.
  composePropose(
    artifactIds: string[],
  ): Promise<{ parts: ArtifactPorts[]; joins: Join[] }>;
  // Saves a picture of an area of the window for a feedback job. Returns its
  // path relative to the workspace, or null where the app cannot take such a
  // picture.
  feedbackCapture(rect: Rect): Promise<string | null>;
  // Starts a job and returns its id. `onEvent` is called for everything the job
  // does.
  jobStart(
    request: JobRequest,
    onEvent: (event: JobEvent) => void,
  ): Promise<string>;
  // Estimates how long `request` would take if it were started now. Returns
  // null when no agent is available. Nothing is started.
  jobEstimate(request: JobRequest): Promise<Estimate | null>;
  jobCancel(jobId: string): Promise<void>;
  jobValidated(token: string, report: ValidationReport): Promise<void>;
  artifactList(): Promise<ArtifactSummary[]>;
  artifactDetail(id: string, version?: number): Promise<ArtifactDetail>;
  artifactSetCurrent(id: string, version: number): Promise<void>;
  artifactDelete(id: string): Promise<void>;
  // Asks the user where to save, then writes the version's self-contained page
  // there. Returns the chosen path, or null when the user cancelled.
  artifactExport(
    id: string,
    version: number,
    suggestedName: string,
  ): Promise<string | null>;
  artifactOpenInBrowser(id: string, version: number): Promise<void>;
  artifactReveal(id: string, version: number): Promise<void>;
  guardRevert(violations: Violation[]): Promise<RevertResult[]>;
  // Calls `handler` whenever a running job needs a version checked. Returns a
  // function that stops it.
  onValidateRequest(
    handler: (request: ValidateRequest) => void,
  ): Promise<() => void>;
  // Calls `handler` whenever watched folders change on disk. Returns a function
  // that stops it.
  onFsChanged(handler: (changes: Changes) => void): Promise<() => void>;
  // The address the sandboxed frame loads for a path served by the app, such as
  // `reference/film`.
  artifactUrl(path: string): string;
  // Says what the name at a place of a file is and where it is defined.
  // `declaration` asks for prototypes before bodies. Returns null when there
  // is no name at that place.
  navLookup(
    relPath: string,
    line: number,
    column: number,
    declaration?: boolean,
  ): Promise<NavLookup | null>;
  // Searches for the uses of the name at a place of a file. `onEvent` is
  // called as they are found. The promise resolves when the search has ended.
  // Starting another search, or calling `navCancel`, ends a running one early.
  navReferences(
    relPath: string,
    line: number,
    column: number,
    onEvent: (event: NavRefsEvent) => void,
  ): Promise<void>;
  navCancel(): Promise<void>;
  // Lists definitions whose name contains `query`, best first.
  navSymbols(query: string, limit?: number): Promise<SymbolHit[]>;
  // Asks the core to look for files that changed since navigation last read
  // them.
  navRefresh(): Promise<void>;
  // The kept answer to which kind of artifact suits a file, or null when the
  // agent was never asked about the file as it is now.
  suggestCached(relPath: string): Promise<ViewSuggestion | null>;
  // Asks the agent which kind of artifact suits a file. The promise resolves
  // when the agent has answered, which takes a few seconds or more.
  suggestViews(relPath: string): Promise<ViewSuggestion>;
  // Asks the latest release on GitHub whether it is newer than this app.
  // Returns that version, or null if this app is the newest.
  updateCheck(): Promise<UpdateInfo | null>;
  // Downloads the version `updateCheck` found, checks its signature and
  // installs it. `onProgress` is called with the share of the download that
  // has arrived, from 0 to 100. The new version runs after `relaunch`.
  updateInstall(onProgress: (percent: number) => void): Promise<void>;
  // Restarts the app.
  relaunch(): Promise<void>;
  // Opens the page of the latest release in the user's browser.
  openReleases(): Promise<void>;
}
