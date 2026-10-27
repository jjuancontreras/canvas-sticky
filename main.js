'use strict';

const path = require('node:path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, shell, globalShortcut, nativeImage, nativeTheme,
} = require('electron');

const store = require('./src/store');
const canvas = require('./src/canvas');
const { buildTaskList } = require('./src/tasks');
const { applyAiSummaries } = require('./src/ai-summarize');
const { sendChatMessage } = require('./src/chat');
const { getUsage } = require('./src/gemini-client');

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const TOGGLE_SHORTCUT = 'CommandOrControl+Shift+C';
const DEFAULT_BOUNDS = { width: 360, height: 540 };
const MIN_SIZE = { width: 300, height: 260 };

let mainWindow = null;
let tray = null;
let refreshTimer = null;
let isQuitting = false;
/** 'light' | 'dark' | null — null means "follow the OS setting" (the default until the user clicks the toggle). */
let themeOverride = null;
const computeIsDark = () => (themeOverride ? themeOverride === 'dark' : nativeTheme.shouldUseDarkColors);

/** Everything the renderer is allowed to know. Note: never the token itself. */
let state = {
  configured: false,
  baseUrl: '',
  userName: '',
  hasToken: false,
  encryptionAvailable: true,
  launchOnLogin: false,
  courseFilter: 'all',
  favoritesOnly: true,
  usedFavoritesFallback: false,
  hasGeminiKey: false,
  aiError: null,
  isDarkMode: nativeTheme.shouldUseDarkColors,
  themeOverride: null,
  tasks: [],
  courses: [],
  grades: {},
  modules: [],
  announcements: [],
  courseImages: {},
  courseColors: {},
  geminiUsage: { used: 0, limit: 1000 },
  fetchedAt: null,
  loading: false,
  error: null,
};

const publish = () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state', state);
  }
};

const setState = (patch) => {
  state = { ...state, ...patch };
  publish();
};

const hydrateFromDisk = () => {
  const config = store.loadConfig();
  const cache = store.loadCache();

  themeOverride = config.themeOverride === 'dark' || config.themeOverride === 'light' ? config.themeOverride : null;

  state = {
    ...state,
    configured: Boolean(config.baseUrl && store.hasToken()),
    baseUrl: config.baseUrl,
    userName: config.userName,
    hasToken: store.hasToken(),
    encryptionAvailable: store.isEncryptionAvailable(),
    launchOnLogin: config.launchOnLogin,
    courseFilter: config.courseFilter || 'all',
    favoritesOnly: config.favoritesOnly !== false,
    hasGeminiKey: store.hasGeminiKey(),
    isDarkMode: computeIsDark(),
    themeOverride,
    tasks: cache.tasks || [],
    courses: cache.courses || [],
    grades: cache.grades || {},
    modules: cache.modules || [],
    announcements: cache.announcements || [],
    courseImages: Object.fromEntries(
      Object.entries(cache.courseImages || {}).map(([id, entry]) => [id, entry.dataUrl]),
    ),
    geminiUsage: getUsage(),
    fetchedAt: cache.fetchedAt || null,
  };
};

/**
 * Fetch courses, then their assignments in parallel, and rebuild the list.
 * On failure the previous cached tasks are deliberately left in place so the
 * note keeps showing something useful.
 */
const refresh = async () => {
  const config = store.loadConfig();
  const token = store.loadToken();

  if (!config.baseUrl || !token) {
    setState({ configured: false, loading: false });
    return;
  }
  if (state.loading) return;

  setState({ loading: true, error: null });

  try {
    const baseUrl = canvas.normalizeBaseUrl(config.baseUrl);
    const [{ courses, usedFallback }, courseColors] = await Promise.all([
      canvas.getCourses(baseUrl, token, { favoritesOnly: config.favoritesOnly !== false }),
      canvas.getCourseColors(baseUrl, token).catch((error) => {
        console.warn('Course colors fetch failed, continuing without them:', error.message);
        return state.courseColors;
      }),
    ]);

    const groups = await Promise.all(
      courses.map(async (course) => ({
        course,
        assignments: await canvas.getCourseAssignments(baseUrl, token, course.id),
      })),
    );

    // Grades, modules, and announcements are only ever used as chatbot
    // context — never shown in the task list — so a hiccup fetching any of
    // them (an institution that restricts an endpoint, a course with nothing
    // posted) should never take down the whole refresh.
    const grades = await canvas.getGrades(baseUrl, token).catch((error) => {
      console.warn('Grades fetch failed, continuing without them:', error.message);
      return state.grades; // keep whatever we had rather than blanking it
    });

    const moduleGroups = await Promise.all(
      courses.map(async (course) => {
        const mods = await canvas.getModules(baseUrl, token, course.id).catch(() => []);
        return mods.map((m) => ({ ...m, courseId: course.id }));
      }),
    );
    const modules = moduleGroups.flat();

    const announcements = await canvas
      .getAnnouncements(baseUrl, token, courses.map((c) => c.id))
      .catch((error) => {
        console.warn('Announcements fetch failed, continuing without them:', error.message);
        return [];
      });

    // Course banner images, used as a faint background on task cards. Cached
    // by course id + source url so an unchanged course never re-downloads
    // its image on every 15-minute poll — only a genuinely new/changed
    // banner costs a request.
    const priorImageCache = store.loadCache().courseImages || {};
    const courseImageCache = {};
    await Promise.all(
      courses.map(async (course) => {
        if (!course.imageUrl) return;
        const cached = priorImageCache[course.id];
        if (cached && cached.url === course.imageUrl) {
          courseImageCache[course.id] = cached;
          return;
        }
        const dataUrl = await canvas.fetchCourseImageDataUrl(course.imageUrl, token).catch(() => null);
        if (dataUrl) courseImageCache[course.id] = { url: course.imageUrl, dataUrl };
      }),
    );

    let tasks = buildTaskList(groups);
    let aiError = null;

    const geminiKey = store.loadGeminiKey();
    if (geminiKey) {
      const result = await applyAiSummaries(tasks, geminiKey, store.loadAiCache());
      tasks = result.tasks;
      aiError = result.error;
      store.saveAiCache(result.cache);
    }

    const fetchedAt = new Date().toISOString();

    store.saveCache({ tasks, courses, grades, modules, announcements, courseImages: courseImageCache, fetchedAt });
    setState({
      tasks,
      courses,
      grades,
      modules,
      announcements,
      courseImages: Object.fromEntries(Object.entries(courseImageCache).map(([id, entry]) => [id, entry.dataUrl])),
      courseColors,
      fetchedAt,
      loading: false,
      error: null,
      usedFavoritesFallback: usedFallback,
      hasGeminiKey: Boolean(geminiKey),
      aiError,
      geminiUsage: getUsage(),
    });
    updateTrayTooltip(tasks.length);
  } catch (error) {
    setState({
      loading: false,
      error: {
        message: error.message || 'Something went wrong talking to Canvas.',
        code: error.code || 'unknown',
      },
    });
  }
};

const scheduleRefresh = () => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (state.configured) refresh();
  }, REFRESH_INTERVAL_MS);
};

const trayIcon = (size) =>
  nativeImage.createFromPath(
    path.join(__dirname, 'assets', size === 16 ? 'tray@16.png' : 'tray.png'),
  );

const updateTrayTooltip = (count) => {
  if (!tray) return;
  tray.setToolTip(
    count > 0 ? `Canvas Sticky — ${count} task${count === 1 ? '' : 's'} due` : 'Canvas Sticky',
  );
};

const showWindow = () => {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  // The renderer process (and its in-memory chat history) survives a
  // hide-to-tray, so every time the note is brought back — not just on a
  // fresh launch — tell it to drop any conversation so far. Nothing about
  // chat is ever written to disk; this just also keeps it from lingering in
  // memory (and against the next Gemini call's context) between sessions.
  mainWindow.webContents.send('reset-chat');
  if (state.configured) refresh();
};

const toggleWindow = () => {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
};

const persistBounds = () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  store.saveConfig({ windowBounds: mainWindow.getBounds() });
};

const createWindow = () => {
  const { windowBounds } = store.loadConfig();

  mainWindow = new BrowserWindow({
    ...DEFAULT_BOUNDS,
    ...(windowBounds || {}),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    // Windows 11 applies its own automatic corner rounding to app windows;
    // left on, it fights with the CSS border-radius on .note and shows as a
    // dark sliver at the corners where the two roundings don't quite agree.
    // Electron's `.note` shape is the only rounding this window should have.
    roundedCorners: false,
    resizable: true,
    maximizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    icon: trayIcon(32),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    publish();
    if (state.configured) refresh();
  });

  // Closing hides to tray; only the tray Quit item really exits.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    persistBounds();
    mainWindow.hide();
  });

  mainWindow.on('moved', persistBounds);
  mainWindow.on('resized', persistBounds);

  // Never let the note navigate itself somewhere or spawn popups.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
};

const createTray = () => {
  tray = new Tray(trayIcon(16));
  tray.setToolTip('Canvas Sticky');

  const menu = Menu.buildFromTemplate([
    { label: 'Show note', click: showWindow },
    { label: 'Hide note', click: () => mainWindow && mainWindow.hide() },
    { type: 'separator' },
    { label: 'Refresh now', click: refresh },
    {
      label: 'Settings',
      click: () => {
        showWindow();
        mainWindow.webContents.send('open-settings');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Canvas Sticky',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);
};

/* ---------------------------------------------------------------- IPC ---- */

ipcMain.handle('get-state', () => state);

ipcMain.handle('refresh', async () => {
  await refresh();
  return state;
});

/**
 * Validate credentials against Canvas BEFORE saving them, so a typo surfaces
 * immediately instead of as a mysterious empty note later.
 */
ipcMain.handle('save-settings', async (_event, payload = {}) => {
  const rawUrl = String(payload.baseUrl || '');
  const rawToken = String(payload.token || '');

  let baseUrl;
  try {
    baseUrl = canvas.normalizeBaseUrl(rawUrl);
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const token = rawToken.trim() || store.loadToken();
  if (!token) return { ok: false, message: 'An access token is required.' };

  try {
    const profile = await canvas.getProfile(baseUrl, token);
    store.saveConfig({ baseUrl, userName: profile.name });
    store.saveToken(token);

    setState({
      configured: true,
      baseUrl,
      userName: profile.name,
      hasToken: true,
      error: null,
    });

    refresh();
    return { ok: true, userName: profile.name };
  } catch (error) {
    return { ok: false, message: error.message || 'Could not verify those credentials.' };
  }
});

ipcMain.handle('set-launch-on-login', (_event, enabled) => {
  const launchOnLogin = Boolean(enabled);
  app.setLoginItemSettings({ openAtLogin: launchOnLogin, args: ['--hidden'] });
  store.saveConfig({ launchOnLogin });
  setState({ launchOnLogin });
  return launchOnLogin;
});

ipcMain.handle('set-course-filter', (_event, courseFilter) => {
  const value = String(courseFilter || 'all');
  store.saveConfig({ courseFilter: value });
  setState({ courseFilter: value });
  return value;
});

ipcMain.handle('set-favorites-only', (_event, enabled) => {
  const favoritesOnly = Boolean(enabled);
  store.saveConfig({ favoritesOnly });
  setState({ favoritesOnly, usedFavoritesFallback: false });
  refresh();
  return favoritesOnly;
});

/**
 * Gemini key is stored without a validation round trip (unlike Canvas) to
 * avoid spending a free-tier request just to check it; a bad key surfaces
 * instead as `aiError` on the next refresh, which the UI already knows how
 * to show.
 */
ipcMain.handle('save-gemini-key', (_event, rawKey) => {
  const key = String(rawKey || '').trim();
  if (!key) return { ok: false, message: 'Paste a Gemini API key, or use Remove instead.' };

  store.saveGeminiKey(key);
  setState({ hasGeminiKey: true, aiError: null });
  refresh();
  return { ok: true };
});

/**
 * Chat context comes from THIS process's own in-memory `state`, never from
 * what the renderer claims — same rule as the Canvas token: nothing sensitive
 * is ever trusted from the page. Only `history` and the new `message` (plain
 * conversation text, nothing sensitive) come from the renderer.
 */
ipcMain.handle('chat-send', async (_event, payload = {}) => {
  const geminiKey = store.loadGeminiKey();
  if (!geminiKey) {
    return { ok: false, message: 'Add a Gemini API key in Settings to use chat.', code: 'no_key' };
  }

  const message = String(payload.message || '').trim();
  if (!message) return { ok: false, message: 'Type a message first.', code: 'empty' };

  const history = Array.isArray(payload.history) ? payload.history : [];

  try {
    const reply = await sendChatMessage(
      geminiKey,
      {
        tasks: state.tasks,
        courses: state.courses,
        grades: state.grades,
        modules: state.modules,
        announcements: state.announcements,
      },
      history,
      message,
    );
    setState({ geminiUsage: getUsage() });
    return { ok: true, reply, usage: getUsage() };
  } catch (error) {
    setState({ geminiUsage: getUsage() });
    return {
      ok: false,
      message: error.message || 'Something went wrong talking to Gemini.',
      code: error.code || 'unknown',
    };
  }
});

ipcMain.handle('remove-gemini-key', () => {
  store.clearGeminiKey();
  setState({ hasGeminiKey: false, aiError: null });
  return true;
});

ipcMain.handle('sign-out', () => {
  store.clearCanvasCredentials();
  state = {
    ...state,
    configured: false,
    baseUrl: '',
    userName: '',
    hasToken: false,
    tasks: [],
    courses: [],
    grades: {},
    modules: [],
    announcements: [],
    courseImages: {},
    courseColors: {},
    fetchedAt: null,
    error: null,
    usedFavoritesFallback: false,
  };
  publish();
  return true;
});

/** Manual light/dark override. Passing null goes back to following the OS setting. */
ipcMain.handle('set-theme-override', (_event, mode) => {
  themeOverride = mode === 'dark' || mode === 'light' ? mode : null;
  store.saveConfig({ themeOverride });
  setState({ themeOverride, isDarkMode: computeIsDark() });
  return themeOverride;
});

// Only ever hand https links to the OS browser.
ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) return shell.openExternal(url);
  return false;
});

ipcMain.on('hide-window', () => mainWindow && mainWindow.hide());

ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());

ipcMain.on('toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

ipcMain.on('quit-app', () => {
  isQuitting = true;
  app.quit();
});

/* ------------------------------------------------------------ lifecycle -- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.canvassticky.app');

    hydrateFromDisk();
    createWindow();
    createTray();
    scheduleRefresh();
    updateTrayTooltip(state.tasks.length);

    if (!globalShortcut.register(TOGGLE_SHORTCUT, toggleWindow)) {
      // Another app owns the combo; not fatal, the tray still works.
      console.warn(`Could not register global shortcut ${TOGGLE_SHORTCUT}`);
    }

    // Follows the Windows light/dark setting live, unless the user has
    // clicked the in-app toggle — then their choice sticks until they toggle
    // it back (there's no third "auto" state in the UI; clicking is a
    // deliberate override).
    nativeTheme.on('updated', () => {
      if (!themeOverride) setState({ isDarkMode: nativeTheme.shouldUseDarkColors });
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  // The note lives in the tray, so a closed window must not end the process.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    isQuitting = true;
    persistBounds();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (refreshTimer) clearInterval(refreshTimer);
  });
}
