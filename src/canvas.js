'use strict';

/**
 * Canvas LMS REST client.
 *
 * Runs in Electron's main (Node) process only. Two reasons that matters:
 * the Canvas API sends no CORS headers so a renderer could not call it anyway,
 * and keeping it here means the access token never enters the page context.
 */

const REQUEST_TIMEOUT_MS = 20000;
const MAX_PAGES = 10;
const USER_AGENT = 'CanvasSticky/1.0';

class CanvasError extends Error {
  constructor(message, { code = 'unknown', status = 0 } = {}) {
    super(message);
    this.name = 'CanvasError';
    this.code = code;
    this.status = status;
  }
}

/** Accepts "school.instructure.com", with or without scheme or trailing path. */
const normalizeBaseUrl = (input) => {
  const trimmed = String(input || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new CanvasError('Canvas URL is required.', { code: 'config' });

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new CanvasError('That does not look like a valid Canvas URL.', { code: 'config' });
  }

  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new CanvasError('Canvas URL must use https.', { code: 'config' });
  }
  // Drop any path the user pasted (e.g. a full dashboard URL).
  return `${url.protocol}//${url.host}`;
};

/** Pull the rel="next" href out of a Link header. */
const parseNextLink = (linkHeader) => {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return null;
};

const messageForStatus = (status, body) => {
  if (status === 401) return 'Canvas rejected the access token. It may be expired or revoked.';
  if (status === 403) {
    return /rate limit/i.test(body)
      ? 'Canvas is rate limiting requests. Try again shortly.'
      : 'Access denied by Canvas for this request.';
  }
  if (status === 404) return 'Canvas endpoint not found. Check that the Canvas URL is correct.';
  if (status >= 500) return 'Canvas is having server trouble. Try again shortly.';
  return `Canvas returned an unexpected error (HTTP ${status}).`;
};

const codeForStatus = (status, body) => {
  if (status === 401) return 'auth';
  if (status === 403) return /rate limit/i.test(body) ? 'rate_limit' : 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'http';
};

/**
 * Single authenticated GET. Returns { data, nextUrl }.
 */
const request = async (url, token) => {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json+canvas-string-ids, application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
    throw new CanvasError(
      timedOut ? 'Canvas did not respond in time.' : 'Could not reach Canvas. Check your connection.',
      { code: timedOut ? 'timeout' : 'network' },
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new CanvasError(messageForStatus(response.status, body), {
      code: codeForStatus(response.status, body),
      status: response.status,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new CanvasError('Canvas returned a response that could not be read as JSON.', {
      code: 'parse',
    });
  }

  return { data, nextUrl: parseNextLink(response.headers.get('link')) };
};

/** GET every page of a paginated collection, following Link rel="next". */
const requestAll = async (firstUrl, token) => {
  const collected = [];
  let url = firstUrl;

  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const { data, nextUrl } = await request(url, token);
    if (!Array.isArray(data)) break;
    collected.push(...data);
    url = nextUrl;
  }
  return collected;
};

const buildUrl = (baseUrl, endpoint, params = {}) => {
  const url = new URL(`${baseUrl}/api/v1${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
    else url.searchParams.set(key, value);
  }
  return url.toString();
};

/** Validates the credentials and returns the account's display name. */
const getProfile = async (baseUrl, token) => {
  const { data } = await request(buildUrl(baseUrl, '/users/self/profile'), token);
  return { id: data.id, name: data.name || data.short_name || 'Canvas user' };
};

const shapeCourses = (raw) =>
  raw
    .filter((course) => course && course.id && !course.access_restricted_by_date)
    .map((course) => ({
      id: String(course.id),
      name: course.name || 'Untitled course',
      code: (course.course_code || course.name || '').trim() || 'Course',
    }));

const fetchCourseList = (baseUrl, token, endpoint) =>
  requestAll(
    buildUrl(baseUrl, endpoint, {
      enrollment_state: 'active',
      'state[]': 'available',
      per_page: '100',
    }),
    token,
  );

/**
 * Active courses, favorited-only by default.
 *
 * Canvas has a dedicated `/users/self/favorites/courses` endpoint for the
 * courses a user has starred on their dashboard. If nobody has starred
 * anything there (a common state — many students never touch the star icon),
 * that endpoint legitimately returns an empty list, which would otherwise
 * leave the note permanently blank. So an empty favorites result falls back
 * to the full active-course list, and the caller is told that happened so the
 * UI can explain it rather than silently showing something the user didn't ask for.
 *
 * @returns {Promise<{courses: object[], usedFallback: boolean}>}
 */
const getCourses = async (baseUrl, token, { favoritesOnly = true } = {}) => {
  if (!favoritesOnly) {
    return { courses: shapeCourses(await fetchCourseList(baseUrl, token, '/courses')), usedFallback: false };
  }

  const favorites = shapeCourses(await fetchCourseList(baseUrl, token, '/users/self/favorites/courses'));
  if (favorites.length > 0) return { courses: favorites, usedFallback: false };

  const all = shapeCourses(await fetchCourseList(baseUrl, token, '/courses'));
  return { courses: all, usedFallback: true };
};

/**
 * Current grade per course, keyed by course id — used only as chatbot
 * context, not shown elsewhere in the note. A student's own enrollment
 * record includes a `grades` sub-object with no extra scope beyond the token
 * they already granted; a course whose instructor hasn't posted a grade
 * simply comes back with null scores, which is normal, not an error.
 *
 * @returns {Promise<Record<string, {currentScore: number|null, currentGrade: string|null}>>}
 */
const getGrades = async (baseUrl, token) => {
  const enrollments = await requestAll(
    buildUrl(baseUrl, '/users/self/enrollments', { 'state[]': 'active', per_page: '100' }),
    token,
  );

  const grades = {};
  for (const enrollment of enrollments) {
    if (!enrollment || !enrollment.course_id) continue;
    const g = enrollment.grades || {};
    grades[String(enrollment.course_id)] = {
      currentScore: typeof g.current_score === 'number' ? g.current_score : null,
      currentGrade: g.current_grade || null,
    };
  }
  return grades;
};

/**
 * Assignments for one course.
 *
 * Canvas's `upcoming` bucket only covers work due in the FUTURE, so overdue
 * items would be invisible without also asking for the `overdue` bucket.
 * Both are fetched and merged by id.
 */
const getCourseAssignments = async (baseUrl, token, courseId) => {
  const forBucket = (bucket) =>
    requestAll(
      buildUrl(baseUrl, `/courses/${courseId}/assignments`, {
        bucket,
        'include[]': 'submission',
        order_by: 'due_at',
        per_page: '100',
      }),
      token,
    );

  const buckets = await Promise.all(
    ['upcoming', 'overdue'].map((bucket) =>
      forBucket(bucket).catch((error) => {
        // A single inaccessible course must not sink the whole refresh.
        if (error.code === 'auth') throw error;
        return [];
      }),
    ),
  );

  const byId = new Map();
  for (const assignment of buckets.flat()) {
    if (assignment && assignment.id) byId.set(String(assignment.id), assignment);
  }
  return [...byId.values()];
};

module.exports = {
  CanvasError,
  normalizeBaseUrl,
  parseNextLink,
  getProfile,
  getCourses,
  getCourseAssignments,
  getGrades,
  buildUrl,
};
