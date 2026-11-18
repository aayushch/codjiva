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
export type Layout = {
  sidebarOpen: boolean;
  sidebarWidth: number;
  inspectorOpen: boolean;
  inspectorWidth: number;
  dockHeight: number | null;
  libraryOpen: boolean;
  libraryHeight: number | null;
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
  // What the user should know about how far this agent can be confined. Empty
  // for an agent that its own permission rules confine to the folder it writes
  // into.
  limits?: string;
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
  kind: 'visualise' | 'animate' | 'compose' | 'feedback';
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

// An area of the window, in CSS pixels from the top-left of the page.
export type Rect = { x: number; y: number; width: number; height: number };

export type Violation = {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  tracked: boolean;
};
export type RevertResult = { path: string; reverted: boolean; note: string };

// One element named by a self-test issue: where it is and what it says.
export type IssueElement = {
  selector: string;
  text: string;
  box: [number, number, number, number];
};
export type Issue = {
  check: string;
  severity: 'error' | 'warning';
  scene?: string;
  t?: number;
  message?: string;
  hint?: string;
  a?: IssueElement;
  b?: IssueElement;
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

export type ArtifactKind = 'visual' | 'film' | 'pipeline';

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

export type CodeRef = { path: string; line: number };
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
export type VisualNode = {
  id: string;
  label: string;
  role: string;
  refs?: CodeRef[];
  rationale?: Rationale;
  select: string[];
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
