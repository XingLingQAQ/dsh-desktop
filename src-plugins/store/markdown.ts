/**
 * Render a GitHub README to HTML the store detail page owns end to end.
 *
 * The platform MarkdownText renders GFM + KaTeX but strips/escapes raw HTML, so
 * READMEs that lean on <p align>, <img>, badge <a><img></a>, <h1 align>, <table>,
 * <details> render as a wall of literal tags or lose structure. MarkdownText
 * also forces every <img> to display:block, which stacks badges one-per-line.
 *
 * Instead, parse the README with `marked` (GFM: tables, task lists, autolinks,
 * strikethrough) and sanitize with `dompurify`. Sanitization keeps raw-HTML
 * READMEs safe to render AND preserves the badge/banner/table markup GitHub
 * authors actually wrote, so the CSS can lay them out like GitHub does. A
 * post-pass adds GitHub-style heading slugs (via github-slugger) so in-README
 * anchor links resolve.
 */

import DOMPurify from 'dompurify'
import { marked } from 'marked'
import GithubSlugger from 'github-slugger'

marked.setOptions({
  gfm: true,
  // READMEs use blank lines for paragraph breaks; preserve them, not line breaks.
  breaks: false,
})

// Lean on DOMPurify's maintained default allowlists for tags/attrs (broad enough
// for README content) and only narrow the URI scheme + harden external links.
DOMPurify.setConfig({
  // README images: raw.githubusercontent, shields.io, camo; some embed data:.
  ALLOWED_URI_REGEXP: /^(?:(?:https?:|mailto:|tel:|data:image\/|\/|#)|\.\/|\.\.\/)/i,
  ALLOW_DATA_ATTR: true,
  // DOMPurify drops the legacy `align` attr by default, but READMEs lean on
  // <p align="center"> / <h1 align="center"> to center badge rows, banners, and
  // taglines. Keep it so the CSS can honor the author's intent (it sets no
  // script/style, only a presentational hint — safe to allow).
  ADD_ATTR: ['align'],
})

// External README links open in a new tab without leaking referrer — the webview
// is the user's local surface, and target/rel set in this hook survive serialization.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('href')) {
    const href = node.getAttribute('href') ?? ''
    if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noopener noreferrer')
    }
  }
  return node
})

/**
 * Stamp <h1>..<h6> with GitHub-compatible id slugs so README TOC anchors like
 * `[Features](#features)` resolve. DOMPurify keeps `id`, so run this after sanitize
 * on the final HTML. github-slugger dedupes repeats (`features`, `features-1`).
 */
function addHeadingIds(html: string, slugger: GithubSlugger): string {
  // `[^>]*` (not `\s...`) so bare `<h1>text</h1>` matches too — marked emits
  // headings with no attributes, so the old `\s`-after-tagname anchor missed
  // every heading. attrs carries a leading space when present (e.g.
  // ` align="center"`); trim + rejoin so output stays clean either way.
  return html.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi, (_m, depth: string, attrs: string, inner: string) => {
    // Leave an author-supplied id alone; only add one where none exists.
    if (/\bid\s*=/.test(attrs)) return _m
    const slug = slugger.slug(inner.replace(/<[^>]+>/g, '').trim())
    const kept = attrs.trim()
    return `<h${depth}${kept ? ` ${kept}` : ''} id="${slug}">${inner}</h${depth}>`
  })
}

/**
 * Parse + sanitize a README into HTML safe to inject into the detail page.
 * Returns an empty string for empty input so the caller's loading/null states
 * stay the source of truth.
 *
 * marked is synchronous for our option set (no async extensions) and DOMPurify
 * is synchronous in the browser, so this is a plain string -> string.
 */
export function renderReadmeHtml(raw: string): string {
  if (raw.trim() === '') return ''
  const dirty = marked.parse(raw, { async: false }) as string
  const clean = DOMPurify.sanitize(dirty) as string
  return addHeadingIds(clean, new GithubSlugger())
}
