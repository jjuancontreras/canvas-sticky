'use strict';

/**
 * Low-level Gemini REST client, shared by ai-summarize.js (structured JSON
 * summaries) and chat.js (freeform Q&A). Sharing this module matters for one
 * reason: both features draw on the SAME free-tier quota for the SAME key, so
 * the request throttle has to be shared too — otherwise a chat message fired
 * right after a refresh's worth of summarization calls could blow past the
 * ~15 requests/minute free-tier limit even though each caller individually
 * looked fine.
 *
 * Runs in the main process only, same as the Canvas client — the key never
 * reaches the renderer.
 */

const store = require('./store');

const MODEL = 'gemini-3.5-flash-lite';
const ENDPOINT = (apiKey) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

const REQUEST_TIMEOUT_MS = 20000;
const MIN_GAP_MS = 4200; // shared throttle, keeps combined usage under ~15 req/min

// Google doesn't hand back "quota remaining" on these responses, so the usage
// ring in the chat popup is an estimate against the published free-tier daily
// cap for this model family, tracked locally and reset at midnight — not a
// number read from Gemini itself.
const DAILY_LIMIT = 1000;

let lastCallAt = 0;

const todayKey = () => new Date().toISOString().slice(0, 10);

/** Bumps today's local call counter by one and persists it. */
const recordUsage = () => {
  const config = store.loadConfig();
  const today = todayKey();
  const current = config.geminiUsage && config.geminiUsage.date === today ? config.geminiUsage.count : 0;
  const usage = { date: today, count: current + 1 };
  store.saveConfig({ geminiUsage: usage });
  return usage;
};

/** @returns {{used: number, limit: number}} today's estimated usage, resetting at midnight. */
const getUsage = () => {
  const config = store.loadConfig();
  const today = todayKey();
  const used = config.geminiUsage && config.geminiUsage.date === today ? config.geminiUsage.count : 0;
  return { used, limit: DAILY_LIMIT };
};

class GeminiError extends Error {
  constructor(message, { code = 'unknown', status = 0 } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
  }
}

const codeForStatus = (status) => {
  if (status === 400) return 'bad_request';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'http';
};

/**
 * @param {string} apiKey
 * @param {{contents: object[], systemInstruction?: object, generationConfig?: object}} body
 * @returns {Promise<object>} the raw parsed Gemini response
 */
const callGemini = async (apiKey, { contents, systemInstruction, generationConfig }) => {
  const wait = lastCallAt + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCallAt = Date.now();

  let response;
  try {
    response = await fetch(ENDPOINT(apiKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(generationConfig ? { generationConfig } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new GeminiError(timedOut ? 'Gemini timed out.' : 'Could not reach Gemini.', {
      code: timedOut ? 'timeout' : 'network',
    });
  }

  // Counted here, not just on success — any response that actually reached
  // Google (including a 4xx/5xx) consumed a request against the quota.
  // Requests that never left the machine (network error/timeout above) don't.
  recordUsage();

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body?.error?.message || '';
    throw new GeminiError(detail || `Gemini returned HTTP ${response.status}.`, {
      code: codeForStatus(response.status),
      status: response.status,
    });
  }

  return response.json();
};

/** Pulls the plain concatenated text out of a generateContent response. */
const extractText = (data) => {
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  return text.trim();
};

module.exports = { callGemini, extractText, GeminiError, MODEL, getUsage, DAILY_LIMIT };
