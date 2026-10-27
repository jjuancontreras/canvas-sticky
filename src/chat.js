'use strict';

const { callGemini, extractText, GeminiError } = require('./gemini-client');

/**
 * The "ask about my Canvas details" chatbot.
 *
 * Answers are grounded entirely in the same data the note already has cached
 * — tasks, courses, grades, modules, announcements, and submission feedback —
 * passed in fresh on every call rather than trusted from the renderer, since
 * the renderer can't be trusted with anything sensitive (same rule as the
 * Canvas token).
 *
 * Privacy contract: this data comes from Canvas over YOUR token and goes to
 * ONE place — the Gemini API, over YOUR OWN key, entered in Settings. Nothing
 * here is written to disk, logged, sent to any Anthropic/Canvas Sticky
 * server, or shared with any third service. There is no backend for this
 * app; the only two network peers it ever talks to are your Canvas instance
 * and Google's Gemini endpoint.
 *
 * Conversation history is intentionally NOT persisted anywhere — it's held
 * in the renderer's memory only, for this window session, and passed in on
 * every call purely so the model has the last few turns of context.
 */

const MAX_HISTORY_TURNS = 12; // caps context growth within one long conversation
const MAX_OUTPUT_TOKENS = 400;
const MAX_ANNOUNCEMENTS = 8;
const MAX_MODULES = 10;

const formatGrade = (grade) => {
  if (!grade) return '';
  const parts = [];
  if (grade.currentGrade) parts.push(grade.currentGrade);
  if (typeof grade.currentScore === 'number') parts.push(`${grade.currentScore}%`);
  return parts.length ? ` — current grade: ${parts.join(' / ')}` : ' — no grade posted yet';
};

const courseNameFor = (courses, courseId) => courses.find((c) => c.id === courseId)?.code || 'Unknown course';

const buildContext = ({ tasks = [], courses = [], grades = {}, modules = [], announcements = [] }) => {
  const courseLines = courses
    .map((c) => `- ${c.code} (${c.name})${formatGrade(grades[c.id])}`)
    .join('\n');

  const taskLines = tasks
    .map((t) => {
      const due = t.dueAt ? new Date(t.dueAt).toLocaleString() : 'no due date';
      const points = typeof t.points === 'number' ? `${t.points} pts` : 'points not listed';
      const work = t.isGroupWork ? 'group work' : 'individual work';
      const score = typeof t.score === 'number' ? `, scored ${t.score}` : '';
      const feedback = t.feedback ? ` Feedback from ${t.feedback.author}: "${t.feedback.text}"` : '';
      const link = t.url ? ` Link: ${t.url}` : '';
      return `- [${t.courseCode}] "${t.title}" — due ${due}, ${points}, ${work}${score}. ${t.summary}${feedback}${link}`;
    })
    .join('\n');

  const moduleLines = modules
    .slice(0, MAX_MODULES)
    .map((group) => {
      const items = group.items
        .map((it) => `${it.title} (${it.type}${it.url ? `, ${it.url}` : ''})`)
        .join('; ');
      return `- [${courseNameFor(courses, group.courseId)}] Module "${group.name}": ${items || 'no items'}`;
    })
    .join('\n');

  const announcementLines = announcements
    .slice(0, MAX_ANNOUNCEMENTS)
    .map((a) => {
      const posted = a.postedAt ? new Date(a.postedAt).toLocaleDateString() : 'unknown date';
      const link = a.url ? ` Link: ${a.url}` : '';
      return `- [${courseNameFor(courses, a.courseId)}] "${a.title}" (${posted}): ${a.summary || 'no content'}${link}`;
    })
    .join('\n');

  return (
    `COURSES:\n${courseLines || 'No active courses found.'}\n\n` +
    `PENDING TASKS (unsubmitted, next 30 days):\n${taskLines || 'No pending tasks in range.'}\n\n` +
    `COURSE MODULES (content outline):\n${moduleLines || 'No module data loaded.'}\n\n` +
    `RECENT ANNOUNCEMENTS (last 3 weeks):\n${announcementLines || 'No recent announcements.'}`
  );
};

const systemInstructionFor = (data) => ({
  parts: [
    {
      text:
        'You are a helpful assistant built into a student\'s desktop sticky-note app called Canvas Sticky. ' +
        'Answer questions using ONLY the Canvas data listed below — never invent grades, due dates, or ' +
        'assignments that are not listed. If something is not covered (a grade that has not been posted, an ' +
        'assignment further out than 30 days, a course not listed), say plainly that you do not have that ' +
        'information rather than guessing. This is a small popup window, not a full chat app — keep answers ' +
        'short and direct, and use **bold** sparingly for the one or two things that matter most. ' +
        'Whenever the data below includes a link relevant to your answer — a class modality/meeting link found ' +
        'inside a task, module item, or announcement, or that item\'s own Canvas page — include it in your reply ' +
        'as a plain http(s) URL exactly as given, on its own or right after the relevant sentence. Do not wrap it ' +
        'in markdown link syntax or any other formatting; write the bare URL and the app will make it clickable.\n\n' +
        `Current date/time: ${new Date().toISOString()}\n\n${buildContext(data)}`,
    },
  ],
});

/**
 * @param {string} apiKey
 * @param {{tasks: object[], courses: object[], grades: object, modules: object[], announcements: object[]}} data
 *   - the note's own cached data (never anything fetched fresh from the renderer)
 * @param {Array<{role: 'user'|'model', text: string}>} history - prior turns from this conversation only
 * @param {string} message - the new user message
 * @returns {Promise<string>} the assistant's reply
 */
const sendChatMessage = async (apiKey, data, history, message) => {
  const trimmedHistory = (Array.isArray(history) ? history : [])
    .filter((turn) => turn && (turn.role === 'user' || turn.role === 'model') && typeof turn.text === 'string')
    .slice(-MAX_HISTORY_TURNS);

  const contents = [
    ...trimmedHistory.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    { role: 'user', parts: [{ text: message }] },
  ];

  const response = await callGemini(apiKey, {
    contents,
    systemInstruction: systemInstructionFor(data),
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.3 },
  });

  const text = extractText(response);
  if (!text) throw new GeminiError('Gemini returned an empty reply.', { code: 'empty' });
  return text;
};

module.exports = { sendChatMessage };
