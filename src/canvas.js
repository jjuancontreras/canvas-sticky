'use strict';

/**
 * Canvas LMS REST client.
 *
 * Runs in Electron's main (Node) process only. Two reasons that matters:
 * the Canvas API sends no CORS headers so a renderer could not call it anyway,
 * and keeping it here means the access token never enters the page context.
 */

const { htmlToTextPreservingLinks, truncate } = require('./summarize');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_PAGES = 10;
const USER_AGENT = 'CanvasSticky/1.0';
const ANNOUNCEMENT_MAX_CHARS = 400;
const ANNOUNCEMENT_LOOKBACK_DAYS = 21;

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
      // The banner image a student (or their institution) set for the course
      // card on the Canvas dashboard — used as a faint background on task
      // cards. Null for courses with no image, which is common.
      imageUrl: course.image_download_url || null,
    }));

const fetchCourseList = (baseUrl, token, endpoint) =>
  requestAll(
    buildUrl(baseUrl, endpoint, {
      enrollment_state: 'active',
      'state[]': 'available',
      'include[]': 'course_image',
      per_page: '100',
    }),
    token,
  );

/**
 * Downloads a course's banner image and inlines it as a data: URL, capped at
 * a modest size. Runs in the main process, same as every other Canvas call —
 * the renderer never fetches a remote URL itself. Failures (network, size
 * cap, non-image response) just mean that course's task cards render with no
 * background image; never worth failing a whole refresh over.
 */
const IMAGE_MAX_BYTES = 400 * 1024;

const fetchCourseImageDataUrl = async (imageUrl, token) => {
  let response;
  try {
    response = await fetch(imageUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return null;

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > IMAGE_MAX_BYTES) return null;

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
  if (buffer.length > IMAGE_MAX_BYTES) return null;

  return `data:${contentType};base64,${buffer.toString('base64')}`;
};

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
 * The color you (or Canvas's own default palette) assigned each course on
 * your dashboard — the same colors Canvas's calendar and sidebar use.
 * `/users/self/colors` returns every colored "asset" you have (courses,
 * groups, your own user id); only the `course_<id>` keys are relevant here.
 *
 * @returns {Promise<Record<string, string>>} courseId -> hex color
 */
const getCourseColors = async (baseUrl, token) => {
  const { data } = await request(buildUrl(baseUrl, '/users/self/colors'), token);
  const raw = data && typeof data.custom_colors === 'object' ? data.custom_colors : {};

  const colors = {};
  for (const [key, hex] of Object.entries(raw)) {
    const match = /^course_(\d+)$/.exec(key);
    if (match && typeof hex === 'string' && /^#[0-9a-f]{3,8}$/i.test(hex)) colors[match[1]] = hex;
  }
  return colors;
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
        // submission_comments rides along on the same call — this is how
        // instructor feedback reaches the chatbot without a second request
        // per assignment.
        'include[]': ['submission', 'submission_comments'],
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

/**
 * Course modules (the ordered content outline: readings, pages, files,
 * sub-assignments). Shaped down to just the fields the chatbot prompt can
 * use before it ever leaves this file — raw Canvas module-item objects carry
 * a lot of fields (internal ids, publish/completion metadata) with no use
 * here. `url` is kept specifically so the chatbot can hand back a direct
 * link to a module item (e.g. "here's the class modality page").
 */
const shapeModules = (raw) =>
  raw
    .filter((m) => m && m.published !== false)
    .map((m) => ({
      id: String(m.id),
      name: m.name || 'Untitled module',
      items: (Array.isArray(m.items) ? m.items : [])
        .filter((item) => item && item.published !== false && item.title)
        .slice(0, 15)
        .map((item) => ({
          title: item.title,
          type: item.type || 'Item',
          url: item.html_url || item.external_url || null,
        })),
    }));

const getModules = async (baseUrl, token, courseId) => {
  const raw = await requestAll(
    buildUrl(baseUrl, `/courses/${courseId}/modules`, { 'include[]': 'items', per_page: '50' }),
    token,
  );
  return shapeModules(raw);
};

/**
 * Recent announcements across every course in scope, in one call — Canvas's
 * `/announcements` endpoint takes a list of `context_codes[]` rather than
 * needing one request per course. Bounded to the last three weeks so an old
 * course with years of announcements doesn't balloon the chatbot's context.
 *
 * `summary` keeps any hyperlinks in the announcement body (a Zoom/Meet link,
 * a syllabus link, etc.) as plain "label (url)" text — see
 * htmlToTextPreservingLinks — and `url` is the announcement's own Canvas
 * page, so the chatbot always has a link to fall back on even when the body
 * itself has none.
 */
const shapeAnnouncements = (raw) =>
  raw
    .filter((a) => a && a.title)
    .map((a) => ({
      id: String(a.id),
      courseId: a.context_code ? String(a.context_code).replace(/^course_/, '') : '',
      title: a.title,
      postedAt: a.posted_at || a.created_at || null,
      summary: truncate(htmlToTextPreservingLinks(a.message), ANNOUNCEMENT_MAX_CHARS),
      url: a.html_url || null,
    }));

const getAnnouncements = async (baseUrl, token, courseIds) => {
  if (!Array.isArray(courseIds) || courseIds.length === 0) return [];

  const since = new Date(Date.now() - ANNOUNCEMENT_LOOKBACK_DAYS * 86400000).toISOString();
  const raw = await requestAll(
    buildUrl(baseUrl, '/announcements', {
      'context_codes[]': courseIds.map((id) => `course_${id}`),
      start_date: since,
      per_page: '30',
    }),
    token,
  );
  return shapeAnnouncements(raw);
};

module.exports = {
  CanvasError,
  normalizeBaseUrl,
  parseNextLink,
  getProfile,
  getCourses,
  getCourseAssignments,
  getGrades,
  getCourseColors,
  getModules,
  getAnnouncements,
  fetchCourseImageDataUrl,
  buildUrl,
};
