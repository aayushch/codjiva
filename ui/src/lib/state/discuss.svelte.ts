// The state of discussions: the questions the user asks about code or about
// a visual of it, and the answers. One instance, `discuss`, is shared by
// every component. The Rust side is `threads.rs`.
//
// A discussion belongs to a target (see `Target` in $lib/discuss): a part
// of a file, or a visual of a whole file. A target can have several
// discussions. One of them is on show, and the user can start another.
//
// Notes. An answer can put notes on the visual that was on screen. The
// frame that shows a visual asks `notesFor` for the notes of its artifact and
// sends them to the visual, which draws them (see VisualFrame.svelte and
// FilmPlayer.svelte). `notesOn` switches all of them on and off.

import {
  api,
  type AppError,
  type ArtifactSummary,
  type AskAbout,
  type AskRequest,
  type ScopeCandidates,
  type Thread,
} from '$lib/ipc';
import { kindWord, PIPELINE_PREFIX } from '$lib/artifacts';
import {
  notesOf,
  scopesOf,
  targetKey,
  threadsOf,
  type FileScope,
  type ShownNote,
  type Target,
} from '$lib/discuss';
import { app } from './app.svelte';

// The question that is waiting for its answer.
//   - `key` is the `targetKey` of the target it was asked about.
//   - `text` is the question.
//   - `agent` is the name of the agent, once it is known, and `continues`
//     whether it continues an earlier conversation.
//   - `activity` is the last thing the agent did, such as reading a file.
//   - `said` is what the agent has written since then.
//   - `notice` is something the user should know, or null.
export type PendingAsk = {
  askId: string;
  key: string;
  text: string;
  agent: string | null;
  continues: boolean;
  activity: string;
  said: string;
  notice: string | null;
};

// Lines the user selected in the source view, with what they can stand for
// and where the bar that offers to discuss or visualise them belongs.
//   - `candidates` holds the selected lines as a scope, and the definition
//     around them when there is one.
//   - `useSymbol` is true while the bar acts on that definition and not on
//     the lines.
//   - `x` and `y` are a point of the window, in pixels, near the end of the
//     selection.
export type SourceSelection = {
  path: string;
  candidates: ScopeCandidates;
  useSymbol: boolean;
  x: number;
  y: number;
};

// Stands for "a discussion that has not been started yet" where the id of a
// discussion is expected.
const NEW = 'new';

class DiscussState {
  // Every discussion of the open workspace, the one that was added to last
  // first.
  threads = $state<Thread[]>([]);
  // The question that is waiting for its answer, or null. One question is
  // asked at a time.
  pending = $state<PendingAsk | null>(null);
  // Whether visuals show the notes that answers put on them.
  notesOn = $state(true);
  // The id of the note the user clicked last, on a visual or in a list, or
  // null. The list of an answer draws that note as chosen.
  focusNote = $state<string | null>(null);
  // What the user has typed and not yet asked, by `targetKey`.
  drafts = $state<Record<string, string>>({});
  // The lines selected in the source view, or null.
  selection = $state<SourceSelection | null>(null);
  // The id of the artifact that is being built again with the current
  // runtime, or null.
  updating = $state<string | null>(null);
  // Which discussion each target shows, by `targetKey`: the id of a
  // discussion, or `NEW`. A target that is not listed shows its newest
  // discussion.
  private chosen = $state<Record<string, string>>({});
  // Counts the questions asked, to give each an id of its own.
  private asked = 0;
  // Counts the selections made, so that a slow answer about an old selection
  // cannot replace the answer about a newer one.
  private selections = 0;

  // Reads the discussions of the open workspace again. App.svelte calls it
  // when a workspace is opened and when the file on screen changes on disk,
  // because a discussion about a part of a file says where that part is now.
  async reload() {
    if (!app.workspace) {
      this.threads = [];
      this.pending = null;
      this.selection = null;
      return;
    }
    try {
      this.threads = await api.threadList();
    } catch (error) {
      app.fail(error);
    }
  }

  threadsFor(target: Target): Thread[] {
    return threadsOf(this.threads, target);
  }

  // The discussion that `target` shows: the one the user chose, or its
  // newest one. Null while the user is starting a new one, and for a target
  // without a discussion.
  shown(target: Target): Thread | null {
    const all = this.threadsFor(target);
    const pick = this.chosen[targetKey(target)];
    if (pick === NEW) return null;
    return all.find((one) => one.id === pick) ?? all[0] ?? null;
  }

  choose(target: Target, id: string) {
    this.chosen[targetKey(target)] = id;
  }

  // Makes the next question about `target` start a new discussion.
  startNew(target: Target) {
    this.chosen[targetKey(target)] = NEW;
  }

  // The notes on the artifact with the id `artifactId`, numbered.
  notesFor(artifactId: string): ShownNote[] {
    return notesOf(this.threads, artifactId);
  }

  // The parts of the file at `path` that have a discussion or a visual.
  scopesIn(path: string): FileScope[] {
    return scopesOf(this.threads, app.artifacts, path);
  }

  // Asks `text` about `target`, in the discussion the target shows or in a
  // new one. `about` says what the user was looking at: the part that was
  // selected, or the moment of a film.
  //
  // The question is asked once the workspace's .codjiva folder is ready,
  // which can mean that the .gitignore question is answered first. The text
  // is taken out of the target's draft when the question starts, and put
  // back if the question fails, so that the user can ask again.
  ask(target: Target, text: string, about: AskAbout = {}) {
    const words = text.trim();
    if (!words || this.pending) return;
    app.withStore(() => this.run(target, words, about));
  }

  private async run(target: Target, words: string, about: AskAbout) {
    if (this.pending) return;
    const key = targetKey(target);
    const thread = this.shown(target);
    const askId = `ask-${Date.now()}-${++this.asked}`;
    const request: AskRequest = {
      threadId: thread?.id,
      path: target.path,
      scope: thread
        ? undefined
        : (target.scope ?? target.artifact?.scope ?? undefined),
      text: words,
      about: {
        ...about,
        artifactId: target.artifact?.id,
        version: target.version ?? undefined,
      },
    };
    this.pending = {
      askId,
      key,
      text: words,
      agent: null,
      continues: false,
      activity: '',
      said: '',
      notice: null,
    };
    this.drafts[key] = '';
    const mine = () => (this.pending?.askId === askId ? this.pending : null);
    try {
      const made = await api.threadAsk(request, askId, (event) => {
        const pending = mine();
        if (!pending) return;
        if (event.type === 'started') {
          pending.agent = event.agent;
          pending.continues = event.continues;
        } else if (event.type === 'tool') {
          pending.activity = `${event.name} ${event.summary}`.trim();
          pending.said = '';
        } else if (event.type === 'text') pending.said = event.text;
        else pending.notice = event.text;
      });
      this.threads = [
        made,
        ...this.threads.filter((one) => one.id !== made.id),
      ];
      this.chosen[key] = made.id;
      // An answer that adds notes is of no use while notes are hidden.
      if (made.messages.at(-1)?.notes?.length) this.notesOn = true;
    } catch (error) {
      if ((error as AppError).code !== 'cancelled') app.fail(error);
      if (!this.drafts[key]) this.drafts[key] = words;
    } finally {
      if (mine()) this.pending = null;
    }
  }

  // Stops the question that is waiting for its answer.
  cancel() {
    if (this.pending) api.jobCancel(this.pending.askId).catch(() => {});
  }

  // Deletes a discussion, and with it the notes its answers put on visuals.
  async deleteThread(id: string) {
    try {
      await api.threadDelete(id);
      this.threads = this.threads.filter((one) => one.id !== id);
    } catch (error) {
      app.fail(error);
    }
  }

  // Builds the version `version` of `artifact` again with the runtime of
  // this app, so that it can show notes. The new version is then the one on
  // show. Nothing changes when the new page does not pass its checks, and
  // the user is told why.
  async update(artifact: ArtifactSummary, version: number) {
    if (this.updating) return;
    this.updating = artifact.id;
    try {
      const made = await api.artifactRebuild(artifact.id, version);
      await app.reloadArtifacts();
      if (app.currentArtifact?.id === artifact.id) {
        app.pickedVersion = null;
        await app.loadDetail();
      }
      app.notify(`Updated the ${kindWord(artifact)} to version ${made}.`);
    } catch (error) {
      app.fail(error);
    } finally {
      this.updating = null;
    }
  }

  // Starts a job that changes `artifact` according to the discussion
  // `thread`: a new version is made from the version `version`, by an agent
  // that knows what was said.
  apply(artifact: ArtifactSummary, version: number, thread: Thread) {
    const question =
      [...thread.messages].reverse().find((one) => one.role === 'user')?.text ??
      '';
    return app.startJob(
      {
        kind: 'feedback',
        subject: [],
        artifactId: artifact.id,
        baseVersion: version,
        feedback: {
          text:
            `Change the ${kindWord(artifact)} so that it shows what our ` +
            `discussion found about this question: ${question}`,
        },
        thread: thread.id,
      },
      artifact.kind === 'pipeline'
        ? PIPELINE_PREFIX + artifact.id
        : artifact.subject[0],
    );
  }

  // Works out what lines `startLine` to `endLine` of the file at `path` can
  // stand for, and makes them the selection, so that the source view shows
  // the bar that offers to discuss or visualise them. `x` and `y` are where
  // that bar belongs. A selection of blank lines is no selection.
  async select(
    path: string,
    startLine: number,
    endLine: number,
    x: number,
    y: number,
  ) {
    const mine = ++this.selections;
    try {
      const candidates = await api.scopeForSelection(path, startLine, endLine);
      if (mine !== this.selections) return;
      this.selection = {
        path,
        candidates,
        useSymbol: candidates.exact,
        x,
        y,
      };
    } catch {
      if (mine === this.selections) this.selection = null;
    }
  }

  clearSelection() {
    this.selections++;
    this.selection = null;
  }
}

export const discuss = new DiscussState();
