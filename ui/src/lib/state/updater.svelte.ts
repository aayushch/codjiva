// Updates of the app itself. One instance, `updater`, is shared by the title
// bar and the Settings dialog.
//
// The app asks the latest release on GitHub whether it is newer than the
// version that is running. If it is, the user is offered the update. When
// they accept, the app downloads the installer for this system, checks its
// signature against the public key in tauri.conf.json, and installs it. The
// new version runs after a restart.
//
// `status` says where this is:
//   - 'idle': no newer version is known.
//   - 'checking': the release is being asked.
//   - 'available': a newer version exists and waits for the user.
//   - 'downloading': the update is being downloaded and installed.
//   - 'ready': the update is installed and the app must be restarted.
//   - 'error': the last check or the last download failed. `error` says why.

import { api } from '$lib/ipc';
import { app } from '$lib/state/app.svelte';

export type UpdateStatus =
  'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

// The app looks for an update this long after it starts, so that starting is
// not slowed down, and then at this interval while it stays open.
const FIRST_CHECK_AFTER_MS = 5000;
const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;

class UpdaterState {
  status = $state<UpdateStatus>('idle');
  // The newer version on offer, and the text of its release. Both stay set
  // while the update is downloaded and installed.
  version = $state<string | null>(null);
  notes = $state<string | null>(null);
  // How much of the download has arrived, from 0 to 100.
  progress = $state(0);
  error = $state<string | null>(null);
  // When the release was last asked, as a time in milliseconds.
  lastCheckedAt = $state<number | null>(null);
  // True after the user closed the notice in the title bar. A check that
  // finds a different version shows the notice again.
  dismissed = $state(false);

  private firstCheck: ReturnType<typeof setTimeout> | undefined;
  private laterChecks: ReturnType<typeof setInterval> | undefined;

  // The title bar shows its notice while an update waits, is being
  // installed, is ready, or has failed to install.
  noticeShown = $derived(
    !this.dismissed &&
      (this.status === 'available' ||
        this.status === 'downloading' ||
        this.status === 'ready' ||
        (this.status === 'error' && this.version !== null)),
  );

  // Starts the checks the app makes by itself. Each one is skipped while the
  // setting "Look for updates automatically" is off.
  start() {
    this.stop();
    const checkIfWanted = () => {
      if (app.settings?.checkForUpdates) void this.check();
    };
    this.firstCheck = setTimeout(() => {
      checkIfWanted();
      this.laterChecks = setInterval(checkIfWanted, CHECK_EVERY_MS);
    }, FIRST_CHECK_AFTER_MS);
  }

  stop() {
    clearTimeout(this.firstCheck);
    clearInterval(this.laterChecks);
  }

  // Asks the latest release whether it is newer. Returns true if the release
  // could be asked, whether or not it is newer. A check does nothing while
  // an update is being installed or waits for a restart.
  async check(): Promise<boolean> {
    if (this.status === 'downloading' || this.status === 'ready') return true;
    this.status = 'checking';
    this.error = null;
    try {
      const found = await api.updateCheck();
      this.lastCheckedAt = Date.now();
      if (found && found.version !== this.version) this.dismissed = false;
      this.version = found?.version ?? null;
      this.notes = found?.notes ?? null;
      this.status = found ? 'available' : 'idle';
      return true;
    } catch (error) {
      this.lastCheckedAt = Date.now();
      this.version = null;
      this.status = 'error';
      this.error = messageOf(error);
      return false;
    }
  }

  // Downloads and installs the version on offer.
  async install() {
    if (!this.version || this.status === 'downloading') return;
    this.status = 'downloading';
    this.progress = 0;
    this.error = null;
    try {
      await api.updateInstall((percent) => {
        this.progress = percent;
      });
      this.status = 'ready';
    } catch (error) {
      this.status = 'error';
      this.error = messageOf(error);
    }
  }

  // Restarts the app, which then runs the installed update.
  async relaunch() {
    try {
      await api.relaunch();
    } catch (error) {
      this.error = messageOf(error);
    }
  }
}

// The text of something that was thrown, which can be an Error, a string
// from the Tauri plugin, or an object with a `message`.
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : 'The update failed.';
}

export const updater = new UpdaterState();
