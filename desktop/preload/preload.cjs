'use strict';
// Tailor Browser — preload for the Tailor UI renderer.
//
// Narrow IPC only (Phase 7). There is deliberately NO executeArbitraryJavaScript,
// no filesystem, no process spawn, no database access. Plan data is validated in main.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = Object.freeze({
  createSession: 'browser:createSession',
  runFill: 'browser:runFill',
  resumeAfterCheckpoint: 'browser:resume',
  getState: 'browser:getState',
  show: 'browser:show',
  setVisibility: 'browser:setVisibility',
  hide: 'browser:hide',
  close: 'browser:close',
  windowAction: 'browser:windowAction',
  focusSession: 'browser:focusSession',
});

contextBridge.exposeInMainWorld('tailorBrowser', {
  version: 1,
  transport: 'tailor_browser',
  available: true,
  createSession: (userId) => ipcRenderer.invoke(INVOKE_CHANNELS.createSession, String(userId || '').slice(0, 64)),
  runFill: (payload) => ipcRenderer.invoke(INVOKE_CHANNELS.runFill, payload),
  resumeAfterCheckpoint: () => ipcRenderer.invoke(INVOKE_CHANNELS.resumeAfterCheckpoint),
  getState: () => ipcRenderer.invoke(INVOKE_CHANNELS.getState),
  show: () => ipcRenderer.invoke(INVOKE_CHANNELS.show),
  setVisibility: (visible) => ipcRenderer.invoke(INVOKE_CHANNELS.setVisibility, visible === true),
  hide: () => ipcRenderer.invoke(INVOKE_CHANNELS.hide),
  close: () => ipcRenderer.invoke(INVOKE_CHANNELS.close),
  windowAction: (action) => ipcRenderer.invoke(INVOKE_CHANNELS.windowAction, action === 'close' ? 'close' : 'hide'),
  focusSession: (executionId) => ipcRenderer.invoke(INVOKE_CHANNELS.focusSession, String(executionId || '').slice(0, 80)),
  onEvent: (cb) => {
    const listener = (_event, payload) => {
      try {
        cb(payload);
      } catch {
        /* UI observers must never break execution */
      }
    };
    ipcRenderer.on('browser:event', listener);
    return () => ipcRenderer.removeListener('browser:event', listener);
  },
});
