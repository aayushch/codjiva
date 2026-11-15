// The interface's state: what is open, what is selected and which panels are showing. One
// instance, `app`, is shared by every component.

import { api, type AgentInfo, type ApiProvider, type AppError, type AppInfo, type ArtifactDetail, type ArtifactSummary, type Changes, type Feedback, type FileInfo, type FolderInfo, type Join, type JobRequest, type Outline, type PickedElement, type RecentWorkspace, type Settings, type TreeEntry, type ValidateRequest, type WorkspaceInfo } from '$lib/ipc';
import { PIPELINE_PREFIX, showsFilm } from '$lib/artifacts';
import { newJob, reduceJob, type JobView } from '$lib/jobs';
import { ancestorsOf, flattenTree, parentOf } from '$lib/tree';

export type ViewTab = 'visual' | 'film' | 'source';
export type Dialog = null | 'quickopen' | 'settings' | 'gitignore' | 'instructions' | 'animate' | 'outline' | 'compose';
export type Toast = { id: number; kind: 'info' | 'error'; text: string };

// Limits for the panels the user can resize, in pixels.
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const INSPECTOR_WIDTH = 320;
// The least height of the library while its list is showing, and the height that is always left
// for the file tree above it.
export const LIBRARY_MIN = 96;
export const TREE_MIN = 160;
export const DOCK_HEIGHT = 220;
// A film job lists more steps than the other kinds, so its panel is taller.
export const DOCK_HEIGHT_FILM = 272;
// The least height the user can drag the job panel to, and the height that is always left for
// the editor area above it.
export const DOCK_MIN = 120;
export const EDITOR_MIN = 160;

// What the instructions dialog is asking about: which file, and the text to start from.
export type InstructionsAsk = { kind: 'visualise'; subject: string; initial: string; regenerate: boolean };

// What the Animate dialog starts from: the file, and for a regeneration the instructions and
// companions of the film on screen.
export type AnimateAsk = { subject: string; initial: string; companions: string[]; regenerate: boolean };

// Where the film on screen is: the time in real seconds, the chapter's index and title, and the
// same moment as the id and animation time of the scene.
export type FilmMoment = { t: number; chapter: number; chapterTitle: string; scene: string; sceneT: number };

// One place the user has been, for the Back and Forward buttons: what was selected, the tab,
// the line the source view was at, and for a film how far it had played when the user left.
export type Place = { selected: string; tab: ViewTab; line: number | null; filmTime: number | null };
// How many places are remembered. The oldest are dropped first.
const PLACES_KEPT = 100;

// The length of a film in real seconds for each choice in Settings.
export const FILM_SECONDS = { short: 60, standard: 180, deep: 300 } as const;

const messageOf = (error: unknown): string => {
  if (error && typeof error === 'object' && 'message' in error) return String((error as AppError).message);
  return String(error);
};

class AppState {
  info = $state<AppInfo | null>(null);
  workspace = $state<WorkspaceInfo | null>(null);
  recents = $state<RecentWorkspace[]>([]);
  settings = $state<Settings | null>(null);
  // The theme the window is drawn in. It follows the `theme` setting; App.svelte sets it.
  theme = $state<'light' | 'dark'>(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  // The entries of every folder loaded so far, by folder path. "" is the workspace root.
  children = $state<Record<string, TreeEntry[]>>({});
  expanded = $state<Record<string, boolean>>({});
  rows = $derived(flattenTree(this.children, this.expanded));

  // The selected file's path, and what is known about it once it has been read. A folder can
  // be selected too, to make a visual of the whole folder. Its path ends with a slash, and
  // what is known about it is in `folderInfo` instead.
  selected = $state<string | null>(null);
  fileInfo = $state<FileInfo | null>(null);
  folderInfo = $state<FolderInfo | null>(null);
  selectedIsFolder = $derived(!!this.selected?.endsWith('/'));
  tab = $state<ViewTab>('visual');
  // The line the source viewer scrolls to and highlights, when a code reference was followed.
  sourceLine = $state<number | null>(null);

  // Which of the two bundled examples is showing in place of a file, if any.
  example = $state<null | 'film' | 'visual'>(null);

  dialog = $state<Dialog>(null);
  // What to do after the user has answered the .gitignore question.
  private afterGitignore: (() => void) | null = null;
  toasts = $state<Toast[]>([]);
  private nextToast = 1;

  // The agents found on this machine. `agentsLoaded` turns true after the first look.
  agents = $state<AgentInfo[]>([]);
  agentsLoaded = $state(false);
  // The agent that will run the next job: the one chosen in Settings when it is usable,
  // otherwise the first usable one.
  activeAgent = $derived(this.agents.find((a) => a.ok && a.id === this.settings?.agent) ?? this.agents.find((a) => a.ok) ?? null);

  // The API providers and what each still needs. Settings loads the list when it opens.
  apiProviders = $state<ApiProvider[]>([]);

  // Every artifact of the open workspace.
  artifacts = $state<ArtifactSummary[]>([]);
  // The visual and the film of the selected file, where they have been made.
  visualArtifact = $derived(this.selected ? this.artifacts.find((a) => a.kind === 'visual' && a.subject[0] === this.selected) ?? null : null);
  filmArtifact = $derived(this.selected ? this.artifacts.find((a) => a.kind === 'film' && a.subject[0] === this.selected) ?? null : null);
  // The id of the selected pipeline. A pipeline is selected in place of a file, and then
  // `selected` holds its id after a prefix.
  selectedPipelineId = $derived(this.selected?.startsWith(PIPELINE_PREFIX) ? this.selected.slice(PIPELINE_PREFIX.length) : null);
  // The artifact on screen: the selected pipeline, or for a file its film on the Film tab and
  // its visual otherwise.
  currentArtifact = $derived(this.selectedPipelineId ? this.artifacts.find((a) => a.id === this.selectedPipelineId) ?? null
    : this.tab === 'film' ? this.filmArtifact : this.visualArtifact);
  // The artifacts ticked in the library for a pipeline, in the order they were ticked.
  composeSelection = $state<string[]>([]);
  // The artifacts the compose dialog is open for.
  composeAsk = $state<string[] | null>(null);
  // Every join the app can propose between two artifacts of the workspace. The inspector uses
  // it to say what an artifact connects to.
  connections = $state<Join[]>([]);
  // The version of `currentArtifact` on screen, when it is not the current one.
  pickedVersion = $state<number | null>(null);
  shownVersion = $derived(this.currentArtifact ? this.pickedVersion ?? this.currentArtifact.currentVersion : null);
  // The details of the version on screen: its manifest, its nodes, the analysis behind it.
  detail = $state<ArtifactDetail | null>(null);
  // The node of the visual the user clicked, and which layers are switched on.
  selectedNode = $state<string | null>(null);
  layers = $state<Record<string, boolean>>({});
  legendOn = $state(false);
  // Sends a message to the artifact on screen. The frame that shows it sets this.
  frameSend: ((message: Record<string, unknown>) => void) | null = null;
  // Returns where the artifact's frame is in the window, for a picture of it. The frame that
  // shows the artifact sets this.
  frameRect: (() => DOMRect | null) | null = null;
  // Where the film on screen is. The film player keeps this up to date.
  filmMoment = $state<FilmMoment | null>(null);
  // A moment of the film the user pinned for their feedback, in real seconds.
  pinnedTime = $state<number | null>(null);
  // True while the artifact waits for the user to click the element their feedback is about,
  // and the element they clicked.
  picking = $state(false);
  picked = $state<PickedElement | null>(null);

  // The job that is running or last ran, and whether its panel is open.
  job = $state<JobView | null>(null);
  dockOpen = $state(false);
  // The height the user dragged the job panel to. Null until they drag it; the panel then has
  // the height that suits the kind of job.
  dockHeight = $state<number | null>(null);
  instructionsAsk = $state<InstructionsAsk | null>(null);
  animateAsk = $state<AnimateAsk | null>(null);
  // Versions the window has been asked to self-test for running jobs, oldest first.
  validateQueue = $state<ValidateRequest[]>([]);

  // The places the user has been in this workspace, oldest first, and which of them is on
  // screen. Back and Forward move `placeIndex` through `places`. Going somewhere new from the
  // middle of the list drops the places after `placeIndex`.
  places = $state<Place[]>([]);
  placeIndex = $state(-1);
  canGoBack = $derived(this.placeIndex > 0);
  canGoForward = $derived(this.placeIndex < this.places.length - 1);
  // The time, in real seconds, the film player seeks to when its film is ready. Back and
  // Forward set it so that a film continues where the user left it.
  resumeFilmAt = $state<number | null>(null);
  // How many changes of place are under way. A change can be made of others: opening an
  // artifact selects its file and then switches the tab. The place is recorded once, when the
  // outermost change has finished.
  private moves = 0;

  sidebarWidth = $state(280);
  // The library at the bottom of the sidebar: whether its list is showing, and its height in
  // pixels once the user has dragged its top edge. Until then the library is as tall as its
  // list, up to a share of the sidebar.
  libraryOpen = $state(true);
  libraryHeight = $state<number | null>(null);
  // True while a film or visual fills the window and the panels around it are hidden.
  theater = $state(false);

  private stopWatching: (() => void) | null = null;
  private stopValidating: (() => void) | null = null;

  async init() {
    try {
      this.info = await api.appInfo();
      this.settings = await api.settingsGet();
      this.recents = await api.workspaceRecent();
      this.stopWatching = await api.onFsChanged((changes) => this.onFsChanged(changes));
      this.stopValidating = await api.onValidateRequest((request) => { this.validateQueue.push(request); });
    } catch (error) {
      this.fail(error);
    }
    // Looking for agents starts programs and can take a few seconds, so the window does not
    // wait for it.
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
      this.composeSelection = this.composeSelection.filter((id) => this.artifacts.some((a) => a.id === id));
      const withPorts = this.artifacts.filter((a) => a.kind !== 'pipeline' && a.ports.length > 0).map((a) => a.id);
      this.connections = withPorts.length >= 2 ? (await api.composePropose(withPorts)).joins : [];
    } catch (error) {
      this.fail(error);
    }
  }

  // Switches the tab. Going from the visual to the film, or back, shows the other artifact, so
  // its details are loaded.
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

  // Runs a change of what is on screen, and records the place it leads to for the Back and
  // Forward buttons. Every method that selects something or switches the tab goes through here.
  private async move(change: () => Promise<void>) {
    if (this.moves === 0) this.leavePlace();
    this.moves++;
    try {
      await change();
    } finally {
      this.moves--;
      if (this.moves === 0) this.recordPlace();
    }
  }

  // Called before the user leaves the place on screen. If that place is a film, the time it has
  // reached is kept with the place, so that Back can continue the film from there.
  private leavePlace() {
    const here = this.places[this.placeIndex];
    if (here && this.tab === 'film' && this.filmMoment) here.filmTime = this.filmMoment.t;
    this.resumeFilmAt = null;
  }

  // Adds the place on screen after `placeIndex`, unless it is the place already there.
  private recordPlace() {
    if (!this.selected) return;
    const place: Place = { selected: this.selected, tab: this.tab, line: this.tab === 'source' ? this.sourceLine : null, filmTime: null };
    const here = this.places[this.placeIndex];
    if (here && here.selected === place.selected && here.tab === place.tab && here.line === place.line) return;
    this.places = [...this.places.slice(0, this.placeIndex + 1), place].slice(-PLACES_KEPT);
    this.placeIndex = this.places.length - 1;
  }

  goBack() { return this.goToPlace(this.placeIndex - 1); }
  goForward() { return this.goToPlace(this.placeIndex + 1); }

  // Shows the place at `index` of `places` again: its file, folder or pipeline, its tab, the
  // line of the source view, and the moment of its film.
  private async goToPlace(index: number) {
    const place = this.places[index];
    if (!place) return;
    this.leavePlace();
    this.placeIndex = index;
    // `moves` is raised without `move`, so that the selections below record no new place.
    this.moves++;
    try {
      if (place.tab === 'film') this.resumeFilmAt = place.filmTime;
      if (place.selected.startsWith(PIPELINE_PREFIX)) await this.selectPipeline(place.selected.slice(PIPELINE_PREFIX.length));
      else if (place.selected.endsWith('/')) await this.selectFolder(place.selected);
      else {
        await this.selectFile(place.selected, place.tab === 'source' && place.line != null ? place.line : undefined);
        if (this.tab !== place.tab) await this.setTab(place.tab);
      }
    } finally {
      this.moves--;
    }
  }

  // Selects an artifact's file and shows the artifact: the Film tab for a film, the Visual tab
  // for a visual.
  async openArtifact(artifact: ArtifactSummary) {
    if (artifact.kind === 'pipeline') return this.selectPipeline(artifact.id);
    await this.move(async () => {
      await this.selectFile(artifact.subject[0]);
      await this.setTab(artifact.kind === 'film' ? 'film' : 'visual');
    });
  }

  // Shows a pipeline. It takes the place of a file in the selection, because it explains
  // several files and belongs to none of them.
  async selectPipeline(id: string) {
    await this.move(async () => {
      this.example = null;
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
    this.composeSelection = this.composeSelection.includes(id) ? this.composeSelection.filter((one) => one !== id) : [...this.composeSelection, id];
  }

  // Opens the compose dialog for the given artifacts.
  askCompose(ids: string[]) {
    this.withStore(() => {
      this.composeAsk = ids;
      this.dialog = 'compose';
    });
  }

  // Forgets what was attached to a feedback that has not been sent: the pinned moment and the
  // pointed-at element.
  private clearFeedbackContext() {
    this.pinnedTime = null;
    this.picked = null;
    this.picking = false;
    this.filmMoment = null;
  }

  // Loads the details of the version on screen, or clears them when the selected file has no
  // artifact of the kind the tab shows.
  async loadDetail() {
    const artifact = this.currentArtifact;
    const version = this.shownVersion;
    this.clearFeedbackContext();
    if (!artifact || version == null) { this.detail = null; return; }
    try {
      const detail = await api.artifactDetail(artifact.id, version);
      // The selection may have moved on while this was loading.
      if (this.currentArtifact?.id !== artifact.id || this.shownVersion !== version) return;
      this.detail = detail;
      this.selectedNode = null;
      this.legendOn = false;
      this.layers = Object.fromEntries(Object.keys(detail.definition?.layers ?? {}).map((layer) => [layer, true]));
    } catch (error) {
      this.detail = null;
      this.fail(error);
    }
  }

  // Opens the instructions step for the selected file. `regenerate` starts from the
  // instructions of the version on screen.
  askInstructions(regenerate = false) {
    if (!this.selected) return;
    const subject = this.selected;
    const initial = regenerate ? this.detail?.manifest.instructions ?? '' : '';
    this.withStore(() => {
      this.instructionsAsk = { kind: 'visualise', subject, initial, regenerate };
      this.dialog = 'instructions';
    });
  }

  // Opens the Animate dialog for the selected file. `regenerate` starts from the instructions
  // and companions of the film on screen.
  askAnimate(regenerate = false) {
    if (!this.selected) return;
    const subject = this.selected;
    const from = regenerate && this.detail?.manifest.kind === 'film' ? this.detail.manifest : null;
    this.withStore(() => {
      this.animateAsk = { subject, initial: from?.instructions ?? '', companions: from?.companions.map((c) => c.path) ?? [], regenerate };
      this.dialog = 'animate';
    });
  }

  // Opens the right dialog to make the artifact on screen again: the Animate dialog for a
  // film, the instructions step for a visual.
  askRegenerate() {
    const artifact = this.currentArtifact;
    if (artifact?.kind === 'pipeline') this.askCompose((artifact.parts ?? []).map((part) => part.artifact));
    else if (artifact?.kind === 'film') this.askAnimate(true);
    else this.askInstructions(true);
  }

  // Starts a job. `subject` is the file the job is about; a feedback request does not carry it.
  async startJob(request: JobRequest, subject: string = request.subject[0] ?? '') {
    // One job runs at a time. A second one would take over the job panel and leave the first
    // running out of sight.
    if (this.job?.status === 'running') {
      this.notify('A job is still running. Wait for it to finish, or cancel it in the panel below.');
      this.dockOpen = true;
      return;
    }
    this.dialog = null;
    this.instructionsAsk = null;
    this.animateAsk = null;
    this.composeAsk = null;
    this.job = newJob(request, Date.now(), subject);
    this.dockOpen = true;
    try {
      await api.jobStart(request, (event) => {
        if (!this.job) return;
        this.job = reduceJob(this.job, event, Date.now());
        if (event.type === 'result') this.onJobResult();
      });
    } catch (error) {
      const failure = error as AppError;
      this.job = reduceJob(this.job, { type: 'failed', code: failure.code ?? 'error', message: messageOf(error) }, Date.now());
    }
  }

  // The artifact the last job made, once the job has finished and the artifact is listed.
  jobArtifact = $derived(this.job?.status === 'done' ? this.artifacts.find((a) => a.id === this.job?.artifactId) ?? null : null);
  // True when the artifact the last job made is not the one on screen. The job panel then
  // offers a button that opens it.
  jobResultElsewhere = $derived(!!this.jobArtifact && (this.example !== null || this.tab === 'source' || this.currentArtifact?.id !== this.jobArtifact.id));

  // After a job made a version: reads the artifacts again and shows the new version.
  private async onJobResult() {
    await this.reloadArtifacts();
    await this.showJobResult();
  }

  // Shows the version the last job made, on the tab of its kind: the Film tab for a film, the
  // Visual tab for a visual.
  private async showJobResult() {
    const job = this.job;
    if (!job || job.status !== 'done') return;
    const made = this.artifacts.find((a) => a.id === job.artifactId);
    // A new pipeline is opened wherever the user is, because nothing else shows it. The result
    // of any other job is shown only if the user is still on its file.
    if (made?.kind === 'pipeline' && (job.request.kind === 'compose' || this.selectedPipelineId === made.id)) {
      this.composeSelection = [];
      return this.selectPipeline(made.id);
    }
    if (this.selected !== job.subject) return;
    await this.move(async () => {
      this.tab = made?.kind === 'film' ? 'film' : 'visual';
      this.pickedVersion = null;
      await this.loadDetail();
    });
  }

  // Opens the artifact the last job made, selecting its file if the user has moved to another.
  async openJobResult() {
    if (this.jobArtifact) await this.openArtifact(this.jobArtifact);
  }

  // Starts the film again from an outline the user edited. The running job, if any, is
  // cancelled first: its film would follow the outline the user has just changed.
  async restartWithOutline(outline: Outline, instructions: string) {
    const job = this.job;
    if (!job || job.request.kind !== 'animate') return;
    if (job.status === 'running') {
      await this.cancelJob();
      // The job reports that it has stopped a moment after it was asked to.
      for (let waited = 0; this.job?.status === 'running' && waited < 10000; waited += 100) await new Promise((done) => setTimeout(done, 100));
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

  // Sends the user's feedback about the version on screen as a job that makes a new version.
  // What the user was looking at is attached: the moment of the film, the selected part, the
  // element they pointed at, and a picture of the frame where the app can take one.
  async sendFeedback(text: string) {
    const artifact = this.currentArtifact;
    const version = this.shownVersion;
    if (!artifact || version == null || !text.trim()) return;
    const feedback: Feedback = { text: text.trim(), pointAt: this.picked, selected: this.selectedNode };
    if (showsFilm(artifact) && this.filmMoment) {
      const moment = this.filmMoment;
      // A pinned moment replaces the current one, but the scene's own time is only known for
      // the moment the film is at now.
      const pinned = this.pinnedTime != null && Math.abs(this.pinnedTime - moment.t) > 0.05;
      feedback.time = this.pinnedTime ?? moment.t;
      if (!pinned) Object.assign(feedback, { chapter: moment.chapterTitle, scene: moment.scene, sceneTime: moment.sceneT });
    }
    const rect = this.frameRect?.();
    if (rect) {
      try {
        feedback.screenshot = await api.feedbackCapture({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      } catch {
        // The feedback is still useful without a picture.
      }
    }
    await this.startJob({ kind: 'feedback', subject: [], artifactId: artifact.id, baseVersion: version, feedback }, artifact.kind === 'pipeline' ? PIPELINE_PREFIX + artifact.id : artifact.subject[0]);
  }

  async cancelJob() {
    if (this.job?.jobId && this.job.status === 'running') await api.jobCancel(this.job.jobId);
  }

  async pickVersion(version: number) {
    this.pickedVersion = version === this.currentArtifact?.currentVersion ? null : version;
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
      const base = artifact.kind === 'pipeline' ? artifact.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pipeline'
        : (artifact.subject[0].replace(/\/$/, '').split('/').pop() ?? 'artifact').replace(/\.[^.]+$/, '');
      const name = base + '.' + artifact.kind + '.html';
      const saved = await api.artifactExport(artifact.id, this.shownVersion, name);
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

  // Undoes what a failed job's agent changed outside .codjiva/, where git can.
  async revertViolations() {
    if (!this.job?.violations.length) return;
    try {
      const results = await api.guardRevert(this.job.violations);
      const restored = results.filter((r) => r.reverted).length;
      this.notify(`${restored} of ${results.length} file(s) restored.` + (restored < results.length ? ' ' + results.find((r) => !r.reverted)!.note : ''));
    } catch (error) {
      this.fail(error);
    }
  }

  notify(text: string, kind: Toast['kind'] = 'info') {
    const id = this.nextToast++;
    this.toasts.push({ id, kind, text });
    setTimeout(() => { this.toasts = this.toasts.filter((t) => t.id !== id); }, kind === 'error' ? 8000 : 4000);
  }

  fail(error: unknown) {
    this.notify(messageOf(error), 'error');
  }

  async pickAndOpen() {
    try {
      const path = await api.pickFolder();
      if (path) await this.openWorkspace(path);
    } catch (error) {
      this.fail(error);
    }
  }

  async openWorkspace(path: string) {
    try {
      const info = await api.workspaceOpen(path);
      this.children = {};
      this.expanded = {};
      this.selected = null;
      this.fileInfo = null;
      this.example = null;
      this.tab = 'visual';
      this.workspace = info;
      this.artifacts = [];
      this.detail = null;
      this.pickedVersion = null;
      this.job = null;
      this.dockOpen = false;
      this.places = [];
      this.placeIndex = -1;
      await this.loadDir('');
      await this.reloadArtifacts();
      await this.syncWatched();
      this.recents = await api.workspaceRecent();
    } catch (error) {
      this.fail(error);
    }
  }

  async closeWorkspace() {
    await api.workspaceClose();
    this.workspace = null;
    this.selected = null;
    this.fileInfo = null;
    this.example = null;
    this.places = [];
    this.placeIndex = -1;
    this.recents = await api.workspaceRecent();
  }

  private async loadDir(dir: string) {
    this.children[dir] = await api.treeChildren(dir);
  }

  // Tells the core which folders to watch: the root, every expanded folder, and the folder of
  // every file an artifact was made from, so that an edit to such a file is noticed even when
  // its folder is closed in the tree.
  private async syncWatched() {
    const dirs = new Set<string>(['', ...Object.keys(this.expanded).filter((dir) => this.expanded[dir])]);
    for (const artifact of this.artifacts) for (const source of artifact.sources) dirs.add(parentOf(source));
    if (this.selectedIsFolder && this.selected) dirs.add(this.selected.slice(0, -1));
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

  // Selects a file, expanding the folders above it so its row is visible. `line` scrolls the
  // source viewer to that line and switches to it.
  async selectFile(relPath: string, line?: number) {
    if (relPath.endsWith('/')) return this.selectFolder(relPath);
    await this.move(() => this.showFile(relPath, line));
  }

  // The work of `selectFile` for a path that is a file.
  private async showFile(relPath: string, line?: number) {
    try {
      this.folderInfo = null;
      for (const dir of ancestorsOf(relPath)) {
        if (!this.children[dir]) await this.loadDir(dir);
        this.expanded[dir] = true;
      }
      this.example = null;
      this.selected = relPath;
      this.sourceLine = line ?? null;
      if (line != null) this.tab = 'source';
      // A file that has only a film opens on it, and a file without a film does not stay on
      // the Film tab's empty state when it has a visual.
      else if (this.tab === 'visual' && !this.visualArtifact && this.filmArtifact) this.tab = 'film';
      else if (this.tab === 'film' && !this.filmArtifact && this.visualArtifact) this.tab = 'visual';
      this.pickedVersion = null;
      this.detail = null;
      this.fileInfo = null;
      this.fileInfo = await api.fileInfo(relPath);
      await this.loadDetail();
      await this.syncWatched();
    } catch (error) {
      this.fail(error);
    }
  }

  // Selects a folder, to make or show a visual of the whole folder. A folder has no source
  // view and no film, so the Visual tab is the only one.
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
      this.example = null;
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
    try {
      for (const dir of changes.dirs) {
        if (this.children[dir]) await this.loadDir(dir);
      }
      if (this.selected && changes.paths.includes(this.selected)) {
        const stillThere = (this.children[parentOf(this.selected)] ?? []).some((e) => e.relPath === this.selected);
        if (stillThere) this.fileInfo = await api.fileInfo(this.selected);
        else { this.selected = null; this.fileInfo = null; }
      }
      // A changed source file may have made an artifact stale, or current again.
      if (this.artifacts.some((a) => a.sources.some((source) => changes.paths.includes(source)))) await this.reloadArtifacts();
    } catch {
      // A folder that was deleted while it was being re-read is not worth reporting: the next
      // change event for its parent removes it from the tree.
    }
  }

  async saveSettings(next: Settings) {
    try {
      const before = this.settings;
      this.settings = await api.settingsSet(next);
      // A provider's model and address decide whether it can run jobs, so the lists that show
      // that are read again when either changed.
      if (before && (JSON.stringify(before.models) !== JSON.stringify(next.models) || JSON.stringify(before.apiBaseUrls) !== JSON.stringify(next.apiBaseUrls))) {
        await this.loadApiProviders();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  // Reads the API providers again, and the agent list with them, because each provider is also
  // an entry in that list.
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

  // Makes sure the workspace's .codjiva folder exists, and asks the .gitignore question the
  // first time. `then` runs once the folder is ready and the question, if asked, is answered.
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

  // Records the answer to the .gitignore question. `later` leaves the question open, so it is
  // asked again next time.
  async answerGitignore(answer: 'add' | 'track' | 'later') {
    try {
      if (this.workspace && answer === 'add') this.workspace.store = await api.gitignoreAdd();
      if (this.workspace && answer === 'track') this.workspace.store = await api.gitignoreKeepTracked();
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
      // The panels are hidden either way; a window that cannot go full screen still shows the
      // film as large as the window allows.
    }
  }

  dispose() {
    this.stopWatching?.();
    this.stopValidating?.();
  }
}

export const app = new AppState();
