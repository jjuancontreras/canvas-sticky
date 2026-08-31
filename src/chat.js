'use strict';

const { callGemini, extractText, GeminiError } = require('./gemini-client');

/**
 * The "ask about my Canvas details" chatbot.
 *
 * Answers are grounded entirely in the same data the note already has cached
 * — tasks, courses, and grades — passed in fresh on every call rather than
 * trusted from the renderer, since the renderer can't be trusted with
 * anything sensitive (same rule as the Canvas token). No new Canvas
 * permissions or endpoints beyond the grades fetch in canvas.js.
 *
 * Conversation history is intentionally NOT persisted anywhere — it's held
 * in the renderer's memory only, for this window session, and passed in on
 * every call purely so the model has the last few turns of context.
 */

const MAX_HISTORY_TURNS = 12; // caps context growth within one long conversation
const MAX_OUTPUT_TOKENS = 400;

const formatGrade = (grade) => {
  if (!grade) return '';
  const parts = [];
  if (grade.currentGrade) parts.push(grade.currentGrade);
  if (typeof grade.currentScore === 'number') parts.push(`${grade.currentScore}%`);
  return parts.length ? ` — current grade: ${parts.join(' / ')}` : ' — no grade posted yet';
};

const buildContext = ({ tasks = [], courses = [], grades = {} }) => {
  const courseLines = courses
    .map((c) => `- ${c.code} (${c.name})${formatGrade(grades[c.id])}`)
    .join('\n');

  const taskLines = tasks
    .map((t) => {
      const due = t.dueAt ? new Date(t.dueAt).toLocaleString() : 'no due date';
      const points = typeof t.points === 'number' ? `${t.points} pts` : 'points not listed';
      const work = t.isGroupWork ? 'group work' : 'individual work';
      return `- [${t.courseCode}] "${t.title}" — due ${due}, ${points}, ${work}. ${t.summary}`;
    })
    .join('\n');

  return (
    `COURSES:\n${courseLines || 'No active courses found.'}\n\n` +
    `PENDING TASKS (unsubmitted, next 30 days):\n${taskLines || 'No pending tasks in range.'}`
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
        'short and direct, and use **bold** sparingly for the one or two things that matter most.\n\n' +
        `Current date/time: ${new Date().toISOString()}\n\n${buildContext(data)}`,
    },
  ],
});

/**
 * @param {string} apiKey
 * @param {{tasks: object[], courses: object[], grades: object}} data - the note's own cached data
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
