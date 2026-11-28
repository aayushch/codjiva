// The state of the diff view: the changes of the file on screen, and which
// of them is shown. One instance, `diffs`, is shared by the components that
// need it. DiffView.svelte reads the list from git and draws the change.
// The toolbar holds the list of changes and the buttons that step through
// it. The Rust side is `git_diff.rs`.
//
// A change is compared with the version before it. Each entry of the list
// carries both versions (`old` and `new` of `GitChange`), so nothing here
// depends on the two versions being next to each other in the history.

import { api, type GitChange } from '$lib/ipc';
import { changeKey } from '$lib/diff';

class DiffState {
  // The file whose changes are listed, by its path inside the workspace.
  path = $state<string | null>(null);
  // The changes of that file, newest first, and whether the file has more
  // commits than the list holds.
  changes = $state.raw<GitChange[]>([]);
  more = $state(false);
  // The position in `changes` of the change on screen.
  index = $state(0);
  // False from the moment another file is asked for until git has answered.
  loaded = $state(false);
  // Why the list could not be read, or null.
  problem = $state<string | null>(null);

  // For each file, the `changeKey` of the change that was last on screen.
  // The same change is shown when the user comes back to the file.
  private chosen = new Map<string, string>();
  // For each file, the hash of a commit that should be shown the next time
  // the list of the file is read. `want` sets it.
  private wanted = new Map<string, string>();
  // Counts the calls of `load`, so that an answer for an earlier call is
  // dropped.
  private asked = 0;

  // The change on screen, or null when the file has none.
  get change(): GitChange | null {
    return this.changes[this.index] ?? null;
  }
  // True when the list has a change older, or newer, than the one on
  // screen.
  get hasOlder(): boolean {
    return this.index < this.changes.length - 1;
  }
  get hasNewer(): boolean {
    return this.index > 0;
  }

  // Asks for the commit with the hash `commit` to be the change on screen
  // when the list of the file at `path` is next read.
  want(path: string, commit: string) {
    this.wanted.set(path, commit);
  }

  // Reads the changes of the file at `path` from git.
  //   - For another file than the one listed, the list is emptied first.
  //   - For the same file, the list stays on screen until the new one
  //     arrives, and the change on screen stays the same one if the new
  //     list still has it.
  async load(path: string) {
    const ticket = ++this.asked;
    if (path !== this.path) {
      this.path = path;
      this.changes = [];
      this.more = false;
      this.index = 0;
      this.loaded = false;
    }
    this.problem = null;
    try {
      const history = await api.gitFileHistory(path);
      if (ticket !== this.asked) return;
      const changes = history?.changes ?? [];
      const key = this.wanted.get(path) ?? this.chosen.get(path);
      this.wanted.delete(path);
      const at = changes.findIndex((change) => changeKey(change) === key);
      this.changes = changes;
      this.more = history?.more ?? false;
      this.index = Math.max(0, at);
      this.loaded = true;
      this.remember();
    } catch (error: any) {
      if (ticket !== this.asked) return;
      this.problem = error?.message ?? String(error);
      this.loaded = true;
    }
  }

  // Shows the change at position `index` of the list.
  pick(index: number) {
    if (index < 0 || index >= this.changes.length) return;
    this.index = index;
    this.remember();
  }
  // Shows the change before the one on screen, and the change after it.
  older() {
    this.pick(this.index + 1);
  }
  newer() {
    this.pick(this.index - 1);
  }

  private remember() {
    const change = this.change;
    if (this.path && change) this.chosen.set(this.path, changeKey(change));
  }

  // Forgets everything. Called when another folder is opened.
  reset() {
    this.asked++;
    this.path = null;
    this.changes = [];
    this.more = false;
    this.index = 0;
    this.loaded = false;
    this.problem = null;
    this.chosen.clear();
    this.wanted.clear();
  }
}

export const diffs = new DiffState();
