'use strict';

const crypto = require('node:crypto');
const { callGemini, extractText, GeminiError } = require('./gemini-client');

/**
 * Optional Gemini-powered summaries, layered on top of the free local
 * cleanup in summarize.js.
 *
 * Free tier is roughly 15 requests/minute with no card required, comfortably
 * enough for a to-do list of a few dozen items, especially since every result
 * is cached by a hash of the assignment text — an unchanged assignment is
 * never re-summarized, so ongoing refreshes cost close to nothing. One call
 * produces BOTH the brief and the detail breakdown together (via a JSON
 * response schema), so adding the breakdown didn't double the request count.
 *
 * The actual network call (and its shared rate limit with chat.js) lives in
 * gemini-client.js; this module owns the summarization-specific prompt,
 * caching, and per-refresh call budget.
 */

const MAX_CALLS_PER_REFRESH = 20; // bounds worst-case latency on a big first sync

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    brief: {
      type: 'STRING',
      description: 'One short sentence, under 18 words, plain text, no preamble — the concrete action to take.',
    },
    detail: {
      type: 'STRING',
      description:
        'A breakdown of 2 to 5 short lines separated by \\n, each starting with "- ". Cover what to produce, ' +
        'the topic/subject, whether it is individual or group work, and the submission format, when the source ' +
        'text says so. Wrap the 2-4 most important words per line in **double asterisks** (the concrete deliverable, ' +
        'the topic, "group"/"individual", the format). Do not invent details the source text does not contain.',
    },
  },
  required: ['brief', 'detail'],
};

const buildPrompt = (task) =>
  'You are helping a student triage their to-do list. Read the assignment below and fill in the requested JSON fields.\n\n' +
  `Course: ${task.courseName}\n` +
  `Title: ${task.title}\n` +
  `Description: ${task.fullText || 'No description provided.'}`;

/** @returns {{brief: string, detail: string}} */
const callGeminiForTask = async (task, apiKey) => {
  const data = await callGemini(apiKey, {
    contents: [{ role: 'user', parts: [{ text: buildPrompt(task) }] }],
    generationConfig: {
      maxOutputTokens: 220,
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const raw = extractText(data);
  if (!raw) throw new GeminiError('Gemini returned an empty response.', { code: 'empty' });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The schema should prevent this, but if the model ever ignores it,
    // fall back to treating the raw text as the brief rather than failing outright.
    return { brief: raw.replace(/\s+/g, ' ').slice(0, 200), detail: raw };
  }

  const brief = typeof parsed.brief === 'string' ? parsed.brief.trim() : '';
  const detail = typeof parsed.detail === 'string' ? parsed.detail.trim() : '';
  if (!brief) throw new GeminiError('Gemini returned an empty summary.', { code: 'empty' });

  return { brief, detail: detail || brief };
};

/**
 * Fills in AI brief + detail for tasks whose content hash isn't already
 * cached. Never throws: a failure just means those tasks keep their local
 * summary/detail. Stops early on an auth error so one bad key doesn't retry
 * 20 times in the same refresh.
 *
 * @param {object[]} tasks - render-ready tasks from buildTaskList (mutated copies returned)
 * @param {string} apiKey
 * @param {Record<string, {hash: string, summary: string, detail: string}>} cache
 * @returns {Promise<{tasks: object[], cache: object, error: {code: string, message: string} | null}>}
 */
const applyAiSummaries = async (tasks, apiKey, cache = {}) => {
  const nextCache = { ...cache };
  let calls = 0;
  let fatalError = null;

  const results = [];

  for (const task of tasks) {
    const hash = hashOf(`${task.title} ${task.fullText}`);
    const cached = nextCache[task.id];

    if (cached && cached.hash === hash) {
      results.push({ ...task, summary: cached.summary, detail: cached.detail, aiSummarized: true });
      continue;
    }

    if (fatalError || calls >= MAX_CALLS_PER_REFRESH) {
      results.push(task); // keep the local summary/detail; try again next refresh
      continue;
    }

    calls += 1;

    try {
      const { brief, detail } = await callGeminiForTask(task, apiKey);
      nextCache[task.id] = { hash, summary: brief, detail };
      results.push({ ...task, summary: brief, detail, aiSummarized: true });
    } catch (error) {
      results.push(task); // fall back to the local summary/detail for this one item
      if (error.code === 'auth' || error.code === 'bad_request') {
        fatalError = { code: error.code, message: error.message };
      }
    }
  }

  // Drop cache entries for tasks that no longer exist, so the file doesn't grow forever.
  const liveIds = new Set(tasks.map((t) => t.id));
  for (const id of Object.keys(nextCache)) {
    if (!liveIds.has(id)) delete nextCache[id];
  }

  return { tasks: results, cache: nextCache, error: fatalError };
};

module.exports = { applyAiSummaries, GeminiError };
