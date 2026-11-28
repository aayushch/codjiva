// The interface's state: what is open, what is selected and which panels are
// showing. One instance, `app`, is shared by every component.

import {
  api,
  type AgentInfo,
  type ApiProvider,
  type AppError,
  type AppInfo,
  type ArtifactDetail,
  type ArtifactSummary,
  type Bookmark,
  type Changes,
  type GitEntry,
  type Feedback,
  type FileInfo,
  type FileKind,
  type FolderInfo,
  type Join,
  type JobRequest,
  type Layout,
  type NavLookup,
  type NavReference,
  type NavSpan,
  type Outline,
  type PickedElement,
  type RecentWorkspace,
  type Scope,
  type Settings,
  type TreeEntry,
  type ViewName,
  type ViewSuggestion,
  type ValidateRequest,
  type WorkspaceInfo,
} from '$lib/ipc';
import { FILE_KINDS, isView, PIPELINE_PREFIX, showsFilm } from '$lib/artifacts';
import { toggled } from '$lib/bookmarks';
import { isPicture, previewKindOf, type PreviewKind } from '$lib/preview';
import { gitMarks, NO_MARKS } from '$lib/gitStatus';
import { diffs } from './diffs.svelte';
import {
  newJob,
  reduceJob,
  targetOf,
  targetOfArtifact,
  type JobView,
} from '$lib/jobs';
import {
  absolutePath,
  tabsOfSession,
  withOpened,
  withoutClosed,
  type OpenFile,
} from '$lib/tabs';
import { ancestorsOf, flattenTree, parentOf } from '$lib/tree';

// What the editor area can show for a file or a folder: its visual, its
// film, its step-through, one of the four views, or its source.
export type ViewTab = 'visual' | 'film' | 'steps' | ViewName | 'source';
export type Dialog =
  | null
  | 'quickopen'
  | 'settings'
  | 'gitignore'
  | 'instructions'
  | 'animate'
  | 'outline'
  | 'compose';
export type Toast = { id: number; kind: 'info' | 'error'; text: string };

// One line of a context menu: a command with its label, or a dividing line
// between two groups of commands. A disabled command is shown greyed out and
// does nothing. `detail` is a sentence that explains the command. The menu
// shows it beside the command while the pointer is on the command. `mark` is
// a short word shown at the right end of the label, such as "made".
export type MenuItem =
  | {
      label: string;
      action: () => void;
      disabled?: boolean;
      detail?: string;
      mark?: string;
    }
  | 'separator';
// The menu on screen: its commands, and the point of the window, in pixels
// from the top-left corner, where its top-left corner belongs. For a context
// menu that is the point where the user right-clicked. For the menu of a
// button it is the point under the button's left end.
export type Menu = { x: number; y: number; items: MenuItem[] };

// Limits for the panels the user can resize, in pixels.
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const INSPECTOR_WIDTH = 320;
export const INSPECTOR_MIN = 240;
export const INSPECTOR_MAX = 560;
// The width the panel beside the source view starts with. That panel can hold
// a visual, so it has no greatest width of its own: App.svelte lets it grow
// until EDITOR_MIN pixels are left for the code.
export const SOURCE_PANEL_WIDTH = 380;
// The least and the greatest share of the height of that panel that its upper
// section can have, in percent.
export const SOURCE_SPLIT_MIN = 15;
export const SOURCE_SPLIT_MAX = 85;
// The list `bookmarksOf` returns for a file that has no bookmark.
const NO_BOOKMARKS: Bookmark[] = [];
// The size of the code in the source view, in pixels: the size the app
// starts with, and the least and the greatest size Settings offers.
export const CODE_FONT_DEFAULT = 13;
export const CODE_FONT_MIN = 10;
export const CODE_FONT_MAX = 24;
// The size to draw code at for the value of the setting `codeFontSize`. A
// missing value gives the default size. A value outside the range from
// CODE_FONT_MIN to CODE_FONT_MAX gives the nearest end of the range.
export const codeFontSize = (setting: number | undefined) =>
  Math.min(
    CODE_FONT_MAX,
    Math.max(CODE_FONT_MIN, Math.round(setting ?? CODE_FONT_DEFAULT)),
  );
// The least height of the library while its list is showing, and the height
// that is always left for the file tree above it.
export const LIBRARY_MIN = 96;
export const TREE_MIN = 160;
export const DOCK_HEIGHT = 244;
// A film job lists more steps than the other kinds, so its panel is taller.
export const DOCK_HEIGHT_FILM = 272;
// The least height the user can drag the job panel to, and the height that is
// always left for the editor area above it.
export const DOCK_MIN = 120;
export const EDITOR_MIN = 160;

// What the instructions dialog is asking about: which kind of job, which
// file, and the text to start from.
export type InstructionsAsk = {
  kind: 'visualise' | 'stepthrough' | 'view';
  // For a view job: which view.
  view?: ViewName;
  subject: string;
  initial: string;
  regenerate: boolean;
  // The part of the file the job is about, for a visual of a selection, and
  // the id of the discussion the job was started from.
  scope?: Scope;
  thread?: string;
};

// What the Animate dialog starts from: the file, and for a regeneration the
// instructions and companions of the film on screen.
export type AnimateAsk = {
  subject: string;
  initial: string;
  companions: string[];
  regenerate: boolean;
  // The part of the file the film is about, for a film of a selection, and
  // the id of the discussion the job was started from.
  scope?: Scope;
  thread?: string;
};

// Where the film on screen is: the time in real seconds, the chapter's index
// and title, and the same moment as the id and animation time of the scene.
export type FilmMoment = {
  t: number;
  chapter: number;
  chapterTitle: string;
  scene: string;
  sceneT: number;
};

// One place the user has been, for the Back and Forward buttons: what was
// selected and the tab. For the source view it also holds `line`, the line
// that was marked there, and `top`, the first line that was in view when the
// user left, so that Back shows the file scrolled as it was. For a film it
// holds how far the film had played when the user left.
export type Place = {
  selected: string;
  tab: ViewTab;
  line: number | null;
  top: number | null;
  filmTime: number | null;
};

// The name the user selected in the source view, with what navigation knows
// about it.
//   - `path` is the file the name was selected in.
//   - `lookup` is what the name is and where it is defined.
//   - `references` are its uses as far as the search has found them.
//   - `search` says how far that search is: not started, running or ended.
//   - `outcome` is the search's last report, once it has ended.
export type NavSymbol = {
  path: string;
  lookup: NavLookup;
  references: NavReference[];
  search: 'idle' | 'running' | 'done';
  outcome: {
    total: number;
    files: number;
    exact: boolean;
    truncated: boolean;
  } | null;
};
// How many places are remembered. The oldest are dropped first.
const PLACES_KEPT = 100;

// The length of a film in real seconds for each choice in Settings.
export const FILM_SECONDS = { short: 60, standard: 180, deep: 300 } as const;

// The view that shows an artifact of the given kind. A pipeline is shown on
// the Blueprint tab.
const tabOf = (kind: ArtifactSummary['kind'] | undefined): ViewTab =>
  kind === 'film'
    ? 'film'
    : kind === 'stepthrough'
      ? 'steps'
      : isView(kind)
        ? kind
        : 'visual';

const messageOf = (error: unknown): string => {
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as AppError).message);
  return String(error);
};

class AppState {
  info = $state<AppInfo | null>(null);
  workspace = $state<WorkspaceInfo | null>(null);
  recents = $state<RecentWorkspace[]>([]);
  settings = $state<Settings | null>(null);
  // The theme the window is drawn in. It follows the `theme` setting;
  // App.svelte sets it.
  theme = $state<'light' | 'dark'>(
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );

  // The entries of every folder loaded so far, by folder path. "" is the
  // workspace root.
  children = $state<Record<string, TreeEntry[]>>({});
  expanded = $state<Record<string, boolean>>({});
  rows = $derived(flattenTree(this.children, this.expanded));

  // The selected file's path, and what is known about it once it has been read.
  // A folder can be selected too, to make a visual of the whole folder. Its
  // path ends with a slash, and what is known about it is in `folderInfo`
  // instead.
  selected = $state<string | null>(null);
  fileInfo = $state<FileInfo | null>(null);
  folderInfo = $state<FolderInfo | null>(null);
  selectedIsFolder = $derived(!!this.selected?.endsWith('/'));
  tab = $state<ViewTab>('visual');
  // The line the source viewer scrolls to and highlights, when a code reference
  // was followed.
  sourceLine = $state<number | null>(null);
  // The characters of `sourceLine` that the source viewer marks, when what was
  // followed leads to a name and not only to a line.
  sourceSpan = $state<NavSpan | null>(null);
  // How many times the source viewer has been asked to show `sourceLine`. The
  // viewer scrolls to the line whenever this number changes, so that going to
  // the same line twice scrolls there twice.
  sourceReveal = $state(0);
  // The first line in view in the source viewer, which the viewer keeps up to
  // date. It is not shown anywhere, so it is a plain number.
  sourceTop = 1;
  // How many times the file in the source viewer has changed on disk while
  // it was selected. The viewer reads the file again when this changes.
  sourceRefresh = $state(0);
  // The first line the source viewer shows when its file is ready. Back and
  // Forward set it so that a file is scrolled as the user left it. With null
  // the viewer goes to `sourceLine`, or to the top of the file.
  resumeSourceAt = $state<number | null>(null);

  // The name selected in the source view, or null. `selectSymbol` sets it.
  symbol = $state<NavSymbol | null>(null);
  // Counts the lookups that were started, so that a slow answer to an old
  // click cannot replace the answer to a newer one.
  private lookups = 0;
  // The time, in milliseconds, of the last request to look for changed files
  // because the window came to the front.
  private lastNavRefresh = 0;
  // The text the quick-open dialog starts with. "#" makes it search for
  // definitions by name.
  quickOpenStart = $state('');

  // The file tabs above the toolbar, from left to right. Every file, folder
  // and pipeline the user selects gets a tab, and keeps it until the user
  // closes it. The tab of what is on screen is the one whose `path` equals
  // `selected`.
  openFiles = $state<OpenFile[]>([]);

  // The context menu on screen, or null. `openMenu` shows one and `closeMenu`
  // removes it.
  menu = $state<Menu | null>(null);

  dialog = $state<Dialog>(null);
  // What to do after the user has answered the .gitignore question.
  private afterGitignore: (() => void) | null = null;
  toasts = $state<Toast[]>([]);
  private nextToast = 1;

  // The agents found on this machine. `agentsLoaded` turns true after the first
  // look.
  agents = $state<AgentInfo[]>([]);
  agentsLoaded = $state(false);
  // The agent that will run the next job: the one chosen in Settings when it is
  // usable, otherwise the first usable one.
  activeAgent = $derived(
    this.agents.find((a) => a.ok && a.id === this.settings?.agent) ??
      this.agents.find((a) => a.ok) ??
      null,
  );

  // The API providers and what each still needs. Settings loads the list when
  // it opens.
  apiProviders = $state<ApiProvider[]>([]);

  // Every artifact of the open workspace.
  artifacts = $state<ArtifactSummary[]>([]);
  // The visual and the film of the selected file, where they have been made.
  // An artifact with a `scope` is about a part of a file and is none of
  // these. It is shown in the panel beside the source view (see `scope`).
  visualArtifact = $derived(
    this.selected
      ? (this.artifacts.find(
          (a) =>
            a.kind === 'visual' && a.subject[0] === this.selected && !a.scope,
        ) ?? null)
      : null,
  );
  filmArtifact = $derived(
    this.selected
      ? (this.artifacts.find(
          (a) =>
            a.kind === 'film' && a.subject[0] === this.selected && !a.scope,
        ) ?? null)
      : null,
  );
  stepsArtifact = $derived(
    this.selected
      ? (this.artifacts.find(
          (a) =>
            a.kind === 'stepthrough' &&
            a.subject[0] === this.selected &&
            !a.scope,
        ) ?? null)
      : null,
  );
  // The view of the given name that was made of the selected file or folder,
  // or null.
  viewArtifact(view: ViewName): ArtifactSummary | null {
    return (
      this.artifacts.find(
        (a) => a.kind === view && a.subject[0] === this.selected && !a.scope,
      ) ?? null
    );
  }
  // The artifact of the given kind that was made of the selected file, or
  // null.
  artifactOfKind(kind: FileKind): ArtifactSummary | null {
    return (
      this.artifacts.find(
        (a) => a.kind === kind && a.subject[0] === this.selected && !a.scope,
      ) ?? null
    );
  }

  // The last answer an agent gave to which kind of artifact suits a file.
  // It can be about a file other than the selected one, for example after
  // the user selected another file while the agent was still answering.
  private lastSuggestion = $state<ViewSuggestion | null>(null);
  // The agent's answer for the selected file, or null when there is none.
  suggestion = $derived(
    this.lastSuggestion?.path === this.selected ? this.lastSuggestion : null,
  );
  // The path of the file the agent is being asked about, or null while no
  // question is running.
  private suggestingFor = $state<string | null>(null);
  // True while the agent is being asked about the selected file.
  suggesting = $derived(
    this.suggestingFor !== null && this.suggestingFor === this.selected,
  );
  // The kind the agent ranked first for the selected file, or null.
  suggestedKind = $derived(this.suggestion?.ranked[0]?.kind ?? null);

  // Reads the kept answer for the file at `relPath`, if the agent was asked
  // about the file as it is now. A file that changed since has no answer.
  private async loadSuggestion(relPath: string) {
    try {
      const kept = await api.suggestCached(relPath);
      if (this.selected !== relPath) return;
      this.lastSuggestion = kept;
    } catch {
      // A suggestion is a convenience. A file without one is shown as usual.
    }
  }

  // Asks the agent which kind of artifact suits the selected file. Only one
  // question runs at a time.
  //
  // The answer is shown where the selected file's views are listed. With
  // `announce`, a message also names the first kind and its reason, for when
  // the question was asked from a menu and that list is not on screen.
  async askSuggestion(announce = false) {
    const path = this.selected;
    if (!path || this.selectedIsFolder || this.selectedPipelineId) return;
    if (this.suggestingFor) return;
    this.suggestingFor = path;
    try {
      const made = await api.suggestViews(path);
      this.lastSuggestion = made;
      const first = made.ranked[0];
      const kind = FILE_KINDS.find((one) => one.kind === first?.kind);
      if (announce && kind)
        this.notify(
          `Suggested for ${path.split('/').pop()}: ${kind.label}. ${first.reason}`,
        );
    } catch (error) {
      this.fail(error);
    } finally {
      this.suggestingFor = null;
    }
  }

  // The id of the selected pipeline. A pipeline is selected in place of a file,
  // and then `selected` holds its id after a prefix.
  selectedPipelineId = $derived(
    this.selected?.startsWith(PIPELINE_PREFIX)
      ? this.selected.slice(PIPELINE_PREFIX.length)
      : null,
  );
  // The part of the selected file that is open in the panel beside the
  // source view, or null. The panel shows the discussion about that part and
  // the visuals that were made of it. `openScope` sets it.
  scope = $state<Scope | null>(null);
  // The id of the visual of `scope` that the panel shows, or null while it
  // shows none.
  scopeArtifactId = $state<string | null>(null);
  // How many times the panel was asked to put the keyboard focus in its
  // question box. The box takes the focus whenever this number changes.
  scopeFocus = $state(0);
  // The id of a visual of a part of a file that fills the editor area in
  // place of the source view, or null. The panel beside the source view has
  // a button that sets it, for a visual that is too large for the panel.
  // While it is set, the visual is shown as the visual of a file is: with
  // the inspector on its right and its controls in the toolbar.
  spotlight = $state<string | null>(null);
  // The artifact on screen: the visual in `spotlight`, the selected pipeline,
  // or for a file its film on the Film tab, its step-through on the
  // Step-through tab and its visual otherwise.
  currentArtifact = $derived(
    this.spotlight
      ? (this.artifacts.find((a) => a.id === this.spotlight) ?? null)
      : this.selectedPipelineId
        ? (this.artifacts.find((a) => a.id === this.selectedPipelineId) ?? null)
        : this.tab === 'film'
          ? this.filmArtifact
          : this.tab === 'steps'
            ? this.stepsArtifact
            : isView(this.tab)
              ? this.viewArtifact(this.tab)
              : this.visualArtifact,
  );
  // The artifacts ticked in the library for a pipeline, in the order they were
  // ticked.
  composeSelection = $state<string[]>([]);
  // The artifacts the compose dialog is open for.
  composeAsk = $state<string[] | null>(null);
  // Every join the app can propose between two artifacts of the workspace. The
  // inspector uses it to say what an artifact connects to.
  connections = $state<Join[]>([]);
  // The version of `currentArtifact` on screen, when it is not the current one.
  pickedVersion = $state<number | null>(null);
  shownVersion = $derived(
    this.currentArtifact
      ? (this.pickedVersion ?? this.currentArtifact.currentVersion)
      : null,
  );
  // The details of the version on screen: its manifest, its nodes, the analysis
  // behind it.
  detail = $state<ArtifactDetail | null>(null);
  // The node of the visual the user clicked, and which layers are switched on.
  selectedNode = $state<string | null>(null);
  // For a step-through: the node of the state that the step on screen is in.
  // The inspector describes it while the user has clicked no node.
  stepNode = $state<string | null>(null);
  layers = $state<Record<string, boolean>>({});
  legendOn = $state(false);
  // True while the visual on screen shows the "?" markers of the parts that
  // have a rationale.
  rationaleOn = $state(false);
  // Sends a message to the artifact on screen. The frame that shows it sets
  // this.
  frameSend: ((message: Record<string, unknown>) => void) | null = null;
  // Returns where the artifact's frame is in the window, for a picture of it.
  // The frame that shows the artifact sets this.
  frameRect: (() => DOMRect | null) | null = null;
  // Where the film on screen is. The film player keeps this up to date.
  filmMoment = $state<FilmMoment | null>(null);
  // A moment of the film the user pinned for their feedback, in real seconds.
  pinnedTime = $state<number | null>(null);
  // True while the artifact waits for the user to click the element their
  // feedback is about, and the element they clicked.
  picking = $state(false);
  picked = $state<PickedElement | null>(null);

  // Every job that was started since this folder was opened and that the user
  // has not removed from the job panel, oldest first. Any number of them can
  // be running at the same time.
  jobs = $state<JobView[]>([]);
  // The `key` of the job that the job panel shows. Null while `jobs` is empty.
  shownJobKey = $state<number | null>(null);
  // The job that the job panel shows.
  job = $derived(this.jobs.find((job) => job.key === this.shownJobKey) ?? null);
  // How many jobs are running now.
  runningJobs = $derived(
    this.jobs.filter((job) => job.status === 'running').length,
  );
  // The `key` the next job gets.
  private nextJobKey = 1;
  // Whether the job panel is open.
  dockOpen = $state(false);
  // The height the user dragged the job panel to. Null until they drag it; the
  // panel then has the height that suits the kind of job.
  dockHeight = $state<number | null>(null);
  instructionsAsk = $state<InstructionsAsk | null>(null);
  animateAsk = $state<AnimateAsk | null>(null);
  // Versions the window has been asked to self-test for running jobs, oldest
  // first.
  validateQueue = $state<ValidateRequest[]>([]);

  // The places the user has been in this workspace, oldest first, and which of
  // them is on screen. Back and Forward move `placeIndex` through `places`.
  // Going somewhere new from the middle of the list drops the places after
  // `placeIndex`.
  places = $state<Place[]>([]);
  placeIndex = $state(-1);
  // While nothing is selected, because the user closed the last file tab,
  // Back shows the place at `placeIndex` again. That place is the last one
  // the user saw.
  canGoBack = $derived(
    this.placeIndex > 0 || (!this.selected && this.placeIndex >= 0),
  );
  canGoForward = $derived(this.placeIndex < this.places.length - 1);
  // The time, in real seconds, the film player seeks to when its film is ready.
  // Back and Forward set it so that a film continues where the user left it.
  resumeFilmAt = $state<number | null>(null);
  // The time each film on screen has reached, by the address of its page. A
  // film that is shown again, for example after a look at the Source tab,
  // continues from this time. A new version of a film has a new address and
  // starts at the beginning.
  filmTimes = new Map<string, number>();
  // How many changes of place are under way. A change can be made of others:
  // opening an artifact selects its file and then switches the tab. The place
  // is recorded once, when the outermost change has finished.
  private moves = 0;

  sidebarWidth = $state(280);
  // Whether the user has the sidebar and the inspector showing. Each can be
  // closed with its button in the title bar or by dragging its edge to the side
  // of the window.
  sidebarOpen = $state(true);
  inspectorOpen = $state(true);
  inspectorWidth = $state(INSPECTOR_WIDTH);
  // Which of the inspector's two tabs is showing beside a visual: what the
  // visual and its parts are, or the discussion about it.
  inspectorTab = $state<'about' | 'ask'>('about');
  // The panel beside the source view: its width, the share of its height
  // that its upper section has, in percent, and whether the discussion is
  // the upper section in place of the references.
  sourcePanelWidth = $state(SOURCE_PANEL_WIDTH);
  sourceSplit = $state(40);
  sourceSwapped = $state(false);
  // An artifact of the selected file is on screen: the open tab is Blueprint
  // or Film, the file has an artifact of that kind, and its details are loaded.
  // The inspector describes that artifact, so it can only show while this is
  // true.
  artifactShown = $derived(
    !!this.currentArtifact &&
      !!this.detail &&
      (this.tab !== 'source' || !!this.spotlight) &&
      this.shownVersion != null &&
      this.detail.manifest.artifactId === this.currentArtifact.id,
  );
  // The source view of a file is on screen. The panel on the right then holds
  // `SymbolPanel` in place of the inspector. `SymbolPanel` lists where the
  // selected name (`symbol`) is defined and used, and says how to select a
  // name while none is selected.
  sourceShown = $derived(
    !this.spotlight &&
      this.tab === 'source' &&
      !!this.selected &&
      !this.selectedIsFolder &&
      !this.selectedPipelineId,
  );
  // The library at the bottom of the sidebar: whether its list is showing, and
  // its height in pixels once the user has dragged its top edge. Until then the
  // library is as tall as its list, up to a share of the sidebar.
  libraryOpen = $state(true);
  libraryHeight = $state<number | null>(null);
  // The height, in pixels, the user dragged the strip of panels under a
  // step-through to. It is null until they drag it. VisualFrame sends it to
  // every step-through it opens, so all step-throughs have the same height.
  stepPanelHeight = $state<number | null>(null);
  // True while a film or visual fills the window and the panels around it are
  // hidden.
  theater = $state(false);

  private stopWatching: (() => void) | null = null;
  private stopValidating: (() => void) | null = null;

  // True from the start of the app until `init` has opened the folder that
  // was open when the app last stopped, or has found that there is none.
  // The welcome screen is not shown during that time, so that it does not
  // appear for a moment before the folder does.
  starting = $state(true);

  async init() {
    try {
      this.info = await api.appInfo();
      this.settings = await api.settingsGet();
      this.applyLayout(this.settings.layout);
      this.recents = await api.workspaceRecent();
      this.stopWatching = await api.onFsChanged((changes) =>
        this.onFsChanged(changes),
      );
      this.stopValidating = await api.onValidateRequest((request) => {
        this.validateQueue.push(request);
      });
      await api.onMenuOpenFolder(() => this.pickAndOpen());
      // The folder that was open when the app last stopped is opened again,
      // with the tabs it had then (see `restoreSession`).
      const last = await api.workspaceLast();
      if (last) await this.openWorkspace(last);
    } catch (error) {
      this.fail(error);
    }
    this.starting = false;
    // Looking for agents starts programs and can take a few seconds, so the
    // window does not wait for it.
    this.loadAgents();
  }

  async loadAgents(refresh = false) {
    try {
      this.agents = await api.agentsDetect(refresh);
    } catch (error) {
      this.fail(error);
    }
    this.agentsLoaded = true;
  }

  async reloadArtifacts() {
    if (!this.workspace) return;
    try {
      this.artifacts = await api.artifactList();
      // A ticked artifact that no longer exists cannot be composed.
      this.composeSelection = this.composeSelection.filter((id) =>
        this.artifacts.some((a) => a.id === id),
      );
      // The file tab of a pipeline that no longer exists is removed, unless
      // that pipeline is on screen.
      this.openFiles = this.openFiles.filter(
        (file) =>
          !file.path.startsWith(PIPELINE_PREFIX) ||
          file.path === this.selected ||
          this.artifacts.some(
            (a) => a.id === file.path.slice(PIPELINE_PREFIX.length),
          ),
      );
      // A visual of a part of a file is shown beside its code and is not
      // composed, so it is left out of the joins.
      const withPorts = this.artifacts
        .filter((a) => a.kind !== 'pipeline' && a.ports.length > 0 && !a.scope)
        .map((a) => a.id);
      // The visual in the panel beside the source view, or in the editor
      // area in its place, may have been deleted.
      const there = (id: string | null) =>
        this.artifacts.some((a) => a.id === id);
      if (this.scopeArtifactId && !there(this.scopeArtifactId))
        this.scopeArtifactId = null;
      if (this.spotlight && !there(this.spotlight)) this.spotlight = null;
      this.connections =
        withPorts.length >= 2
          ? (await api.composePropose(withPorts)).joins
          : [];
    } catch (error) {
      this.fail(error);
    }
  }

  // Switches the tab. Going from the visual to the film, or back, shows the
  // other artifact, so its details are loaded.
  async setTab(tab: ViewTab) {
    await this.move(async () => {
      const before = this.currentArtifact?.id;
      this.tab = tab;
      if (this.currentArtifact?.id !== before) {
        this.pickedVersion = null;
        await this.loadDetail();
      }
    });
  }

  // Runs a change of what is on screen, and records the place it leads to for
  // the Back and Forward buttons. Every method that selects something or
  // switches the tab goes through here.
  private async move(change: () => Promise<void>) {
    if (this.moves === 0) {
      this.leavePlace();
      this.cameFrom = this.selected;
      // Going anywhere else ends the showing of a visual of a part of a file
      // in the editor area.
      this.spotlight = null;
    }
    this.moves++;
    try {
      await change();
    } finally {
      this.moves--;
      if (this.moves === 0) {
        this.recordPlace();
        this.noteOpenFile();
        this.saveSession();
      }
    }
  }

  // Keeps the file tabs of the open workspace, and which of them is on
  // screen, for the next time the same folder is opened (see
  // `restoreSession`). It is called after every change to the tabs.
  //
  // The tabs are a convenience, so a failure to keep them is not reported to
  // the user.
  private saveSession() {
    if (!this.workspace) return;
    api
      .workspaceSessionSet({
        openFiles: $state.snapshot(this.openFiles),
        selected: this.selected,
        bookmarks: $state.snapshot(this.bookmarks),
      })
      .catch(() => {});
  }

  // The files the user asked to see rendered, by their path inside the
  // workspace. The Source view of such a file shows the picture or the page
  // the file describes in place of its text (see lib/preview.ts). It is not
  // kept between runs of the app.
  previews = $state<Record<string, boolean>>({});

  // What the Source view of the selected file shows in place of its text, or
  // null when it shows the text or another view is on screen.
  //   - An image file that is not text is always shown as its picture.
  //   - A file in `previews` is shown in the way `previewKindOf` says.
  rendered = $derived.by((): PreviewKind | null => {
    const path = this.selected;
    if (this.tab !== 'source' || !path || this.selectedPipelineId) return null;
    if (path.endsWith('/') || this.spotlight) return null;
    if (isPicture(path)) return 'image';
    return this.previews[path] ? previewKindOf(path) : null;
  });

  // Shows the file at `path` rendered, in the Source view.
  async openPreview(path: string) {
    this.previews[path] = true;
    delete this.diffs[path];
    await this.selectFile(path);
    if (this.tab !== 'source') await this.setTab('source');
  }

  // Switches the selected file between its text and its rendered form.
  togglePreview() {
    const path = this.selected;
    if (!path) return;
    if (this.previews[path]) delete this.previews[path];
    else {
      this.previews[path] = true;
      delete this.diffs[path];
    }
  }

  // The files whose Source view shows their changes in place of their text
  // (see DiffView.svelte), by their path inside the workspace. A file is in
  // at most one of `diffs` and `previews`. It is not kept between runs of
  // the app.
  diffs = $state<Record<string, boolean>>({});

  // True while the Source view of the selected file shows its changes.
  // An image file has no text to compare, and a folder that is not inside
  // a git repository has no changes to show.
  diffing = $derived.by((): boolean => {
    const path = this.selected;
    if (this.tab !== 'source' || !path || this.selectedPipelineId) return false;
    if (path.endsWith('/') || this.spotlight || isPicture(path)) return false;
    return this.gitRepo && !!this.diffs[path];
  });

  // How the diff view is laid out, kept with the layout of the panels (see
  // `saveLayout`). With `diffSplit`, the old version is on the left and the
  // new version on the right. With `diffWholeFile`, every line is shown and
  // nothing is folded away.
  diffSplit = $state(false);
  diffWholeFile = $state(false);

  // Shows the changes of the file at `path`, in the Source view. `commit`
  // is the hash of the commit to start on. Without it, the view starts on
  // the change that was last on screen for the file, or on the newest one.
  async openDiff(path: string, commit?: string) {
    this.diffs[path] = true;
    delete this.previews[path];
    if (commit) diffs.want(path, commit);
    await this.selectFile(path);
    if (this.tab !== 'source') await this.setTab('source');
  }

  // Switches the selected file between its text and its changes.
  toggleDiff() {
    const path = this.selected;
    if (!path) return;
    if (this.diffs[path]) delete this.diffs[path];
    else {
      this.diffs[path] = true;
      delete this.previews[path];
    }
  }

  // The bookmarks of the open workspace: for each file that has any, by its
  // path inside the workspace, the lines the user bookmarked in the source
  // view, ordered by line (see lib/bookmarks.ts). They are kept with the
  // file tabs on this computer, and are not written into the workspace.
  bookmarks = $state<Record<string, Bookmark[]>>({});

  // The bookmarks of the file at `path`. A file without bookmarks gives the
  // same empty list every time.
  bookmarksOf(path: string): Bookmark[] {
    return this.bookmarks[path] ?? NO_BOOKMARKS;
  }

  // Makes `list` the bookmarks of the file at `path` and keeps them for the
  // next time the folder is opened. An empty list removes the file's entry.
  setBookmarks(path: string, list: Bookmark[]) {
    if (list.length) this.bookmarks[path] = list;
    else delete this.bookmarks[path];
    this.saveSession();
  }

  // Adds a bookmark on `line` of the file at `path`, or removes the one that
  // is there. `text` is the code of that line.
  toggleBookmark(path: string, line: number, text: string) {
    const before = this.bookmarksOf(path);
    const after = toggled(before, line, text);
    this.setBookmarks(path, after);
    if (after.length < before.length) this.unmarkLine(path, [line]);
  }

  // Removes every bookmark of the file at `path`.
  clearBookmarks(path: string) {
    const lines = this.bookmarksOf(path).map((mark) => mark.line);
    this.setBookmarks(path, []);
    this.unmarkLine(path, lines);
  }

  // Going to a bookmark highlights its line in the source view, as every
  // jump to a line does (`sourceLine`). When the bookmark is removed, that
  // highlight is removed with it. `lines` are the lines of the file at
  // `path` whose bookmarks were removed. The highlight stays when it is on
  // another line or the file is not the one on screen.
  private unmarkLine(path: string, lines: number[]) {
    if (path !== this.selected || this.sourceLine == null) return;
    if (!lines.includes(this.sourceLine)) return;
    this.sourceLine = null;
    this.sourceSpan = null;
  }

  // Shows the file tabs the workspace had when it was last used, and in them
  // the tab that was on screen then. `openWorkspace` calls it once the folder
  // and its artifacts are loaded.
  //
  // A tab is left out when its file, folder or pipeline is no longer there.
  // If the tab that was on screen is one of those, the first of the remaining
  // tabs is shown. With no remaining tab, nothing is selected, as in a folder
  // that is opened for the first time.
  private async restoreSession() {
    let remembered: OpenFile[];
    let selected: string | null;
    try {
      const session = await api.workspaceSessionGet();
      remembered = tabsOfSession(session.openFiles);
      selected = session.selected;
      this.bookmarks = session.bookmarks ?? {};
    } catch {
      return;
    }
    const files: OpenFile[] = [];
    for (const file of remembered)
      if (await this.tabExists(file.path)) files.push(file);
    if (!files.length) return;
    this.openFiles = files;
    const shown = files.find((file) => file.path === selected) ?? files[0];
    await this.showOpenFile(shown.path);
  }

  // Whether what a file tab stands for is still there: the file, the folder,
  // or the pipeline.
  private async tabExists(path: string) {
    if (!path.endsWith('/')) return this.fileOrPipelineExists(path);
    try {
      await api.treeChildren(path.slice(0, -1));
      return true;
    } catch {
      return false;
    }
  }

  // What was selected when the change of place that is under way began. A
  // new file tab is put directly after the tab of this path.
  private cameFrom: string | null = null;

  // Brings the file tabs in line with what is on screen. It is called at the
  // end of every change of place.
  //   - If the selected file, folder or pipeline has no tab yet, it gets one.
  //   - If it has a tab, the tab takes over the view that is showing now:
  //     Blueprint, Film or Source, and the line of the source view.
  private noteOpenFile() {
    if (!this.selected) return;
    this.openFiles = withOpened(
      this.openFiles,
      {
        path: this.selected,
        view: this.tab,
        line: this.tab === 'source' ? this.sourceLine : null,
      },
      this.cameFrom,
    );
  }

  // Shows what the file tab with the given path stands for, in the view the
  // tab was last looked at in. Does nothing for a path that has no tab, and
  // for the tab that is already on screen.
  async showOpenFile(path: string) {
    const file = this.openFiles.find((one) => one.path === path);
    if (!file || path === this.selected) return;
    await this.move(async () => {
      if (path.startsWith(PIPELINE_PREFIX))
        await this.selectPipeline(path.slice(PIPELINE_PREFIX.length));
      else if (path.endsWith('/')) {
        await this.selectFolder(path);
        if (file.view === 'map') await this.setTab('map');
      } else {
        await this.selectFileAgain(
          path,
          file.view === 'source' && file.line != null ? file.line : undefined,
        );
        if (this.tab !== file.view) await this.setTab(file.view);
      }
    });
  }

  // Closes the file tab with the given path.
  //
  // Closing a tab that is not on screen only removes it from the row. Closing
  // the tab that is on screen also shows another one: the tab to its right,
  // or the tab to its left if it was the last in the row. When it was the
  // only tab, nothing is selected afterwards.
  async closeOpenFile(path: string) {
    const { files, next } = withoutClosed(this.openFiles, path);
    const wasShown = path === this.selected;
    this.openFiles = files;
    if (wasShown && next) await this.showOpenFile(next.path);
    else {
      if (wasShown) this.clearSelection();
      this.saveSession();
    }
  }

  // Closes every file tab except the one with the given path, and shows that
  // one.
  async closeOtherFiles(path: string) {
    const kept = this.openFiles.filter((file) => file.path === path);
    if (!kept.length) return;
    await this.showOpenFile(path);
    this.openFiles = this.openFiles.filter((file) => file.path === path);
    this.saveSession();
  }

  // Leaves nothing selected, so that the editor area shows its hint to select
  // a file.
  private clearSelection() {
    this.leavePlace();
    this.selected = null;
    this.fileInfo = null;
    this.folderInfo = null;
    this.detail = null;
    this.pickedVersion = null;
    this.sourceLine = null;
    this.sourceSpan = null;
    this.spotlight = null;
    this.closeScope();
    this.clearSymbol();
    this.clearFeedbackContext();
  }

  // The panel beside the source view, and the visuals of a part of a file.

  // Opens the part `scope` of the selected file in the panel beside the
  // source view, and opens that panel. The panel shows the visual of the part
  // with the id `artifactId`, or the first visual the part has when none is
  // named. With `focus`, the question box of the panel takes the keyboard
  // focus, for a user who is about to ask.
  openScope(scope: Scope, artifactId: string | null = null, focus = false) {
    const same = this.scope?.id === scope.id && this.scope.path === scope.path;
    this.scope = scope;
    this.inspectorOpen = true;
    const made = this.scopeArtifacts(scope);
    const wanted = made.find((a) => a.id === artifactId);
    const kept = same ? made.find((a) => a.id === this.scopeArtifactId) : null;
    this.scopeArtifactId = (wanted ?? kept ?? made[0])?.id ?? null;
    if (focus) this.scopeFocus++;
  }

  // Leaves no part of the file open in the panel beside the source view.
  closeScope() {
    this.scope = null;
    this.scopeArtifactId = null;
  }

  // The visuals that were made of the part `scope` of its file.
  scopeArtifacts(scope: Scope): ArtifactSummary[] {
    return this.artifacts.filter(
      (a) => a.scope?.id === scope.id && a.subject[0] === scope.path,
    );
  }

  // Shows the visual of a part of a file with the id `id` in the editor
  // area, in place of the source view. `closeSpotlight` shows the source
  // view again.
  async openSpotlight(id: string) {
    if (!this.artifacts.some((a) => a.id === id)) return;
    this.spotlight = id;
    this.pickedVersion = null;
    this.inspectorTab = 'about';
    await this.loadDetail();
  }

  async closeSpotlight() {
    if (!this.spotlight) return;
    this.spotlight = null;
    this.pickedVersion = null;
    await this.loadDetail();
  }

  // Opens the dialog that starts a visual of the part `scope` of the
  // selected file: the Animate dialog for a film, and the instructions step
  // for every other kind. If the part has a visual of that kind already, the
  // dialog starts from its instructions. `thread` is the id of the
  // discussion about the part, when there is one, so that the agent knows
  // what was said.
  async askScoped(scope: Scope, kind: FileKind, thread?: string) {
    const existing = this.scopeArtifacts(scope).find((a) => a.kind === kind);
    let initial = '';
    let companions: string[] = [];
    if (existing) {
      try {
        const made = (await api.artifactDetail(existing.id)).manifest;
        initial = made.instructions;
        companions = made.companions.map((c) => c.path);
      } catch {
        // The dialog then starts empty, as it does for a first version.
      }
    }
    const common = {
      subject: scope.path,
      initial,
      regenerate: !!existing,
      scope,
      thread,
    };
    this.withStore(() => {
      if (kind === 'film') {
        this.animateAsk = { ...common, companions };
        this.dialog = 'animate';
      } else {
        this.instructionsAsk = {
          ...common,
          kind:
            kind === 'visual'
              ? 'visualise'
              : kind === 'stepthrough'
                ? 'stepthrough'
                : 'view',
          view: isView(kind) ? kind : undefined,
        };
        this.dialog = 'instructions';
      }
    });
  }

  // Shows a context menu with the given commands at the point of the window
  // where `event` happened, in place of the menu the webview would show.
  openMenu(event: MouseEvent, items: MenuItem[]) {
    event.preventDefault();
    this.menu = { x: event.clientX, y: event.clientY, items };
  }

  // Shows a menu with the given commands under `button`, with the left edges
  // of the two in line. This is for a button that opens a menu when it is
  // clicked, so that the menu does not cover the button.
  openMenuBelow(button: HTMLElement, items: MenuItem[]) {
    const box = button.getBoundingClientRect();
    this.menu = { x: box.left, y: box.bottom + 4, items };
  }

  closeMenu() {
    this.menu = null;
  }

  // Puts the path of a file or folder of the workspace on the clipboard.
  // `relPath` is the path inside the workspace. With `absolute` the full path
  // on this computer is copied instead.
  //
  // Returns true when the path was copied. A toast then says which path it
  // was, unless `announce` is false. The copy button of the toolbar passes
  // false, because it shows a tick of its own. When the path could not be
  // copied, a toast says so in every case.
  async copyPath(
    relPath: string,
    absolute = false,
    announce = true,
  ): Promise<boolean> {
    const inside = relPath.replace(/\/$/, '');
    const text =
      absolute && this.workspace
        ? absolutePath(this.workspace.root, inside)
        : inside;
    try {
      await navigator.clipboard.writeText(text);
      if (announce) this.notify(`Copied ${text}`);
      return true;
    } catch {
      this.notify('The path could not be copied to the clipboard.', 'error');
      return false;
    }
  }

  // Selects a file or folder and opens the dialog that starts a visual of it.
  // If it has a visual already, the dialog starts from that visual's
  // instructions. The dialog is not opened when no visual can be made: for a
  // file that is not text, and for a folder that holds no code or too much of
  // it. The editor area then says why.
  async visualise(path: string) {
    await this.selectFile(path);
    if (this.selected !== path) return;
    if (this.selectedIsFolder) {
      const folder = this.folderInfo;
      if (!folder || folder.tooLarge || folder.files.length === 0) return;
    } else if (!this.fileInfo || this.fileInfo.binary) return;
    if (!this.visualArtifact) return this.askInstructions();
    await this.setTab('visual');
    this.askInstructions(true);
  }

  // Selects a file and opens the dialog that starts a step-through of it. If
  // the file has a step-through already, the dialog starts from that one's
  // instructions. The dialog is not opened for a file that is not text.
  async stepThrough(path: string) {
    await this.selectFile(path);
    if (this.selected !== path || !this.fileInfo || this.fileInfo.binary)
      return;
    await this.setTab('steps');
    this.askInstructions(!!this.stepsArtifact, 'stepthrough');
  }

  // Selects a file or a folder and opens the dialog that starts one of the
  // four views of it. A map is made of a folder, and the other views of a
  // file; for the wrong one of the two nothing happens. If the view exists
  // already, the dialog starts from its instructions. The dialog is not
  // opened for a file that is not text, or for a folder that holds no code
  // or too much of it.
  async makeView(path: string, view: ViewName) {
    if (path.endsWith('/') !== (view === 'map')) return;
    await this.selectFile(path);
    if (this.selected !== path) return;
    if (this.selectedIsFolder) {
      const folder = this.folderInfo;
      if (!folder || folder.tooLarge || folder.files.length === 0) return;
    } else if (!this.fileInfo || this.fileInfo.binary) return;
    await this.setTab(view);
    this.askInstructions(!!this.viewArtifact(view), 'view', view);
  }

  // Selects a file and opens the Animate dialog for it. If the file has a
  // film already, the dialog starts from that film's instructions and
  // companions. The dialog is not opened for a file that is not text.
  async animate(path: string) {
    await this.selectFile(path);
    if (this.selected !== path || !this.fileInfo || this.fileInfo.binary)
      return;
    if (!this.filmArtifact) return this.askAnimate();
    await this.setTab('film');
    this.askAnimate(true);
  }

  // Called before the user leaves the place on screen. If that place is a film,
  // the time it has reached is kept with the place, so that Back can continue
  // the film from there.
  // If it is the source view, the first line in view is kept with the place
  // in the same way, so that Back shows the file scrolled as the user left
  // it.
  private leavePlace() {
    const here = this.places[this.placeIndex];
    if (here && this.tab === 'film' && this.filmMoment)
      here.filmTime = this.filmMoment.t;
    if (here && this.tab === 'source' && here.selected === this.selected)
      here.top = this.sourceTop;
    this.resumeFilmAt = null;
    this.resumeSourceAt = null;
  }

  // Adds the place on screen after `placeIndex`, unless it is the place already
  // there.
  private recordPlace() {
    if (!this.selected) return;
    const place: Place = {
      selected: this.selected,
      tab: this.tab,
      line: this.tab === 'source' ? this.sourceLine : null,
      top: null,
      filmTime: null,
    };
    const here = this.places[this.placeIndex];
    if (
      here &&
      here.selected === place.selected &&
      here.tab === place.tab &&
      here.line === place.line
    )
      return;
    this.places = [...this.places.slice(0, this.placeIndex + 1), place].slice(
      -PLACES_KEPT,
    );
    this.placeIndex = this.places.length - 1;
  }

  goBack(): Promise<void> {
    return this.goToPlace(
      this.selected ? this.placeIndex - 1 : this.placeIndex,
    );
  }
  goForward(): Promise<void> {
    return this.goToPlace(this.placeIndex + 1);
  }

  // Whether the file or pipeline of a place is still there. A folder is not
  // checked.
  private async placeExists(place: Place) {
    if (place.selected.endsWith('/')) return true;
    return this.fileOrPipelineExists(place.selected);
  }

  // Whether the file at `path` is still in the workspace. For the id of a
  // pipeline after `PIPELINE_PREFIX`, whether that pipeline is still among
  // the artifacts.
  private async fileOrPipelineExists(path: string) {
    if (path.startsWith(PIPELINE_PREFIX))
      return this.artifacts.some(
        (a) => a.id === path.slice(PIPELINE_PREFIX.length),
      );
    try {
      await api.fileInfo(path);
      return true;
    } catch {
      return false;
    }
  }

  // Shows the place at `index` of `places` again: its file, folder or pipeline,
  // its tab, the line of the source view, and the moment of its film.
  private async goToPlace(index: number): Promise<void> {
    const place = this.places[index];
    if (!place) return;
    // A file or pipeline that was deleted since the user looked at it is taken
    // out of `places`. The user is told, and the next place in the same
    // direction is shown.
    if (!(await this.placeExists(place))) {
      const back = index < this.placeIndex;
      this.places = this.places.filter((_, i) => i !== index);
      if (back) this.placeIndex--;
      this.notify(
        `${place.selected.startsWith(PIPELINE_PREFIX) ? 'That pipeline' : place.selected} is no longer there.`,
      );
      return back ? this.goBack() : this.goForward();
    }
    this.leavePlace();
    this.cameFrom = this.selected;
    this.placeIndex = index;
    // `moves` is raised without `move`, so that the selections below record no
    // new place.
    this.moves++;
    try {
      if (place.tab === 'film') this.resumeFilmAt = place.filmTime;
      if (place.tab === 'source') this.resumeSourceAt = place.top;
      if (place.selected.startsWith(PIPELINE_PREFIX))
        await this.selectPipeline(place.selected.slice(PIPELINE_PREFIX.length));
      else if (place.selected.endsWith('/')) {
        await this.selectFolder(place.selected);
        // A folder opens on its visual. Its map is the other thing it has.
        if (place.tab === 'map') await this.setTab('map');
      } else {
        await this.selectFileAgain(
          place.selected,
          place.tab === 'source' && place.line != null ? place.line : undefined,
        );
        if (this.tab !== place.tab) await this.setTab(place.tab);
      }
    } finally {
      this.moves--;
      this.noteOpenFile();
    }
  }

  // Selects an artifact's file and shows the artifact: the Film tab for a film,
  // the Blueprint tab for a visual.
  //
  // A visual of a part of a file is shown beside its code: the source view
  // goes to the first line of the part, and the panel on its right opens on
  // that visual.
  async openArtifact(artifact: ArtifactSummary) {
    if (artifact.kind === 'pipeline') return this.selectPipeline(artifact.id);
    if (artifact.scope) {
      const scope = artifact.scope;
      await this.selectFile(
        scope.path,
        artifact.scopeNow?.startLine ?? scope.startLine,
      );
      if (this.selected === scope.path) this.openScope(scope, artifact.id);
      return;
    }
    await this.move(async () => {
      await this.selectFile(artifact.subject[0]);
      await this.setTab(tabOf(artifact.kind));
    });
  }

  // Shows a pipeline. It takes the place of a file in the selection, because it
  // explains several files and belongs to none of them.
  async selectPipeline(id: string) {
    await this.move(async () => {
      this.closeScope();
      this.selected = PIPELINE_PREFIX + id;
      this.tab = 'visual';
      this.sourceLine = null;
      this.pickedVersion = null;
      this.detail = null;
      this.fileInfo = null;
      this.folderInfo = null;
      await this.loadDetail();
    });
  }

  // Ticks or unticks an artifact in the library for a pipeline.
  toggleCompose(id: string) {
    this.composeSelection = this.composeSelection.includes(id)
      ? this.composeSelection.filter((one) => one !== id)
      : [...this.composeSelection, id];
  }

  // Opens the compose dialog for the given artifacts.
  askCompose(ids: string[]) {
    this.withStore(() => {
      this.composeAsk = ids;
      this.dialog = 'compose';
    });
  }

  // Forgets what was attached to a feedback that has not been sent: the pinned
  // moment and the pointed-at element.
  private clearFeedbackContext() {
    this.pinnedTime = null;
    this.picked = null;
    this.picking = false;
    this.filmMoment = null;
  }

  // Loads the details of the version on screen, or clears them when the
  // selected file has no artifact of the kind the tab shows.
  async loadDetail() {
    const artifact = this.currentArtifact;
    const version = this.shownVersion;
    this.clearFeedbackContext();
    if (!artifact || version == null) {
      this.detail = null;
      return;
    }
    try {
      const detail = await api.artifactDetail(artifact.id, version);
      // The selection may have moved on while this was loading.
      if (
        this.currentArtifact?.id !== artifact.id ||
        this.shownVersion !== version
      )
        return;
      this.detail = detail;
      this.selectedNode = null;
      this.stepNode = null;
      this.legendOn = false;
      this.rationaleOn = false;
      this.layers = Object.fromEntries(
        Object.keys(detail.definition?.layers ?? {}).map((layer) => [
          layer,
          true,
        ]),
      );
    } catch (error) {
      this.detail = null;
      this.fail(error);
    }
  }

  // The part of the file that the visual in the editor area is about, while
  // `spotlight` is set. A job that is started from the toolbar then makes a
  // visual of the same part.
  private get spotlightScope(): Scope | undefined {
    return this.spotlight ? this.currentArtifact?.scope : undefined;
  }

  // Opens the instructions step for the selected file. `regenerate` starts from
  // the instructions of the version on screen. `kind` is the job the step
  // starts: a visual, a step-through, or a view, which `view` then names.
  askInstructions(
    regenerate = false,
    kind: InstructionsAsk['kind'] = 'visualise',
    view?: ViewName,
  ) {
    if (!this.selected) return;
    const subject = this.selected;
    const initial = regenerate
      ? (this.detail?.manifest.instructions ?? '')
      : '';
    const scope = this.spotlightScope;
    this.withStore(() => {
      this.instructionsAsk = {
        kind,
        view,
        subject,
        initial,
        regenerate,
        scope,
      };
      this.dialog = 'instructions';
    });
  }

  // Opens the Animate dialog for the selected file. `regenerate` starts from
  // the instructions and companions of the film on screen.
  askAnimate(regenerate = false) {
    if (!this.selected) return;
    const subject = this.selected;
    const from =
      regenerate && this.detail?.manifest.kind === 'film'
        ? this.detail.manifest
        : null;
    const scope = this.spotlightScope;
    this.withStore(() => {
      this.animateAsk = {
        subject,
        initial: from?.instructions ?? '',
        companions: from?.companions.map((c) => c.path) ?? [],
        regenerate,
        scope,
      };
      this.dialog = 'animate';
    });
  }

  // Opens the right dialog to make the artifact on screen again: the Animate
  // dialog for a film, the instructions step for a visual.
  askRegenerate() {
    const artifact = this.currentArtifact;
    if (artifact?.kind === 'pipeline')
      this.askCompose((artifact.parts ?? []).map((part) => part.artifact));
    else if (artifact?.kind === 'film') this.askAnimate(true);
    else if (artifact?.kind === 'stepthrough')
      this.askInstructions(true, 'stepthrough');
    else if (isView(artifact?.kind))
      this.askInstructions(true, 'view', artifact?.kind as ViewName);
    else this.askInstructions(true);
  }

  // True while a job is running that makes a version of the artifact that
  // `target` names. `target` comes from `targetOf` or `targetOfArtifact`.
  isBusy(target: string): boolean {
    return this.jobs.some(
      (job) => job.status === 'running' && job.target === target,
    );
  }

  // True while a job is making a new version of the artifact on screen.
  // Regenerating it and sending feedback about it are disabled meanwhile.
  artifactBusy = $derived(
    !!this.currentArtifact &&
      this.isBusy(targetOfArtifact(this.currentArtifact)),
  );

  // Replaces the job whose key is `key` by what `change` returns for it. Does
  // nothing when that job is no longer in `jobs`. That is the case when the
  // user removed the job from the panel, or opened another folder, before one
  // of the job's events arrived.
  private updateJob(key: number, change: (job: JobView) => JobView) {
    const at = this.jobs.findIndex((job) => job.key === key);
    if (at >= 0) this.jobs[at] = change(this.jobs[at]);
  }

  // Starts a job and shows it in the job panel. `subject` is the file the job
  // is about; a feedback request does not carry it.
  //
  // Any number of jobs can run at the same time, with one exception. While a
  // job is making a version of an artifact, a second job for the same artifact
  // is not started. The user is told, and the panel shows the running job.
  async startJob(
    request: JobRequest,
    subject: string = request.subject[0] ?? '',
  ) {
    const target = targetOf(request, this.artifacts);
    const running = this.jobs.find(
      (job) => job.status === 'running' && job.target === target,
    );
    if (running) {
      this.notify(
        'A new version of this is already being made. Wait for that job to finish, or cancel it in the panel below.',
      );
      this.shownJobKey = running.key;
      this.dockOpen = true;
      return;
    }
    this.dialog = null;
    this.instructionsAsk = null;
    this.animateAsk = null;
    this.composeAsk = null;
    const key = this.nextJobKey++;
    // An earlier job for the same artifact has ended. The new job takes its
    // place in the panel.
    this.jobs = [
      ...this.jobs.filter((job) => job.target !== target),
      newJob(request, Date.now(), subject, key, target),
    ];
    this.shownJobKey = key;
    this.dockOpen = true;
    // The estimate is added to the job when it arrives. A job runs the same
    // without one.
    api
      .jobEstimate(request)
      .then((estimate) => this.updateJob(key, (job) => ({ ...job, estimate })))
      .catch(() => {});
    try {
      await api.jobStart(request, (event) => {
        this.updateJob(key, (job) => reduceJob(job, event, Date.now()));
        if (event.type === 'result') this.onJobResult(key);
      });
    } catch (error) {
      const failure = error as AppError;
      this.updateJob(key, (job) =>
        reduceJob(
          job,
          {
            type: 'failed',
            code: failure.code ?? 'error',
            message: messageOf(error),
          },
          Date.now(),
        ),
      );
    }
  }

  // Shows another job in the job panel.
  showJob(key: number) {
    this.shownJobKey = key;
  }

  // Removes a job that has ended from the job panel. If the panel was showing
  // it, the panel shows the newest job that is left. A running job is not
  // removed.
  dismissJob(key: number) {
    this.jobs = this.jobs.filter(
      (job) => job.key !== key || job.status === 'running',
    );
    if (!this.job) this.shownJobKey = this.jobs.at(-1)?.key ?? null;
  }

  // The artifact that the job in the job panel made, once the job has finished
  // and the artifact is listed.
  jobArtifact = $derived(
    this.job?.status === 'done'
      ? (this.artifacts.find((a) => a.id === this.job?.artifactId) ?? null)
      : null,
  );
  // True when the artifact that the job in the job panel made is not the one
  // on screen. The job panel then offers a button that opens it.
  //
  // A visual of a part of a file counts as on screen while it fills the
  // editor area, and while the panel beside the source view shows it.
  jobResultElsewhere = $derived(
    !!this.jobArtifact &&
      (this.jobArtifact.scope
        ? this.spotlight !== this.jobArtifact.id &&
          !(this.sourceShown && this.scopeArtifactId === this.jobArtifact.id)
        : this.tab === 'source' ||
          this.currentArtifact?.id !== this.jobArtifact.id),
  );

  // After the job whose key is `key` made a version: reads the artifacts again
  // and shows the new version.
  private async onJobResult(key: number) {
    await this.reloadArtifacts();
    await this.showJobResult(key);
  }

  // Shows the version that the job whose key is `key` made, on the tab of its
  // kind: the Film tab for a film, the Blueprint tab for a visual.
  private async showJobResult(key: number) {
    const job = this.jobs.find((one) => one.key === key);
    if (!job || job.status !== 'done') return;
    const made = this.artifacts.find((a) => a.id === job.artifactId);
    // A new pipeline is opened wherever the user is, because nothing else shows
    // it. The result of any other job is shown only if the user is still on its
    // file.
    if (
      made?.kind === 'pipeline' &&
      (job.request.kind === 'compose' || this.selectedPipelineId === made.id)
    ) {
      this.composeSelection = [];
      return this.selectPipeline(made.id);
    }
    if (this.selected !== job.subject) return;
    // A visual of a part of a file is shown where the user asked for it. If
    // it fills the editor area, its new version is shown there. Otherwise
    // the panel beside the source view opens on it, when that view is on
    // screen.
    if (made?.scope) {
      if (this.spotlight === made.id) {
        this.pickedVersion = null;
        await this.loadDetail();
      } else if (this.tab === 'source' && !this.spotlight)
        this.openScope(made.scope, made.id);
      return;
    }
    await this.move(async () => {
      this.tab = tabOf(made?.kind);
      this.pickedVersion = null;
      await this.loadDetail();
    });
  }

  // Opens the artifact that the job in the job panel made, selecting its file
  // if the user has moved to another.
  async openJobResult() {
    if (this.jobArtifact) await this.openArtifact(this.jobArtifact);
  }

  // Starts the film of the job in the job panel again, from an outline the
  // user edited. If that job is still running it is cancelled first, because
  // its film would follow the outline the user has just changed.
  async restartWithOutline(outline: Outline, instructions: string) {
    const job = this.job;
    if (!job || job.request.kind !== 'animate') return;
    if (job.status === 'running') {
      await this.cancelJob();
      // The job reports that it has stopped a moment after it was asked to.
      const stillRunning = () =>
        this.jobs.some(
          (one) => one.key === job.key && one.status === 'running',
        );
      for (let waited = 0; stillRunning() && waited < 10000; waited += 100)
        await new Promise((done) => setTimeout(done, 100));
    }
    await this.startJob({ ...job.request, instructions, outline });
  }

  // Asks the artifact on screen to report the next element the user clicks.
  startPick() {
    this.picking = true;
    this.frameSend?.({ cj: 'pick', on: true });
  }

  cancelPick() {
    this.picking = false;
    this.frameSend?.({ cj: 'pick', on: false });
  }

  // Sends the user's feedback about the version on screen as a job that makes a
  // new version. What the user was looking at is attached: the moment of the
  // film, the selected part, the element they pointed at, and a picture of the
  // frame where the app can take one.
  //
  // `thread` is the id of a discussion, when the feedback follows from one.
  // The agent then knows what was said in it.
  async sendFeedback(text: string, thread?: string) {
    const artifact = this.currentArtifact;
    const version = this.shownVersion;
    if (!artifact || version == null || !text.trim()) return;
    const feedback: Feedback = {
      text: text.trim(),
      pointAt: this.picked,
      selected: this.selectedNode,
    };
    if (showsFilm(artifact) && this.filmMoment) {
      const moment = this.filmMoment;
      // A pinned moment replaces the current one, but the scene's own time is
      // only known for the moment the film is at now.
      const pinned =
        this.pinnedTime != null && Math.abs(this.pinnedTime - moment.t) > 0.05;
      feedback.time = this.pinnedTime ?? moment.t;
      if (!pinned)
        Object.assign(feedback, {
          chapter: moment.chapterTitle,
          scene: moment.scene,
          sceneTime: moment.sceneT,
        });
    }
    const rect = this.frameRect?.();
    if (rect) {
      try {
        feedback.screenshot = await api.feedbackCapture({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        });
      } catch {
        // The feedback is still useful without a picture.
      }
    }
    await this.startJob(
      {
        kind: 'feedback',
        subject: [],
        artifactId: artifact.id,
        baseVersion: version,
        feedback,
        thread,
      },
      artifact.kind === 'pipeline'
        ? PIPELINE_PREFIX + artifact.id
        : artifact.subject[0],
    );
  }

  // Asks the job in the job panel to stop, if it is running.
  async cancelJob() {
    if (this.job?.jobId && this.job.status === 'running')
      await api.jobCancel(this.job.jobId);
  }

  async pickVersion(version: number) {
    this.pickedVersion =
      version === this.currentArtifact?.currentVersion ? null : version;
    await this.loadDetail();
  }

  // Makes the version on screen the one that is shown by default.
  async makeCurrent() {
    const artifact = this.currentArtifact;
    if (!artifact || this.shownVersion == null) return;
    try {
      await api.artifactSetCurrent(artifact.id, this.shownVersion);
      this.pickedVersion = null;
      await this.reloadArtifacts();
    } catch (error) {
      this.fail(error);
    }
  }

  async exportArtifact() {
    const artifact = this.currentArtifact;
    if (!artifact || this.shownVersion == null) return;
    try {
      const base =
        artifact.kind === 'pipeline'
          ? artifact.title
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '') || 'pipeline'
          : (
              artifact.subject[0].replace(/\/$/, '').split('/').pop() ??
              'artifact'
            ).replace(/\.[^.]+$/, '');
      const name = base + '.' + artifact.kind + '.html';
      const saved = await api.artifactExport(
        artifact.id,
        this.shownVersion,
        name,
      );
      if (saved) this.notify(`Exported to ${saved}`);
    } catch (error) {
      this.fail(error);
    }
  }

  async deleteArtifact(id: string) {
    try {
      await api.artifactDelete(id);
      await this.reloadArtifacts();
      await this.loadDetail();
    } catch (error) {
      this.fail(error);
    }
  }

  // Switches a layer of the visual on screen on or off.
  setLayer(layer: string, on: boolean) {
    this.layers[layer] = on;
    this.frameSend?.({ cj: 'layers', on: { [layer]: on } });
  }

  // Restores the files that the job in the job panel reported as changed while
  // it ran to their last committed content, where git can.
  async revertViolations() {
    if (!this.job?.violations.length) return;
    try {
      const results = await api.guardRevert(this.job.violations);
      const restored = results.filter((r) => r.reverted).length;
      this.notify(
        `${restored} of ${results.length} file(s) restored.` +
          (restored < results.length
            ? ' ' + results.find((r) => !r.reverted)!.note
            : ''),
      );
    } catch (error) {
      this.fail(error);
    }
  }

  notify(text: string, kind: Toast['kind'] = 'info') {
    const id = this.nextToast++;
    this.toasts.push({ id, kind, text });
    setTimeout(() => this.dismissToast(id), kind === 'error' ? 8000 : 4000);
  }

  // Removes the toast with this id. Does nothing if that toast has already
  // been removed.
  dismissToast(id: number) {
    this.toasts = this.toasts.filter((t) => t.id !== id);
  }

  fail(error: unknown) {
    this.notify(messageOf(error), 'error');
  }

  // The changed files of the open workspace, as git reports them (see
  // lib/gitStatus.ts). The file tree shows a letter and a colour for each.
  // The list is empty for a folder that is not inside a git repository.
  gitEntries = $state.raw<GitEntry[]>([]);
  // True when the open workspace is inside a git repository, which is known
  // once git has answered for the first time.
  gitRepo = $state(false);
  gitMarks = $derived(
    this.gitEntries.length ? gitMarks(this.gitEntries) : NO_MARKS,
  );
  // True while git is being asked for the changes.
  private gitAsking = false;
  // True when `refreshGit` was called while git was being asked. Git is
  // then asked once more when the answer arrives, because the files may
  // have changed after git read them.
  private gitAskAgain = false;

  // Asks git for the changed files of the workspace and keeps the answer in
  // `gitEntries`. It is called when a folder is opened, when a watched
  // folder changes on disk, and when the window comes to the front. Git is
  // asked by one call at a time.
  async refreshGit() {
    if (!this.workspace) return;
    if (this.gitAsking) {
      this.gitAskAgain = true;
      return;
    }
    this.gitAsking = true;
    const root = this.workspace.root;
    try {
      const entries = await api.gitStatus();
      // The answer is dropped when another folder was opened meanwhile.
      if (this.workspace?.root === root) {
        this.gitEntries = entries ?? [];
        this.gitRepo = entries != null;
      }
    } catch {
      // Without an answer the tree keeps the marks it has.
    }
    this.gitAsking = false;
    if (this.gitAskAgain) {
      this.gitAskAgain = false;
      void this.refreshGit();
    }
  }

  // True while the dialog that picks a folder is open.
  private pickingFolder = false;

  // Shows the dialog that picks a folder and opens the folder the user
  // chooses. A second call while the dialog is open does nothing. On macOS
  // the key for "Open Folder…" can arrive twice, once from the menu bar and
  // once as a key press in the window.
  async pickAndOpen() {
    if (this.pickingFolder) return;
    this.pickingFolder = true;
    try {
      const path = await api.pickFolder();
      if (path) await this.openWorkspace(path);
    } catch (error) {
      this.fail(error);
    } finally {
      this.pickingFolder = false;
    }
  }

  async openWorkspace(path: string) {
    try {
      const info = await api.workspaceOpen(path);
      this.children = {};
      this.expanded = {};
      this.selected = null;
      this.fileInfo = null;
      this.openFiles = [];
      this.bookmarks = {};
      this.gitEntries = [];
      this.gitRepo = false;
      this.diffs = {};
      diffs.reset();
      this.menu = null;
      this.tab = 'visual';
      this.workspace = info;
      this.artifacts = [];
      this.detail = null;
      this.pickedVersion = null;
      this.jobs = [];
      this.shownJobKey = null;
      this.dockOpen = false;
      this.places = [];
      this.placeIndex = -1;
      this.filmTimes.clear();
      this.sourceLine = null;
      this.sourceSpan = null;
      this.spotlight = null;
      this.closeScope();
      this.clearSymbol();
      await this.loadDir('');
      // Git can take a moment in a large repository, so the folder does not
      // wait for it. The marks appear in the tree when git has answered.
      void this.refreshGit();
      await this.reloadArtifacts();
      await this.syncWatched();
      this.recents = await api.workspaceRecent();
      await this.restoreSession();
    } catch (error) {
      this.fail(error);
    }
  }

  async closeWorkspace() {
    await api.workspaceClose();
    this.workspace = null;
    this.selected = null;
    this.fileInfo = null;
    this.openFiles = [];
    this.bookmarks = {};
    this.gitEntries = [];
    this.gitRepo = false;
    this.diffs = {};
    diffs.reset();
    this.menu = null;
    this.places = [];
    this.placeIndex = -1;
    this.sourceLine = null;
    this.sourceSpan = null;
    this.symbol = null;
    this.recents = await api.workspaceRecent();
  }

  private async loadDir(dir: string) {
    this.children[dir] = await api.treeChildren(dir);
  }

  // Tells the core which folders to watch: the root, every expanded folder, and
  // the folder of every file an artifact was made from, so that an edit to such
  // a file is noticed even when its folder is closed in the tree.
  private async syncWatched() {
    const dirs = new Set<string>([
      '',
      ...Object.keys(this.expanded).filter((dir) => this.expanded[dir]),
    ]);
    for (const artifact of this.artifacts)
      for (const source of artifact.sources) dirs.add(parentOf(source));
    if (this.selectedIsFolder && this.selected)
      dirs.add(this.selected.slice(0, -1));
    await api.watchDirs([...dirs]);
  }

  async toggleDir(dir: string) {
    try {
      if (this.expanded[dir]) {
        this.expanded[dir] = false;
      } else {
        if (!this.children[dir]) await this.loadDir(dir);
        this.expanded[dir] = true;
      }
      await this.syncWatched();
    } catch (error) {
      this.fail(error);
    }
  }

  // Code navigation in the source view. A place is named by the file's path,
  // the line counted from 1 and the column counted from 0.

  // Makes the name at a place of a file the selected name: the source viewer
  // marks its uses, and the panel on the right lists its definitions and
  // references. Returns what is known about the name, or null when there is
  // no name at that place. In that case nothing stays selected.
  async selectSymbol(
    path: string,
    line: number,
    column: number,
  ): Promise<NavLookup | null> {
    const mine = ++this.lookups;
    let lookup: NavLookup | null;
    try {
      lookup = await api.navLookup(path, line, column);
    } catch (error) {
      this.fail(error);
      return null;
    }
    // The user has clicked somewhere else since this lookup was started.
    if (mine !== this.lookups) return null;
    if (!lookup) {
      this.clearSymbol();
      return null;
    }
    this.setSymbol(path, lookup);
    return lookup;
  }

  // Makes `lookup`, which was found in the file at `path`, the selected
  // name. If that same name at that same place is selected already, its
  // list of references is kept and not searched for again.
  private setSymbol(path: string, lookup: NavLookup) {
    const now = this.symbol;
    if (
      now &&
      now.path === path &&
      now.lookup.name === lookup.name &&
      now.lookup.line === lookup.line &&
      now.lookup.column === lookup.column
    ) {
      now.lookup = lookup;
      return;
    }
    if (now?.search === 'running') api.navCancel().catch(() => {});
    this.symbol = {
      path,
      lookup,
      references: [],
      search: 'idle',
      outcome: null,
    };
  }

  // Leaves no name selected, and stops a search for references that is
  // running.
  clearSymbol() {
    this.lookups++;
    if (this.symbol?.search === 'running') api.navCancel().catch(() => {});
    this.symbol = null;
  }

  // Searches for the references of the selected name, unless that was done
  // or is being done. The panel that lists them calls this when it appears,
  // so that nothing is searched while nobody looks at the list.
  async searchReferences() {
    const symbol = this.symbol;
    if (!symbol || symbol.search !== 'idle') return;
    symbol.search = 'running';
    try {
      await api.navReferences(
        symbol.path,
        symbol.lookup.line,
        symbol.lookup.column,
        (event) => {
          // Reports of a search for a name that is no longer selected are
          // dropped.
          if (this.symbol !== symbol) return;
          if (event.type === 'found')
            symbol.references.push(...event.references);
          else
            symbol.outcome = {
              total: event.total,
              files: event.files,
              exact: event.exact,
              truncated: event.truncated,
            };
        },
      );
    } catch (error) {
      if (this.symbol === symbol) this.fail(error);
    }
    if (this.symbol === symbol) symbol.search = 'done';
  }

  // Goes to the definition of the name at a place of a file. `declaration`
  // asks for the prototype where a name has a prototype and a body, as in C
  // and C++.
  //   - If one definition is certain, the source viewer goes there. The
  //     selected name is left as it is, so that a list of references the
  //     user is working through stays.
  //   - If several definitions are equally likely, the name becomes the
  //     selected name and the panel on the right opens with all of them.
  //   - If the place is itself the only definition, the same happens, and
  //     the panel shows where the name is used.
  //   - If there is no definition in the workspace, a toast says so.
  async goToDefinition(
    path: string,
    line: number,
    column: number,
    declaration = false,
  ) {
    const mine = ++this.lookups;
    let lookup: NavLookup | null;
    try {
      lookup = await api.navLookup(path, line, column, declaration);
    } catch (error) {
      return this.fail(error);
    }
    if (mine !== this.lookups || !lookup) return;
    const target = lookup.definitions[0];
    const isHere =
      !!target &&
      target.path === path &&
      target.line === lookup.line &&
      target.column === lookup.column;
    if (target && lookup.certain && !isHere) return this.openSpan(target);
    this.setSymbol(path, lookup);
    this.inspectorOpen = true;
    if (!target)
      this.notify(`No definition of ${lookup.name} was found in this folder.`);
  }

  // Makes the name at a place of a file the selected name and opens the
  // panel that lists its references.
  async findReferences(path: string, line: number, column: number) {
    if (await this.selectSymbol(path, line, column)) this.inspectorOpen = true;
  }

  // Shows a place in the source viewer: the file at `path`, scrolled to the
  // line of `span`, with the characters of `span` marked.
  openSpan(place: NavSpan & { path: string }): Promise<void> {
    return this.selectFile(place.path, place.line, {
      line: place.line,
      column: place.column,
      endColumn: place.endColumn,
    });
  }

  // Called when the window comes to the front. The user may have changed
  // files in another program meanwhile, or made a commit, so git is asked
  // for the changed files again. The core is also asked to look for changed
  // files, at most once in five seconds.
  windowFocused() {
    void this.refreshGit();
    if (!this.workspace || Date.now() - this.lastNavRefresh < 5000) return;
    this.lastNavRefresh = Date.now();
    api.navRefresh().catch(() => {});
  }

  // Opens the quick-open dialog. With `symbols` it starts as a search for
  // definitions by name.
  openQuickOpen(symbols = false) {
    this.quickOpenStart = symbols ? '#' : '';
    this.dialog = 'quickopen';
  }

  // Selects a file, expanding the folders above it so its row is visible.
  // `line` scrolls the source viewer to that line and switches to it. `span`
  // names the characters of that line to mark.
  async selectFile(relPath: string, line?: number, span?: NavSpan) {
    if (relPath.endsWith('/')) return this.selectFolder(relPath);
    await this.move(() => this.showFile(relPath, line, span));
  }

  // Selects a file the user was on before, through its file tab or with
  // Back and Forward. `line` is the line its source view was at then.
  // `selectFile` takes a line as a request to see that line of the text,
  // and so makes a file that shows its changes show its text. Here the
  // line is only where the view was, so a file that was showing its changes
  // shows them again.
  private async selectFileAgain(relPath: string, line?: number) {
    const showedChanges = !!this.diffs[relPath];
    await this.selectFile(relPath, line);
    if (showedChanges) this.diffs[relPath] = true;
  }

  // The work of `selectFile` for a path that is a file.
  private async showFile(relPath: string, line?: number, span?: NavSpan) {
    // A line is a line of the text of the file, so the file shows its text
    // again when it was showing its changes.
    if (line != null) delete this.diffs[relPath];
    // Going to a line of the file that is already selected changes only what
    // the source viewer shows. The file is not read and described again.
    if (
      line != null &&
      relPath === this.selected &&
      this.fileInfo?.relPath === relPath
    ) {
      this.sourceLine = line;
      this.sourceSpan = span ?? null;
      this.tab = 'source';
      this.sourceReveal++;
      return;
    }
    try {
      this.folderInfo = null;
      for (const dir of ancestorsOf(relPath)) {
        if (!this.children[dir]) await this.loadDir(dir);
        this.expanded[dir] = true;
      }
      if (this.scope && this.scope.path !== relPath) this.closeScope();
      this.selected = relPath;
      this.sourceLine = line ?? null;
      this.sourceSpan = span ?? null;
      this.sourceReveal++;
      if (line != null) this.tab = 'source';
      // A file that has only a film opens on it, and a file without a film does
      // not stay on the Film tab's empty state when it has a visual.
      else if (
        this.tab === 'visual' &&
        !this.visualArtifact &&
        this.filmArtifact
      )
        this.tab = 'film';
      else if (this.tab === 'film' && !this.filmArtifact && this.visualArtifact)
        this.tab = 'visual';
      // A file without a step-through does not stay on that tab's empty
      // state when it has a visual or a film to show.
      else if (this.tab === 'steps' && !this.stepsArtifact)
        this.tab = this.visualArtifact
          ? 'visual'
          : this.filmArtifact
            ? 'film'
            : 'steps';
      // The same holds for a view the file does not have. A map is made of a
      // folder, so a file is never left on the Map tab.
      else if (
        isView(this.tab) &&
        (this.tab === 'map' || !this.viewArtifact(this.tab))
      )
        this.tab = this.visualArtifact
          ? 'visual'
          : this.filmArtifact
            ? 'film'
            : this.tab === 'map'
              ? 'visual'
              : this.tab;
      this.pickedVersion = null;
      this.detail = null;
      this.fileInfo = null;
      this.fileInfo = await api.fileInfo(relPath);
      void this.loadSuggestion(relPath);
      await this.loadDetail();
      await this.syncWatched();
    } catch (error) {
      this.fail(error);
    }
  }

  // Selects a folder, to make or show a visual or a map of the whole folder.
  // A folder has no source view and no film. It opens on the Blueprint tab.
  async selectFolder(relDir: string) {
    await this.move(() => this.showFolder(relDir));
  }

  // The work of `selectFolder`.
  private async showFolder(relDir: string) {
    const dir = relDir.replace(/\/+$/, '');
    try {
      for (const parent of ancestorsOf(dir)) {
        if (!this.children[parent]) await this.loadDir(parent);
        this.expanded[parent] = true;
      }
      this.closeScope();
      this.selected = dir + '/';
      this.tab = 'visual';
      this.sourceLine = null;
      this.pickedVersion = null;
      this.detail = null;
      this.fileInfo = null;
      this.folderInfo = null;
      this.folderInfo = await api.folderInfo(dir);
      await this.loadDetail();
      await this.syncWatched();
    } catch (error) {
      this.fail(error);
    }
  }

  private async onFsChanged(changes: Changes) {
    // A file that changed on disk may have another git status now.
    void this.refreshGit();
    try {
      for (const dir of changes.dirs) {
        if (this.children[dir]) await this.loadDir(dir);
      }
      // A file that was deleted loses its file tab. Whether a file is still
      // there is read from the entries of its folder, so a file whose folder
      // is not loaded is left alone. If the deleted file was on screen,
      // closing its tab shows the tab next to it.
      for (const path of changes.paths) {
        if (!this.openFiles.some((file) => file.path === path)) continue;
        const siblings = this.children[parentOf(path)];
        if (!siblings || siblings.some((e) => e.relPath === path)) continue;
        await this.closeOpenFile(path);
      }
      if (this.selected && changes.paths.includes(this.selected)) {
        this.fileInfo = await api.fileInfo(this.selected);
        this.sourceRefresh++;
        void this.loadSuggestion(this.selected);
      }
      // A changed source file may have made an artifact stale, or current
      // again.
      if (
        this.artifacts.some((a) =>
          a.sources.some((source) => changes.paths.includes(source)),
        )
      )
        await this.reloadArtifacts();
    } catch {
      // A folder that was deleted while it was being re-read is not worth
      // reporting: the next change event for its parent removes it from the
      // tree.
    }
  }

  async saveSettings(next: Settings) {
    try {
      const before = this.settings;
      this.settings = await api.settingsSet(next);
      // A provider's model and address decide whether it can run jobs, so the
      // lists that show that are read again when either changed.
      if (
        before &&
        (JSON.stringify(before.models) !== JSON.stringify(next.models) ||
          JSON.stringify(before.apiBaseUrls) !==
            JSON.stringify(next.apiBaseUrls))
      ) {
        await this.loadApiProviders();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  // Reads the API providers again, and the agent list with them, because each
  // provider is also an entry in that list.
  async loadApiProviders() {
    try {
      this.apiProviders = await api.apiProviders();
      this.agents = await api.agentsDetect(false);
    } catch (error) {
      this.fail(error);
    }
  }

  // Saves a provider's key. Returns true when it was saved.
  async saveApiKey(providerId: string, key: string): Promise<boolean> {
    try {
      await api.apiKeySet(providerId, key);
      await this.loadApiProviders();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async clearApiKey(providerId: string) {
    try {
      await api.apiKeyClear(providerId);
      await this.loadApiProviders();
    } catch (error) {
      this.fail(error);
    }
  }

  // Makes sure the workspace's .codjiva folder exists, and asks the .gitignore
  // question the first time. `then` runs once the folder is ready and the
  // question, if asked, is answered.
  async withStore(then: () => void) {
    if (!this.workspace) return;
    try {
      const status = await api.storeEnsure();
      this.workspace.store = status;
      if (status.askAboutGitignore) {
        this.afterGitignore = then;
        this.dialog = 'gitignore';
      } else {
        then();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  // Records the answer to the .gitignore question.
  //   - `add` adds the .codjiva folder to .gitignore.
  //   - `track` records that the folder is to stay tracked.
  //   - `later` records nothing, so the question is asked again next time.
  //   - `never` records that the question is not to be asked again in this
  //     workspace. It decides nothing about .gitignore.
  async answerGitignore(answer: 'add' | 'track' | 'later' | 'never') {
    try {
      if (this.workspace && answer === 'add')
        this.workspace.store = await api.gitignoreAdd();
      if (this.workspace && answer === 'track')
        this.workspace.store = await api.gitignoreKeepTracked();
      if (this.workspace && answer === 'never')
        this.workspace.store = await api.gitignoreStopAsking();
    } catch (error) {
      this.fail(error);
    }
    this.dialog = null;
    const next = this.afterGitignore;
    this.afterGitignore = null;
    next?.();
  }

  async setTheater(on: boolean) {
    this.theater = on;
    try {
      await api.setFullscreen(on);
    } catch {
      // The panels are hidden either way; a window that cannot go full screen
      // still shows the film as large as the window allows.
    }
  }

  // Lays the panels out as a settings file has them. Widths outside the limits
  // are brought back inside them.
  private applyLayout(layout: Layout | undefined) {
    if (!layout) return;
    this.sidebarOpen = layout.sidebarOpen;
    this.sidebarWidth = Math.min(
      SIDEBAR_MAX,
      Math.max(SIDEBAR_MIN, layout.sidebarWidth),
    );
    this.inspectorOpen = layout.inspectorOpen;
    this.inspectorWidth = Math.min(
      INSPECTOR_MAX,
      Math.max(INSPECTOR_MIN, layout.inspectorWidth),
    );
    this.dockHeight = layout.dockHeight;
    this.libraryOpen = layout.libraryOpen;
    this.libraryHeight = layout.libraryHeight;
    this.stepPanelHeight = layout.stepPanelHeight;
    this.sourcePanelWidth = Math.max(
      INSPECTOR_MIN,
      layout.sourcePanelWidth ?? SOURCE_PANEL_WIDTH,
    );
    this.sourceSplit = Math.min(
      SOURCE_SPLIT_MAX,
      Math.max(SOURCE_SPLIT_MIN, layout.sourceSplit ?? 40),
    );
    this.sourceSwapped = !!layout.sourceSwapped;
    this.diffSplit = !!layout.diffSplit;
    this.diffWholeFile = !!layout.diffWholeFile;
  }

  // Writes the panels' sizes and open states to the settings, if they differ
  // from what the settings hold, so that the window looks the same the next
  // time the app starts.
  async saveLayout() {
    if (!this.settings) return;
    const whole = (size: number | null) =>
      size == null ? null : Math.round(size);
    const layout: Layout = {
      sidebarOpen: this.sidebarOpen,
      sidebarWidth: Math.round(this.sidebarWidth),
      inspectorOpen: this.inspectorOpen,
      inspectorWidth: Math.round(this.inspectorWidth),
      dockHeight: whole(this.dockHeight),
      libraryOpen: this.libraryOpen,
      libraryHeight: whole(this.libraryHeight),
      stepPanelHeight: whole(this.stepPanelHeight),
      sourcePanelWidth: Math.round(this.sourcePanelWidth),
      sourceSplit: Math.round(this.sourceSplit),
      sourceSwapped: this.sourceSwapped,
      diffSplit: this.diffSplit,
      diffWholeFile: this.diffWholeFile,
    };
    if (JSON.stringify(layout) === JSON.stringify(this.settings.layout)) return;
    await this.saveSettings({ ...this.settings, layout });
  }

  dispose() {
    this.stopWatching?.();
    this.stopValidating?.();
  }
}

export const app = new AppState();
