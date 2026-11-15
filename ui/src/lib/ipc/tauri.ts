// The Api implementation used inside the desktop app: every method calls one
// Tauri command.

import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Api, AppInfo, Changes, JobEvent, ValidateRequest } from './types';
import type { Update } from '@tauri-apps/plugin-updater';

let platform = '';
// The update the last `updateCheck` found, which `updateInstall` installs.
let foundUpdate: Update | null = null;
const RELEASES = 'https://github.com/aayushch/codjiva/releases/latest';

export const tauriApi: Api = {
  async appInfo() {
    const info = await invoke<AppInfo>('app_info');
    platform = info.platform;
    return info;
  },
  async pickFolder() {
    const picked = await open({
      directory: true,
      multiple: false,
      title: 'Open folder',
    });
    return typeof picked === 'string' ? picked : null;
  },
  workspaceOpen: (path) => invoke('workspace_open', { path }),
  workspaceClose: () => invoke('workspace_close'),
  workspaceRecent: () => invoke('workspace_recent'),
  treeChildren: (relPath) => invoke('tree_children', { relPath }),
  fileInfo: (relPath) => invoke('file_info', { relPath }),
  fileRead: (relPath) => invoke('file_read', { relPath }),
  filesSearch: (query, limit) => invoke('files_search', { query, limit }),
  watchDirs: (dirs) => invoke('watch_dirs', { dirs }),
  storeEnsure: () => invoke('store_ensure'),
  gitignoreAdd: () => invoke('gitignore_add'),
  gitignoreKeepTracked: () => invoke('gitignore_keep_tracked'),
  settingsGet: () => invoke('settings_get'),
  settingsSet: (settings) => invoke('settings_set', { settings }),
  openExternal: (relPath, line) => invoke('open_external', { relPath, line }),
  reveal: (relPath) => invoke('reveal', { relPath }),
  setFullscreen: (on) => getCurrentWindow().setFullscreen(on),
  setWindowTheme: (theme) => getCurrentWindow().setTheme(theme),
  agentsDetect: (refresh) => invoke('agents_detect', { refresh }),
  apiProviders: () => invoke('api_providers'),
  apiKeySet: (providerId, key) => invoke('api_key_set', { providerId, key }),
  apiKeyClear: (providerId) => invoke('api_key_clear', { providerId }),
  apiCheck: (providerId) => invoke('api_check', { providerId }),
  companionsSuggest: (relPath) => invoke('companions_suggest', { relPath }),
  companionsIgnoreCheck: (patterns, paths) =>
    invoke('companions_ignore_check', { patterns, paths }),
  folderInfo: (relPath) => invoke('folder_info', { relPath }),
  composePropose: (artifactIds) => invoke('compose_propose', { artifactIds }),
  feedbackCapture: (rect) => invoke('feedback_capture', { rect }),
  async jobStart(request, onEvent) {
    const channel = new Channel<JobEvent>();
    channel.onmessage = onEvent;
    return invoke<string>('job_start', { request, onEvent: channel });
  },
  jobEstimate: (request) => invoke('job_estimate', { request }),
  jobCancel: (jobId) => invoke('job_cancel', { jobId }),
  jobValidated: (token, report) => invoke('job_validated', { token, report }),
  artifactList: () => invoke('artifact_list'),
  artifactDetail: (id, version) => invoke('artifact_detail', { id, version }),
  artifactSetCurrent: (id, version) =>
    invoke('artifact_set_current', { id, version }),
  artifactDelete: (id) => invoke('artifact_delete', { id }),
  async artifactExport(id, version, suggestedName) {
    const destPath = await save({
      title: 'Export HTML',
      defaultPath: suggestedName,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (!destPath) return null;
    await invoke('artifact_export', { id, version, destPath });
    return destPath;
  },
  artifactOpenInBrowser: (id, version) =>
    invoke('artifact_open_in_browser', { id, version }),
  artifactReveal: (id, version) => invoke('artifact_reveal', { id, version }),
  guardRevert: (violations) => invoke('guard_revert', { violations }),
  async onValidateRequest(handler) {
    return listen<ValidateRequest>('validate-request', (event) =>
      handler(event.payload),
    );
  },
  async onFsChanged(handler) {
    return listen<Changes>('fs-changed', (event) => handler(event.payload));
  },
  // On Windows a custom scheme is reached through an http address on a reserved
  // host name; on macOS and Linux the scheme is used directly.
  artifactUrl(path) {
    return platform === 'windows'
      ? `http://codjiva.localhost/${path}`
      : `codjiva://localhost/${path}`;
  },
  // The updater and the two plugins below are loaded when they are first
  // needed, so they are not part of the app's start-up.
  async updateCheck() {
    const { check } = await import('@tauri-apps/plugin-updater');
    foundUpdate = await check();
    if (!foundUpdate) return null;
    return { version: foundUpdate.version, notes: foundUpdate.body ?? null };
  },
  async updateInstall(onProgress) {
    if (!foundUpdate) throw new Error('There is no update to install.');
    let total = 0;
    let received = 0;
    await foundUpdate.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        received += event.data.chunkLength;
        if (total > 0) {
          onProgress(Math.min(100, Math.round((received / total) * 100)));
        }
      } else if (event.event === 'Finished') {
        onProgress(100);
      }
    });
  },
  async relaunch() {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  },
  async openReleases() {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(RELEASES);
  },
};
