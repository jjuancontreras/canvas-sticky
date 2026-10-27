'use strict';

/**
 * Turns raw Canvas assignments into the sorted list the note renders.
 *
 * Pure functions only (no Electron, no network) so the ordering rules can be
 * exercised directly with node.
 */

const { summarize } = require('./summarize');

const DAY_MS = 86400000;
const HORIZON_DAYS = 30;
const OVERDUE_GRACE_DAYS = 14;

/**
 * Has this already been turned in? Canvas reports this via the submission
 * sub-object; anything submitted, graded, or excused is noise on a to-do note.
 */
const isDone = (assignment) => {
  const submission = assignment.submission;
  if (!submission) return false;
  if (submission.excused) return true;
  if (submission.submitted_at) return true;
  return ['submitted', 'graded', 'pending_review'].includes(submission.workflow_state);
};

const toTimestamp = (value) => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Keep only what belongs on the note: unsubmitted, published, and inside the
 * time window (recent past through the next 30 days).
 */
const isRelevant = (assignment, now) => {
  if (assignment.published === false) return false;
  if (isDone(assignment)) return false;

  const due = toTimestamp(assignment.due_at);
  if (due === null) return true; // undated work still matters; it sorts last

  if (due < now - OVERDUE_GRACE_DAYS * DAY_MS) return false; // long gone
  if (due > now + HORIZON_DAYS * DAY_MS) return false; // too far out to act on
  return true;
};

/**
 * The most recent instructor comment on the student's own submission, if any
 * — Canvas returns these inline on the assignment when the call includes
 * `submission_comments`, so this costs no extra request. Kept as plain text
 * only, used as chatbot context; never rendered as HTML.
 */
const latestFeedback = (assignment) => {
  const comments = assignment.submission?.submission_comments;
  if (!Array.isArray(comments) || comments.length === 0) return null;

  const last = comments[comments.length - 1];
  const text = typeof last?.comment === 'string' ? last.comment.trim() : '';
  if (!text) return null;

  return { author: last.author_name || 'Instructor', text };
};

const shapeTask = (assignment, course) => {
  const { summary, detail, fullText } = summarize(assignment);

  return {
    id: `${course.id}-${assignment.id}`,
    title: (assignment.name || 'Untitled assignment').trim(),
    courseId: course.id,
    courseName: course.name,
    courseCode: course.code,
    dueAt: assignment.due_at || null,
    points: typeof assignment.points_possible === 'number' ? assignment.points_possible : null,
    // Canvas's own field, not a guess: an assignment only has a
    // group_category when it was actually set up for group submission. More
    // reliable than asking an LLM to infer it from prose, and works with no
    // AI key configured at all.
    isGroupWork: assignment.group_category_id != null,
    url: assignment.html_url || '',
    summary, // one-line brief, shown on the collapsed card
    detail, // bullet breakdown, shown when the card is expanded
    fullText, // cleaned full text — never rendered, only fed to the AI prompt
    score: typeof assignment.submission?.score === 'number' ? assignment.submission.score : null,
    feedback: latestFeedback(assignment), // chatbot context only, not shown on the card
  };
};

/**
 * Nearest deadline first. Undated work sinks to the bottom rather than
 * pretending to be urgent, with a stable title tiebreak so the list does not
 * reshuffle between refreshes.
 */
const byDueDate = (a, b) => {
  const aDue = toTimestamp(a.dueAt);
  const bDue = toTimestamp(b.dueAt);

  if (aDue === null && bDue === null) return a.title.localeCompare(b.title);
  if (aDue === null) return 1;
  if (bDue === null) return -1;
  if (aDue !== bDue) return aDue - bDue;
  return a.title.localeCompare(b.title);
};

/**
 * @param {Array<{course: object, assignments: object[]}>} groups
 * @returns {object[]} render-ready tasks, soonest due first
 */
const buildTaskList = (groups, now = Date.now()) => {
  const tasks = [];

  for (const { course, assignments } of groups) {
    for (const assignment of assignments) {
      if (isRelevant(assignment, now)) tasks.push(shapeTask(assignment, course));
    }
  }

  return tasks.sort(byDueDate);
};

module.exports = { buildTaskList, isDone, isRelevant, byDueDate, shapeTask, toTimestamp };
