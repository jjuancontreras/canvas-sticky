'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

/**
 * Persistent config + task cache.
 *
 * Everything lives in Electron's userData dir (%APPDATA%\canvas-sticky on
 * Windows), deliberately outside the project folder so a token can never be
 * picked up by git. The token itself is encrypted with safeStorage, which on
 * Windows is DPAPI keyed to the logged-in user account.
 */

const CONFIG_FILE = 'config.json';
const CACHE_FILE = 'cache.json';
const AI_CACHE_FILE = 'ai-cache.json';

const DEFAULT_CONFIG = Object.freeze({
  baseUrl: '',
  encryptedToken: null,
  tokenIsPlaintext: false,
  userName: '',
  launchOnLogin: false,
  windowBounds: null,
  courseFilter: 'all',
  favoritesOnly: true,
  encryptedGeminiKey: null,
  geminiKeyIsPlaintext: false,
  geminiUsage: null, // { date: 'YYYY-MM-DD', count } — local estimate only, see gemini-client.js
  themeOverride: null, // 'light' | 'dark' | null (null = follow the OS setting)
});

const readJson = (file, fallback) => {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), file), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeJson = (file, value) => {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  // Write-then-rename so a crash mid-write cannot leave a truncated config.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
};

const loadConfig = () => ({ ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}) });

/** Persist a partial config patch, leaving untouched keys alone. */
const saveConfig = (patch) => {
  const next = { ...loadConfig(), ...patch };
  writeJson(CONFIG_FILE, next);
  return next;
};

/**
 * Encrypt-and-store one secret under a pair of config keys, e.g.
 * ('encryptedToken', 'tokenIsPlaintext'). Falls back to plaintext only if the
 * OS refuses to provide an encryption backend, and flags that fact so the UI
 * can warn instead of silently downgrading the user's security.
 */
const saveSecret = (encryptedKey, plaintextFlagKey, secret) => {
  if (!secret) return saveConfig({ [encryptedKey]: null, [plaintextFlagKey]: false });

  if (safeStorage.isEncryptionAvailable()) {
    return saveConfig({
      [encryptedKey]: safeStorage.encryptString(secret).toString('base64'),
      [plaintextFlagKey]: false,
    });
  }
  return saveConfig({ [encryptedKey]: secret, [plaintextFlagKey]: true });
};

/** Returns the decrypted secret, or '' when none is stored or it can't be read. */
const loadSecret = (encryptedKey, plaintextFlagKey) => {
  const config = loadConfig();
  const encrypted = config[encryptedKey];
  if (!encrypted) return '';
  if (config[plaintextFlagKey]) return encrypted;

  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    // Happens if the Windows user profile changed or the config was copied
    // from another machine. Treat as "no secret" so the UI prompts for a new one.
    return '';
  }
};

const saveToken = (token) => saveSecret('encryptedToken', 'tokenIsPlaintext', token);
const loadToken = () => loadSecret('encryptedToken', 'tokenIsPlaintext');
const hasToken = () => Boolean(loadConfig().encryptedToken);

const saveGeminiKey = (key) => saveSecret('encryptedGeminiKey', 'geminiKeyIsPlaintext', key);
const loadGeminiKey = () => loadSecret('encryptedGeminiKey', 'geminiKeyIsPlaintext');
const hasGeminiKey = () => Boolean(loadConfig().encryptedGeminiKey);

const isEncryptionAvailable = () => safeStorage.isEncryptionAvailable();

const loadCache = () =>
  readJson(CACHE_FILE, {
    tasks: [], courses: [], grades: {}, modules: [], announcements: [],
    // { [courseId]: { url, dataUrl } } — the source url is kept alongside the
    // inlined image so a refresh only re-downloads a course's banner when
    // Canvas actually changes it, not on every 15-minute poll.
    courseImages: {},
    fetchedAt: null,
  });

const saveCache = (payload) => writeJson(CACHE_FILE, payload);

/** { [taskId]: { hash, summary, aiAt } } — lets AI summaries survive restarts and skip re-summarizing unchanged work. */
const loadAiCache = () => readJson(AI_CACHE_FILE, {});

const saveAiCache = (payload) => writeJson(AI_CACHE_FILE, payload);

/** Removes Canvas credentials only — window position, Gemini key, and other prefs are untouched. */
const clearCanvasCredentials = () => {
  saveConfig({ baseUrl: '', encryptedToken: null, tokenIsPlaintext: false, userName: '' });
  // stale data from the old account
  saveCache({ tasks: [], courses: [], grades: {}, modules: [], announcements: [], courseImages: {}, fetchedAt: null });
};

const clearGeminiKey = () => saveConfig({ encryptedGeminiKey: null, geminiKeyIsPlaintext: false });

module.exports = {
  loadConfig,
  saveConfig,
  saveToken,
  loadToken,
  hasToken,
  saveGeminiKey,
  loadGeminiKey,
  hasGeminiKey,
  isEncryptionAvailable,
  loadCache,
  saveCache,
  loadAiCache,
  saveAiCache,
  clearCanvasCredentials,
  clearGeminiKey,
};
