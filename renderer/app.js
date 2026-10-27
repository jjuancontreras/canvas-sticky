'use strict';

/**
 * Renderer for the sticky note.
 *
 * Has no Node access and never sees the Canvas token — it receives finished
 * task objects over the preload bridge and draws them. All assignment text is
 * inserted with textContent, never innerHTML, because titles and descriptions
 * are authored by other people.
 *
 * Chat is a view inside this same window, opened via the floating "chat-fab"
 * button pinned to the note's own corner — not a separate OS window.
 */

const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const $ = (id) => document.getElementById(id);

const els = {
  viewSetup: $('view-setup'),
  viewList: $('view-list'),
  viewSettings: $('view-settings'),
  subBar: $('sub-bar'),
  taskList: $('task-list'),
  emptyState: $('empty-state'),
  courseFilter: $('course-filter'),
  statusTime: $('status-time'),
  statusCount: $('status-count'),
  statusCountText: $('status-count-text'),
  refreshBtn: $('refresh-btn'),
  settingsBtn: $('settings-btn'),
  winClose: $('win-close'),
  winMinimize: $('win-minimize'),
  winMaximize: $('win-maximize'),
  themeToggle: $('theme-toggle'),
  chatUsage: $('chat-usage'),
  chatUsagePct: $('chat-usage-pct'),
  chatFab: $('chat-fab'),
  chatPopup: $('chat-popup'),
  chatPopupClose: $('chat-popup-close'),
  chatNoKey: $('chat-no-key'),
  chatMessages: $('chat-messages'),
  chatEmpty: $('chat-empty'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  chatSendBtn: $('chat-send-btn'),
  chatOpenSettings: $('chat-open-settings'),
  foot: $('foot'),
  footMsg: $('foot-msg'),
  footAction: $('foot-action'),
  setupUrl: $('setup-url'),
  setupToken: $('setup-token'),
  setupSave: $('setup-save'),
  setupError: $('setup-error'),
  setUrl: $('set-url'),
  setToken: $('set-token'),
  setFavorites: $('set-favorites'),
  setAutostart: $('set-autostart'),
  settingsSave: $('settings-save'),
  settingsBack: $('settings-back'),
  settingsError: $('settings-error'),
  settingsOk: $('settings-ok'),
  accountLine: $('account-line'),
  encryptionNote: $('encryption-note'),
  signOut: $('sign-out'),
  setGeminiKey: $('set-gemini-key'),
  geminiStatus: $('gemini-status'),
  geminiError: $('gemini-error'),
  geminiSave: $('gemini-save'),
  geminiRemove: $('gemini-remove'),
  geminiGetKey: $('gemini-get-key'),
  getTokenLink: $('get-token-link'),
};

let state = null;
let showingSettings = false;
/**
 * The selected course lives here, not in `state`. Persisting it goes through
 * the main process, which echoes state back one round trip later — reading the
 * filter from `state` would make the dropdown snap back for a frame after
 * every change.
 */
let courseFilter = null;
const expanded = new Set();

let showingChat = false;
let chatPending = false;
/**
 * Held in renderer memory only, for this window session — never written to
 * disk, never sent anywhere except back to our own main process on the next
 * message so Gemini has continuity. Clears on a full app restart.
 */
const chatHistory = [];

/* ------------------------------------------------------------ urgency --- */

/**
 * Urgency is derived here rather than in the main process so the labels stay
 * correct as time passes, without needing another network round trip.
 */
const urgencyOf = (dueAt, now = Date.now()) => {
  if (!dueAt) return 'later';

  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 'later';

  const delta = due - now;
  if (delta < 0) return 'overdue';
  if (delta < DAY) return 'critical';
  if (delta < 3 * DAY) return 'soon';
  if (delta < 7 * DAY) return 'upcoming';
  return 'later';
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const timeOfDay = (date) =>
  date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();

/** Short human label: "3h overdue", "due in 5h", "due Thu 11:59pm". */
const dueLabel = (dueAt, now = Date.now()) => {
  if (!dueAt) return 'no due date';

  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 'no due date';

  const date = new Date(due);
  const delta = due - now;

  if (delta < 0) {
    const past = Math.abs(delta);
    if (past < HOUR) return `${plural(Math.max(1, Math.round(past / MINUTE)), 'min')} late`;
    if (past < DAY) return `${plural(Math.round(past / HOUR), 'hr')} late`;
    return `${plural(Math.round(past / DAY), 'day')} late`;
  }

  if (delta < HOUR) return `due in ${plural(Math.max(1, Math.round(delta / MINUTE)), 'min')}`;
  if (delta < DAY) return `due in ${plural(Math.round(delta / HOUR), 'hr')}`;
  if (delta < 7 * DAY) {
    return `due ${date.toLocaleDateString([], { weekday: 'short' })} ${timeOfDay(date)}`;
  }
  return `due ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
};

/** Header title for the list view: today's date instead of a static label. */
const todaysDate = () =>
  new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

const relativeTime = (iso) => {
  if (!iso) return 'never';
  const delta = Date.now() - Date.parse(iso);
  if (Number.isNaN(delta)) return 'never';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.round(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.round(delta / HOUR)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
};

/* -------------------------------------------------------------- render --- */

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // never innerHTML
  return node;
};

// Matches a bare http(s) URL, stopping short of trailing punctuation/closing
// brackets so "(https://zoom.us/j/123)" links correctly rather than eating
// the closing paren, and a URL at the end of a sentence doesn't swallow the
// period.
const URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,!?]/g;

/**
 * Appends `text` to `container`, turning any bare URL into a real, clickable
 * link. Still never touches innerHTML — the link is a genuine <a> element
 * built via createElement/textContent, and clicking it is routed through
 * `window.api.openExternal` (same as every other external link in this app)
 * rather than letting the note's own window navigate.
 */
const appendWithLinks = (container, text) => {
  let lastIndex = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0];
    if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)));

    const link = document.createElement('a');
    link.href = '#';
    link.className = 'chat-link';
    link.textContent = url;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      window.api.openExternal(url);
    });
    container.append(link);

    lastIndex = match.index + url.length;
  }
  if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)));
};

/**
 * Appends `text` to `container`, splitting on **bold** markers — the one bit
 * of formatting the AI breakdown is allowed to use — and turning any bare URL
 * (inside or outside a bold span) into a clickable link. Every piece still
 * goes in via textContent/createTextNode/createElement, never innerHTML, so
 * even if a description (or a prompt-injection attempt inside one) produced
 * literal "<tags>" they would render as inert text, not markup.
 */
const appendWithBold = (container, text) => {
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      appendWithLinks(strong, part.slice(2, -2));
      container.append(strong);
    } else {
      appendWithLinks(container, part);
    }
  }
};

/** The expanded-card view: a bulleted breakdown instead of the one-line brief. */
const buildDetailList = (detail) => {
  const list = el('ul', 'task-detail-list');
  const lines = (detail || '')
    .split('\n')
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter(Boolean);

  for (const line of lines.length ? lines : ['No details provided.']) {
    const li = document.createElement('li');
    appendWithBold(li, line);
    list.append(li);
  }
  return list;
};

const buildTaskNode = (task) => {
  const urgency = urgencyOf(task.dueAt);
  const isOpen = expanded.has(task.id);

  const li = el('li', `task ${urgency}${isOpen ? ' open' : ''}`);
  li.dataset.id = task.id;

  const courseColor = state.courseColors && state.courseColors[task.courseId];
  const chip = el('span', 'course-chip', task.courseCode);
  if (courseColor) {
    chip.classList.add('has-color');
    chip.style.setProperty('--course-color', courseColor);
  }

  const top = el('div', 'task-top');
  top.append(chip, el('span', 'due', dueLabel(task.dueAt)));

  const title = el('p', 'task-title', task.title);

  const tags = el('div', 'task-tags');
  if (typeof task.points === 'number') {
    tags.append(el('span', 'tag tag-points', `${task.points} pt${task.points === 1 ? '' : 's'}`));
  }
  tags.append(
    el('span', task.isGroupWork ? 'tag tag-group' : 'tag tag-individual', task.isGroupWork ? 'Group' : 'Individual'),
  );

  // The course's own Canvas banner image, very faint, behind just this
  // header block (chip/due/title/tags) — it deliberately stops here rather
  // than covering the whole card, so it never runs behind the description
  // text below. A data: URL supplied by main.js (it downloaded the image;
  // the renderer never fetches a remote URL itself).
  const banner = el('div', 'task-banner');
  banner.append(top, title, tags);
  const courseImage = state.courseImages && state.courseImages[task.courseId];
  if (courseImage) {
    banner.classList.add('has-course-bg');
    banner.style.setProperty('--course-bg', `url("${courseImage}")`);
  }

  const summary = el('p', 'task-summary', task.summary);

  li.append(banner, summary, buildDetailList(task.detail));

  if (task.url) {
    const link = el('button', 'task-open-link', 'Open in Canvas');
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      window.api.openExternal(task.url);
    });
    li.append(link);
  }

  li.addEventListener('click', () => {
    if (expanded.has(task.id)) expanded.delete(task.id);
    else expanded.add(task.id);
    render();
  });

  return li;
};

const visibleTasks = () => {
  if (!state) return [];
  const filter = courseFilter || 'all';
  return filter === 'all' ? state.tasks : state.tasks.filter((t) => t.courseId === filter);
};

const renderCourseOptions = () => {
  // Fall back to "all" if the saved course is gone (term ended, dropped, etc).
  if (courseFilter !== 'all' && !state.courses.some((c) => c.id === courseFilter)) {
    courseFilter = 'all';
  }

  const wanted = ['all', ...state.courses.map((c) => c.id)].join('|');
  if (els.courseFilter.dataset.signature !== wanted) {
    els.courseFilter.replaceChildren();

    const all = el('option', null, 'All courses');
    all.value = 'all';
    els.courseFilter.append(all);

    for (const course of state.courses) {
      const option = el('option', null, course.code);
      option.value = course.id;
      option.title = course.name;
      els.courseFilter.append(option);
    }
    els.courseFilter.dataset.signature = wanted;
  }

  els.courseFilter.value = courseFilter;
};

const renderFooter = () => {
  const { error, aiError, usedFavoritesFallback, fetchedAt, loading } = state;

  els.foot.classList.toggle('warn', Boolean(error));
  els.footAction.hidden = true;

  if (error) {
    els.foot.hidden = false;
    els.footMsg.textContent = error.message;

    if (error.code === 'auth') {
      els.footAction.hidden = false;
      els.footAction.textContent = 'Settings';
      els.footAction.onclick = () => setView('settings');
    } else if (fetchedAt) {
      els.footMsg.textContent = `${error.message} Showing data from ${relativeTime(fetchedAt)}.`;
    }
    return;
  }

  if (!loading && !fetchedAt) {
    els.foot.hidden = false;
    els.footMsg.textContent = 'No data fetched yet.';
    return;
  }

  // Non-blocking notices: the task list is still fine, just worth a heads-up.
  if (aiError) {
    els.foot.hidden = false;
    els.footMsg.textContent =
      aiError.code === 'auth'
        ? 'Gemini rejected the API key. Showing plain summaries. Check it in Settings.'
        : `AI summaries paused: ${aiError.message}`;
    if (aiError.code === 'auth') {
      els.footAction.hidden = false;
      els.footAction.textContent = 'Settings';
      els.footAction.onclick = () => setView('settings');
    }
    return;
  }

  if (usedFavoritesFallback) {
    els.foot.hidden = false;
    els.footMsg.textContent = "No courses starred in Canvas — showing all active courses instead.";
    return;
  }

  els.foot.hidden = true;
};

const render = () => {
  if (!state) return;

  // Follows the Windows light/dark setting live unless the user has clicked
  // the toggle; either way main.js pushes the result through this same state
  // channel, so there's nothing extra to wire up here.
  document.documentElement.dataset.theme = state.isDarkMode ? 'dark' : 'light';
  els.themeToggle.querySelector('.icon-sun').hidden = state.isDarkMode;
  els.themeToggle.querySelector('.icon-moon').hidden = !state.isDarkMode;
  els.themeToggle.title = state.isDarkMode ? 'Switch to light mode' : 'Switch to dark mode';

  renderChatUsage();

  els.refreshBtn.classList.toggle('spinning', Boolean(state.loading));

  // The chat popup floats above whatever view is showing, so it's synced
  // independently of the view switch below rather than being a view itself.
  syncChatPopup();

  if (!state.configured) {
    setView('setup');
    return;
  }
  if (showingSettings) {
    setView('settings');
    return;
  }
  setView('list');

  renderCourseOptions();

  const tasks = visibleTasks();
  els.taskList.replaceChildren(...tasks.map(buildTaskNode));
  els.emptyState.hidden = tasks.length > 0;

  if (state.loading) {
    els.statusTime.textContent = 'refreshing…';
    els.statusCount.hidden = true;
  } else {
    els.statusTime.textContent = relativeTime(state.fetchedAt);
    els.statusCount.hidden = false;
    els.statusCountText.textContent = `${tasks.length} due`;
  }

  renderFooter();
};

/** Switches the visible pane and keeps the header controls consistent. */
const setView = (view) => {
  els.viewSetup.hidden = view !== 'setup';
  els.viewList.hidden = view !== 'list';
  els.viewSettings.hidden = view !== 'settings';
  els.subBar.hidden = view !== 'list';
  els.settingsBtn.hidden = view === 'setup';
  els.chatFab.hidden = view !== 'list'; // only makes sense to open chat from the task list

  if (view === 'list') {
    document.querySelector('.title').textContent = todaysDate();
  } else {
    document.querySelector('.title').textContent = { setup: 'Canvas Sticky', settings: 'Settings' }[view];
    els.foot.hidden = true;
  }

  // Closing off the list view also closes the popup — there's nothing behind
  // it to chat about from Settings or the first-run screen.
  if (view !== 'list') showingChat = false;
};

/**
 * Today's estimated Gemini usage, drawn as a small donut in the chat popup
 * header. This is a local count against the model's published free-tier
 * daily limit (see gemini-client.js) — Google's API doesn't hand back actual
 * quota remaining, so treat the percentage as an estimate, not a hard number.
 */
const renderChatUsage = () => {
  if (!els.chatUsage || !state.geminiUsage) return;
  const { used, limit } = state.geminiUsage;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  els.chatUsage.style.setProperty('--pct', `${pct}%`);
  els.chatUsagePct.textContent = `${pct}%`;
  els.chatUsage.title = `~${used} / ${limit} Gemini requests used today (estimate, resets daily)`;
};

/** Shows/hides the floating chat popup without touching the underlying view. */
const syncChatPopup = () => {
  els.chatPopup.hidden = !showingChat;
  els.chatFab.classList.toggle('active', showingChat);
  if (showingChat) updateChatKeyGate();
};

/** Shows the chat panel, or the "add a key" gate if none is configured yet. */
const updateChatKeyGate = () => {
  const hasKey = Boolean(state.hasGeminiKey);
  els.chatNoKey.hidden = hasKey;
  els.chatMessages.hidden = !hasKey;
  els.chatForm.hidden = !hasKey;
};

/* ------------------------------------------------------------- actions --- */

const showFormError = (node, message) => {
  node.textContent = message;
  node.hidden = !message;
};

const connect = async () => {
  const baseUrl = els.setupUrl.value.trim();
  const token = els.setupToken.value.trim();

  showFormError(els.setupError, '');

  if (!baseUrl || !token) {
    showFormError(els.setupError, 'Both the Canvas address and a token are required.');
    return;
  }

  els.setupSave.disabled = true;
  els.setupSave.textContent = 'Checking…';

  const result = await window.api.saveSettings(baseUrl, token);

  els.setupSave.disabled = false;
  els.setupSave.textContent = 'Connect';

  if (!result.ok) {
    showFormError(els.setupError, result.message);
    return;
  }
  // Clear the token out of the DOM as soon as it has been stored.
  els.setupToken.value = '';
};

const saveSettings = async () => {
  showFormError(els.settingsError, '');
  els.settingsOk.hidden = true;

  els.settingsSave.disabled = true;
  els.settingsSave.textContent = 'Checking…';

  const result = await window.api.saveSettings(els.setUrl.value.trim(), els.setToken.value.trim());

  els.settingsSave.disabled = false;
  els.settingsSave.textContent = 'Save';

  if (!result.ok) {
    showFormError(els.settingsError, result.message);
    return;
  }

  els.setToken.value = '';
  els.settingsOk.textContent = `Connected as ${result.userName}.`;
  els.settingsOk.hidden = false;
};

const openSettings = () => {
  showingSettings = true;
  els.setUrl.value = state.baseUrl || '';
  els.setToken.value = '';
  els.setFavorites.checked = state.favoritesOnly !== false;
  els.setAutostart.checked = Boolean(state.launchOnLogin);
  showFormError(els.settingsError, '');
  els.settingsOk.hidden = true;

  els.accountLine.textContent = state.userName
    ? `Signed in as ${state.userName}.`
    : 'Not connected yet.';

  els.encryptionNote.textContent = state.encryptionAvailable
    ? 'Your token is stored encrypted by Windows, outside this app’s folder.'
    : 'Warning: Windows encryption is unavailable, so the token is stored as plain text.';

  els.setGeminiKey.value = '';
  els.setGeminiKey.placeholder = state.hasGeminiKey
    ? 'A key is already saved — paste a new one to replace it'
    : 'Paste your Gemini API key';
  els.geminiRemove.hidden = !state.hasGeminiKey;
  showFormError(els.geminiError, '');
  els.geminiStatus.textContent = state.hasGeminiKey
    ? 'AI summaries are on. Stored encrypted, same as your Canvas token.'
    : 'Off by default — see the guide above to get a free key.';

  render();
};

const saveGeminiKey = async () => {
  showFormError(els.geminiError, '');

  const key = els.setGeminiKey.value.trim();
  if (!key) {
    showFormError(els.geminiError, 'Paste a key, or use Remove instead.');
    return;
  }

  els.geminiSave.disabled = true;
  els.geminiSave.textContent = 'Saving…';

  const result = await window.api.saveGeminiKey(key);

  els.geminiSave.disabled = false;
  els.geminiSave.textContent = 'Save key';

  if (!result.ok) {
    showFormError(els.geminiError, result.message);
    return;
  }

  els.setGeminiKey.value = '';
  els.setGeminiKey.placeholder = 'A key is already saved — paste a new one to replace it';
  els.geminiRemove.hidden = false;
  els.geminiStatus.textContent = 'Saved. Summaries will update on the next refresh.';
};

const removeGeminiKey = async () => {
  await window.api.removeGeminiKey();
  els.setGeminiKey.value = '';
  els.setGeminiKey.placeholder = 'Paste your Gemini API key';
  els.geminiRemove.hidden = true;
  els.geminiStatus.textContent = 'Off — see the guide above to get a free key.';
};

/* ----------------------------------------------------------------- chat -- */

const openChat = () => {
  showingChat = true;
  showingSettings = false;
  render();
  if (state.hasGeminiKey) els.chatInput.focus();
};

/** Appends one message bubble; assistant text may use **bold**, user text never does. */
const appendChatBubble = (role, text, extraClass = '') => {
  els.chatEmpty.hidden = true; // once a real conversation starts, drop the suggestion chips

  const bubble = el('div', `chat-msg ${role}${extraClass ? ` ${extraClass}` : ''}`);
  if (role === 'model') appendWithBold(bubble, text);
  else bubble.textContent = text;

  els.chatMessages.append(bubble);
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  return bubble;
};

/** Drops any in-memory conversation — called every time the note is shown. */
const resetChat = () => {
  chatHistory.length = 0;
  chatPending = false;
  showingChat = false;
  els.chatMessages.querySelectorAll('.chat-msg').forEach((node) => node.remove());
  els.chatEmpty.hidden = false;
  syncChatPopup();
};

const submitChatMessage = async (rawText) => {
  const message = rawText.trim();
  if (!message || chatPending) return;

  appendChatBubble('user', message);
  els.chatInput.value = '';

  chatPending = true;
  els.chatSendBtn.disabled = true;
  const pendingBubble = appendChatBubble('model', 'Thinking…', 'pending');

  // `chatHistory` at this point is everything BEFORE this message — matches
  // main.js's contract of (history, message) rather than duplicating the
  // new message inside history too.
  const result = await window.api.sendChatMessage(chatHistory, message);

  pendingBubble.remove();
  chatPending = false;
  els.chatSendBtn.disabled = false;

  if (!result.ok) {
    appendChatBubble('model', result.message || 'Something went wrong.', 'error');
    if (result.code === 'no_key') updateChatKeyGate();
    return;
  }

  chatHistory.push({ role: 'user', text: message }, { role: 'model', text: result.reply });
  appendChatBubble('model', result.reply);
};

/* --------------------------------------------------------------- wiring -- */

els.refreshBtn.addEventListener('click', () => window.api.refresh());
els.winClose.addEventListener('click', () => window.api.hideWindow());
els.winMinimize.addEventListener('click', () => window.api.minimizeWindow());
els.winMaximize.addEventListener('click', () => window.api.toggleMaximize());
els.themeToggle.addEventListener('click', () => {
  window.api.setThemeOverride(state && state.isDarkMode ? 'light' : 'dark');
});

els.settingsBtn.addEventListener('click', () => {
  if (showingSettings) {
    showingSettings = false;
    render();
  } else {
    showingChat = false;
    openSettings();
  }
});

els.settingsBack.addEventListener('click', () => {
  showingSettings = false;
  render();
});

els.chatFab.addEventListener('click', () => {
  if (showingChat) {
    showingChat = false;
    render();
  } else {
    openChat();
  }
});

els.chatPopupClose.addEventListener('click', () => {
  showingChat = false;
  render();
});

els.chatOpenSettings.addEventListener('click', () => {
  showingChat = false;
  openSettings();
});

els.geminiGetKey.addEventListener('click', () => {
  window.api.openExternal('https://aistudio.google.com/apikey');
});

els.getTokenLink.addEventListener('click', () => {
  const baseUrl = (state && state.baseUrl) || els.setUrl.value.trim();
  if (!baseUrl) return;
  const normalized = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
  window.api.openExternal(`${normalized.replace(/\/+$/, '')}/profile/settings#approved_integrations_section`);
});

els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitChatMessage(els.chatInput.value);
});

document.querySelectorAll('.chip-btn').forEach((chip) => {
  chip.addEventListener('click', () => submitChatMessage(chip.dataset.prompt || ''));
});

els.setupSave.addEventListener('click', connect);
els.settingsSave.addEventListener('click', saveSettings);

els.setupToken.addEventListener('keydown', (e) => e.key === 'Enter' && connect());
els.setupUrl.addEventListener('keydown', (e) => e.key === 'Enter' && connect());

els.setAutostart.addEventListener('change', (e) => window.api.setLaunchOnLogin(e.target.checked));
els.setFavorites.addEventListener('change', (e) => window.api.setFavoritesOnly(e.target.checked));

els.geminiSave.addEventListener('click', saveGeminiKey);
els.geminiRemove.addEventListener('click', removeGeminiKey);
els.setGeminiKey.addEventListener('keydown', (e) => e.key === 'Enter' && saveGeminiKey());

els.courseFilter.addEventListener('change', (e) => {
  courseFilter = e.target.value || 'all';
  window.api.setCourseFilter(courseFilter); // persist; the echo is ignored
  render();
});

els.signOut.addEventListener('click', async () => {
  await window.api.signOut();
  showingSettings = false;
  showingChat = false;
  expanded.clear();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.api.hideWindow();
  if (event.key === 'F5' || (event.ctrlKey && event.key === 'r')) {
    event.preventDefault();
    window.api.refresh();
  }
});

window.api.onState((next) => {
  state = next;
  if (courseFilter === null) courseFilter = state.courseFilter || 'all';
  if (!state.configured) {
    showingSettings = false;
    showingChat = false;
  }
  // If the key is removed while chat is open, flip straight to the gate.
  if (showingChat) updateChatKeyGate();
  render();
});

window.api.onOpenSettings(() => {
  if (state && state.configured) {
    showingChat = false;
    openSettings();
  }
});

window.api.onResetChat(resetChat);

// Keep relative labels ("due in 3 hrs") honest without refetching.
setInterval(() => {
  if (state && state.configured && !showingSettings) render();
}, MINUTE);

window.api.getState().then((initial) => {
  state = initial;
  if (courseFilter === null) courseFilter = state.courseFilter || 'all';
  render();
});
