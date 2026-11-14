// The Api implementation used inside the desktop app: every method calls one Tauri command.

import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { Api, AppInfo, Changes, JobEvent, ValidateRequest } from './types';

let platform = '';

export const tauriApi: Api = {
  async appInfo() {
    const info = await invoke<AppInfo>('app_info');
    platform = info.platform;
    return info;
  },
  async pickFolder() {
    const picked = await open({ directory: true, multiple: false, title: 'Open folder' });
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
  companionsIgnoreCheck: (patterns, paths) => invoke('companions_ignore_check', { patterns, paths }),
  folderInfo: (relPath) => invoke('folder_info', { relPath }),
  composePropose: (artifactIds) => invoke('compose_propose', { artifactIds }),
  feedbackCapture: (rect) => invoke('feedback_capture', { rect }),
  async jobStart(request, onEvent) {
    const channel = new Channel<JobEvent>();
    channel.onmessage = onEvent;
    return invoke<string>('job_start', { request, onEvent: channel });
  },
  jobCancel: (jobId) => invoke('job_cancel', { jobId }),
  jobValidated: (token, report) => invoke('job_validated', { token, report }),
  artifactList: () => invoke('artifact_list'),
  artifactDetail: (id, version) => invoke('artifact_detail', { id, version }),
  artifactSetCurrent: (id, version) => invoke('artifact_set_current', { id, version }),
  artifactDelete: (id) => invoke('artifact_delete', { id }),
  async artifactExport(id, version, suggestedName) {
    const destPath = await save({ title: 'Export HTML', defaultPath: suggestedName, filters: [{ name: 'HTML', extensions: ['html'] }] });
    if (!destPath) return null;
    await invoke('artifact_export', { id, version, destPath });
    return destPath;
  },
  artifactOpenInBrowser: (id, version) => invoke('artifact_open_in_browser', { id, version }),
  artifactReveal: (id, version) => invoke('artifact_reveal', { id, version }),
  guardRevert: (violations) => invoke('guard_revert', { violations }),
  async onValidateRequest(handler) {
    return listen<ValidateRequest>('validate-request', (event) => handler(event.payload));
  },
  async onFsChanged(handler) {
    return listen<Changes>('fs-changed', (event) => handler(event.payload));
  },
  // On Windows a custom scheme is reached through an http address on a reserved host name; on
  // macOS and Linux the scheme is used directly.
  artifactUrl(path) {
    return platform === 'windows' ? `http://codjiva.localhost/${path}` : `codjiva://localhost/${path}`;
  },
};
