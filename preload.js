'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The entire surface the note's UI can touch.
 *
 * Deliberately narrow: there is no channel that returns the Canvas access
 * token, and no generic "invoke anything" escape hatch. The renderer only ever
 * receives already-shaped task data.
 */
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  refresh: () => ipcRenderer.invoke('refresh'),

  saveSettings: (baseUrl, token) => ipcRenderer.invoke('save-settings', { baseUrl, token }),
  signOut: () => ipcRenderer.invoke('sign-out'),

  setLaunchOnLogin: (enabled) => ipcRenderer.invoke('set-launch-on-login', enabled),
  setCourseFilter: (courseId) => ipcRenderer.invoke('set-course-filter', courseId),
  setFavoritesOnly: (enabled) => ipcRenderer.invoke('set-favorites-only', enabled),

  saveGeminiKey: (key) => ipcRenderer.invoke('save-gemini-key', key),
  removeGeminiKey: () => ipcRenderer.invoke('remove-gemini-key'),

  // `history` is plain {role, text} conversation turns — never persisted,
  // held in the renderer's own memory only for this window session.
  sendChatMessage: (history, message) => ipcRenderer.invoke('chat-send', { history, message }),

  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  hideWindow: () => ipcRenderer.send('hide-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  toggleMaximize: () => ipcRenderer.send('toggle-maximize'),
  quit: () => ipcRenderer.send('quit-app'),

  // null goes back to following the OS light/dark setting.
  setThemeOverride: (mode) => ipcRenderer.invoke('set-theme-override', mode),

  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },

  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => ipcRenderer.removeListener('open-settings', handler);
  },

  // Fired every time the note is shown (fresh launch or un-hidden from
  // tray), so the renderer can drop any in-memory chat conversation.
  onResetChat: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('reset-chat', handler);
    return () => ipcRenderer.removeListener('reset-chat', handler);
  },
});
