'use strict';

/**
 * Turns a Canvas assignment description (arbitrary teacher-authored HTML) into
 * plain text for the sticky note: a one-line brief, and a bulleted detail
 * breakdown. No AI involved here — strip, clean, and cut at a sensible
 * boundary. (Optional AI versions of both live in ai-summarize.js and simply
 * overwrite these when a Gemini key is configured.)
 */

const SUMMARY_MAX_CHARS = 150;
const FULL_TEXT_MAX_CHARS = 2000;
const DETAIL_MAX_LINES = 8;
const DETAIL_LINE_MAX_CHARS = 200;

// Leading labels teachers habitually type before the actual instructions.
const BOILERPLATE_PREFIX =
  /^(instructions?|overview|description|details|assignment|task|directions?|prompt|objectives?|summary)\s*[:.\-–—]?\s*/i;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', middot: '·',
  bull: '•', deg: '°', eacute: 'é', times: '×',
};

const decodeEntities = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);

const safeCodePoint = (code) => {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
};

/** Full HTML -> readable plain text, preserving paragraph breaks as spaces. */
const htmlToText = (html) => {
  if (!html || typeof html !== 'string') return '';

  const text = html
    // Drop anything whose contents should never be read as prose.
    .replace(/<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Keep list items and block ends from gluing words together.
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<li\b[^>]*>/gi, ' • ')
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

  return decodeEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Same idea as htmlToText, but keeps hyperlinks instead of throwing them
 * away — a `<a href="...">Join on Zoom</a>` becomes `Join on Zoom
 * (https://...)`. This is what feeds the chatbot's context, so it can
 * actually hand back a class's meeting link, a module item's link, etc.,
 * as a plain URL the renderer then turns into a clickable link.
 */
const htmlToTextPreservingLinks = (html) => {
  if (!html || typeof html !== 'string') return '';

  const withLinks = html.replace(
    /<a\b[^>]*\shref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      const label = inner.replace(/<[^>]+>/g, '').trim();
      return label && label !== href ? `${label} (${href})` : href;
    },
  );

  return htmlToText(withLinks);
};

// A control character that can never appear in real HTML text, used as a
// throwaway line-break marker below — a literal space or newline would
// collide with ordinary text and break the split.
const LINE_MARKER = '';

/**
 * Same idea as htmlToText, but keeps block/list boundaries as separate lines
 * instead of collapsing everything into one paragraph. This is what the
 * no-AI "detail" breakdown is built from — a bulleted list is still more
 * scannable than one long sentence, even without an LLM.
 */
const htmlToLines = (html) => {
  if (!html || typeof html !== 'string') return [];

  const text = html
    .replace(/<(script|style|noscript|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, LINE_MARKER)
    .replace(/<!--[\s\S]*?-->/g, LINE_MARKER)
    .replace(/<li\b[^>]*>/gi, `${LINE_MARKER}- `)
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, LINE_MARKER)
    .replace(/<br\s*\/?>/gi, LINE_MARKER)
    .replace(/<[^>]+>/g, '')
    .replace(/ /g, ' ');

  return decodeEntities(text)
    .split(LINE_MARKER)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
};

/** Cut to the first sentence, else to a word boundary under `limit`. */
const truncate = (text, limit) => {
  if (text.length <= limit) return text;

  const window = text.slice(0, limit + 1);
  const sentenceEnd = window.search(/[.!?](\s|$)/);
  if (sentenceEnd > 40) return window.slice(0, sentenceEnd + 1).trim();

  const lastSpace = window.lastIndexOf(' ');
  const cut = lastSpace > 40 ? lastSpace : limit;
  return `${text.slice(0, cut).trim()}…`;
};

const SUBMISSION_LABELS = {
  online_quiz: 'Quiz',
  online_upload: 'File upload',
  online_text_entry: 'Text entry',
  online_url: 'Website URL',
  discussion_topic: 'Discussion post',
  media_recording: 'Media recording',
  on_paper: 'Submitted on paper',
  external_tool: 'External tool',
  none: 'No submission',
  not_graded: 'Not graded',
};

/**
 * Fallback line for assignments with no description at all (very common for
 * quizzes): describe what the thing actually is, from its metadata.
 */
const describeFromMetadata = (assignment) => {
  const parts = [];

  const types = Array.isArray(assignment.submission_types) ? assignment.submission_types : [];
  const label = types.map((t) => SUBMISSION_LABELS[t]).find(Boolean);
  if (label) parts.push(label);

  if (typeof assignment.points_possible === 'number' && assignment.points_possible > 0) {
    parts.push(`${assignment.points_possible} pts`);
  }
  if (assignment.allowed_attempts > 0) {
    parts.push(`${assignment.allowed_attempts} attempt${assignment.allowed_attempts === 1 ? '' : 's'}`);
  }

  return parts.length ? parts.join(' · ') : 'No description provided.';
};

/** Newline-joined bullet breakdown, used when there's no AI key to do better. */
const localDetail = (assignment) => {
  const lines = htmlToLines(assignment.description);
  if (lines.length === 0) return describeFromMetadata(assignment);

  return lines
    .slice(0, DETAIL_MAX_LINES)
    .map((line) => truncate(line, DETAIL_LINE_MAX_CHARS))
    .join('\n');
};

/**
 * @returns {{summary: string, detail: string, fullText: string}}
 *   summary  - one line, for the collapsed card
 *   detail   - newline-separated bullet breakdown, for the expanded card
 *   fullText - full cleaned text, kept only as AI prompt input (never rendered directly)
 */
const summarize = (assignment = {}) => {
  // The one-line card summary stays link-free — a raw "(https://...)" would
  // just be clutter on a collapsed card. fullText keeps links, since that's
  // what feeds the AI prompt and the chatbot's context, where a class's
  // Zoom/Meet link or similar is exactly the kind of thing worth surfacing.
  const plainText = truncate(htmlToText(assignment.description), FULL_TEXT_MAX_CHARS);
  const fullText = truncate(htmlToTextPreservingLinks(assignment.description), FULL_TEXT_MAX_CHARS);

  if (!plainText) {
    const fallback = describeFromMetadata(assignment);
    return { summary: fallback, detail: fallback, fullText: fallback };
  }

  const cleaned = plainText.replace(BOILERPLATE_PREFIX, '').trim() || plainText;
  return {
    summary: truncate(cleaned, SUMMARY_MAX_CHARS),
    detail: localDetail(assignment),
    fullText,
  };
};

module.exports = {
  summarize, htmlToText, htmlToTextPreservingLinks, htmlToLines, localDetail, truncate, describeFromMetadata,
};
