// The state of the diff view: the changes of the file on screen, and which
// of them is shown. One instance, `diffs`, is shared by the components that
// need it. DiffView.svelte reads the list from git and draws the change.
// The toolbar holds the list of changes and the buttons that step through
// it. The Rust side is `git_diff.rs`.
//
// What is compared. Each entry of the list carries two versions of the
// file (`old` and `new` of `GitChange`): the file before that change and the
// file after it.
//   - While `base` is null, the diff view compares these two versions of
//     the change on screen.
//   - While `base` names an older change of the list, the diff view
//     compares the file after that older change with the file after the
//     change on screen. `compare` starts such a comparison and `pick` ends
//     it.
// `sides` gives the two versions for both cases.

import { api, type GitChange, type GitSide } from '$lib/ipc';
import { changeKey, sidesOf } from '$lib/diff';

class DiffState {
  // The file whose changes are listed, by its path inside the workspace.
  path = $state<string | null>(null);
  // The changes of that file, newest first, and whether the file has more
  // commits than the list holds.
  changes = $state.raw<GitChange[]>([]);
  more = $state(false);
  // The position in `changes` of the change on screen.
  index = $state(0);
  // The `changeKey` of the older change whose version the change on screen
  // is compared with, or null while the change on screen is compared with
  // the version before it.
  base = $state<string | null>(null);
  // False from the moment another file is asked for until git has answered.
  loaded = $state(false);
  // Why the list could not be read, or null.
  problem = $state<string | null>(null);

  // For each file, the `changeKey` of the change that was last on screen.
  // The same change is shown when the user comes back to the file.
  private chosen = new Map<string, string>();
  // For each file that was last shown as a comparison of two versions, the
  // value `base` had. The same comparison is shown when the user comes back
  // to the file.
  private bases = new Map<string, string>();
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
  // The position in `changes` of the change that `base` names, or -1 while
  // `base` is null. It is also -1 when that change is not in the list, or
  // is not older than the change on screen.
  get baseIndex(): number {
    if (this.base == null) return -1;
    const at = this.changes.findIndex(
      (change) => changeKey(change) === this.base,
    );
    return at > this.index ? at : -1;
  }
  // The change that `base` names, or null.
  get baseChange(): GitChange | null {
    return this.changes[this.baseIndex] ?? null;
  }
  // The two versions the diff view compares, or null when the file has no
  // change.
  get sides(): { old: GitSide | null; new: GitSide } | null {
    const change = this.change;
    return change ? sidesOf(change, this.baseChange) : null;
  }
  // True when `older`, or `newer`, has a change to go to. While two
  // versions are compared, the change on screen stays newer than the
  // change that `base` names.
  get hasOlder(): boolean {
    const end = this.baseIndex < 0 ? this.changes.length : this.baseIndex;
    return this.index < end - 1;
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
      this.base = null;
      this.loaded = false;
    }
    this.problem = null;
    try {
      const history = await api.gitFileHistory(path);
      if (ticket !== this.asked) return;
      const changes = history?.changes ?? [];
      const wanted = this.wanted.get(path);
      const key = wanted ?? this.chosen.get(path);
      this.wanted.delete(path);
      const at = changes.findIndex((change) => changeKey(change) === key);
      this.changes = changes;
      this.more = history?.more ?? false;
      this.index = Math.max(0, at);
      // A commit that `want` asked for is compared with the version before
      // it. Otherwise the file is compared as it last was.
      this.base = wanted == null ? (this.bases.get(path) ?? null) : null;
      if (this.baseIndex < 0) this.base = null;
      this.loaded = true;
      this.remember();
    } catch (error: any) {
      if (ticket !== this.asked) return;
      this.problem = error?.message ?? String(error);
      this.loaded = true;
    }
  }

  // Shows the change at position `index` of the list, compared with the
  // version before it. This ends a comparison of two versions.
  pick(index: number) {
    if (index < 0 || index >= this.changes.length) return;
    this.index = index;
    this.base = null;
    this.remember();
  }
  // Compares the versions of the changes at positions `one` and `other` of
  // the list. The older of the two is always the old version of the
  // comparison, whichever of them is given first.
  compare(one: number, other: number) {
    const last = this.changes.length - 1;
    if (
      one === other ||
      Math.min(one, other) < 0 ||
      Math.max(one, other) > last
    )
      return;
    this.index = Math.min(one, other);
    this.base = changeKey(this.changes[Math.max(one, other)]);
    this.remember();
  }
  // Shows the change before the one on screen, and the change after it.
  // While two versions are compared, the older version stays the same and
  // only the newer one is replaced.
  older() {
    if (this.hasOlder) this.step(this.index + 1);
  }
  newer() {
    if (this.hasNewer) this.step(this.index - 1);
  }
  private step(index: number) {
    this.index = index;
    this.remember();
  }

  private remember() {
    const change = this.change;
    if (!this.path || !change) return;
    this.chosen.set(this.path, changeKey(change));
    if (this.base != null && this.baseIndex >= 0)
      this.bases.set(this.path, this.base);
    else this.bases.delete(this.path);
  }

  // Forgets everything. Called when another folder is opened.
  reset() {
    this.asked++;
    this.path = null;
    this.changes = [];
    this.more = false;
    this.index = 0;
    this.base = null;
    this.loaded = false;
    this.problem = null;
    this.chosen.clear();
    this.bases.clear();
    this.wanted.clear();
  }
}

export const diffs = new DiffState();
