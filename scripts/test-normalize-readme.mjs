// Standalone sanity check for normalizeReadme: run the exact algorithm from
// src-plugins/store/markdown.ts against the ModLens banner the user pasted,
// so we can eyeball the GFM output before rebuilding the store bundle.
// (Keep this in sync with markdown.ts if the algorithm changes.)

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-zA-Z]+));/g, (m, hex, dec, name) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16))
    if (dec) return String.fromCodePoint(parseInt(dec, 10))
    return NAMED_ENTITIES[name] ?? m
  })
}
function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  return m ? m[1] : ''
}
function stripTags(s) {
  return s.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g, '')
}
function protectCode(s) {
  const store = []
  const stash = (m) => { store.push(m); return ` C${String(store.length - 1)} ` }
  let text = s.replace(/```[\s\S]*?```/g, stash)
  text = text.replace(/~~~[\s\S]*?~~~/g, stash)
  text = text.replace(/`[^`\n]+`/g, stash)
  return { text, store }
}
function restoreCode(s, store) {
  return s.replace(/ C(\d+) /g, (_m, i) => store[Number(i)] ?? '')
}
function normalizeReadme(raw) {
  const { text: protected0, store } = protectCode(raw)
  let s = protected0
  s = s.replace(/<img\b[^>]*>/gi, (m) => {
    const src = attr(m, 'src')
    return src ? `![${attr(m, 'alt')}](${src})` : ''
  })
  s = s.replace(/<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
    const text = inner.trim()
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(text)) return `[${text}](${href})`
    const plain = stripTags(inner).trim()
    return href && plain ? `[${plain}](${href})` : plain
  })
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, inner) => {
    return `\n\n${'#'.repeat(Number(n))} ${stripTags(inner).trim()}\n\n`
  })
  s = s.replace(/<br\s*\/?>/gi, '\n\n')
  s = s.replace(/<\/?(b|strong)\b[^>]*>/gi, '**')
  s = s.replace(/<\/?(i|em)\b[^>]*>/gi, '*')
  s = s.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
    const body = stripTags(inner).replace(/\n{2,}/g, '\n').trim()
    return '\n' + body.split('\n').map((l) => `> ${l}`).join('\n') + '\n'
  })
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => `\`${stripTags(inner)}\``)
  s = s.replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_m, inner) => `\n\n**${stripTags(inner).trim()}**\n\n`)
  s = s.replace(/<\/?details\b[^>]*>/gi, '')
  s = s.replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, ' | ')
  s = s.replace(/<tr\b[^>]*>/gi, '\n').replace(/<\/tr>/gi, '')
  s = s.replace(/<p\b[^>]*>/gi, '\n\n').replace(/<\/p>/gi, '\n\n')
  s = decodeEntities(stripTags(s))
  s = restoreCode(s, store)
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()
  return s
}

const banner = `<p align="center"> <img src="https://raw.githubusercontent.com/liustack/modlens/main/assets/banner.jpg" width="100%" alt="ModLens" /> </p> <h1 align="center">ModLens</h1> <p align="center"><b>Give a text-only model sight, and just paste the image.</b></p> <p align="center">🥇 <b>The most capable vision plugin for DeepSeek Harness (dsh)</b> 🥇</p> <p align="center"> <a href="./README.zh-CN.md">简体中文</a> · <a href="skills/modlens/references/configure.md">Configuration</a> · <a href="docs/troubleshooting.md">Troubleshooting</a> · <a href="docs/security.md">Security</a> · <a href="https://github.com/liustack/modsearch"><b>🔍 ModSearch (the best free web search plugin for DSH)</b></a> </p> <p align="center"> <a href="https://x.com/liustack"><img src="https://img.shields.io/badge/follow-%40liustack-black?style=flat-square&logo=x&logoColor=white" alt="Follow @liustack on X"></a> <a href="https://www.npmjs.com/package/@liustack/modlens"><img src="https://img.shields.io/npm/v/@liustack/modlens?style=flat-square&label=npm&color=cb3837" alt="npm"></a> <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/@liustack/modlens?style=flat-square" alt="Node.js"></a> <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a> <img src="https://img.shields.io/badge/Not%20backed%20by-Y%20Combinator-FF6600?style=flat-square&logo=ycombinator&logoColor=white" alt="Not backed by Y Combinator"> <img src="https://img.shields.io/badge/users-unknown-lightgrey?style=flat-square" alt="Users unknown"> </p>`

const out = normalizeReadme(banner)
console.log('===== normalizeReadme output =====')
console.log(out)
console.log('===== checks =====')
console.log('no-literal-<p =', !/<p\b/i.test(out))
console.log('no-literal-<h1 =', !/<h1\b/i.test(out))
console.log('no-literal-<img =', !/<img\b/i.test(out))
console.log('no-literal-<a =', !/<a\b/i.test(out))
console.log('no-literal-<b =', !/<b\b/i.test(out))
console.log('banner-image-present =', /!\[ModLens\]\(https:\/\/raw\.githubusercontent\.com\/liustack\/modlens\/main\/assets\/banner\.jpg\)/.test(out))
console.log('h1-ModLens-present =', /^# ModLens$/m.test(out))
console.log('badge-linked-image-present =', /\[!\[[^\]]*\]\([^)]*\)\]\(https:\/\/x\.com\/liustack\)/.test(out))
console.log('entities-decoded (follow-@liustack) =', out.includes('follow-@liustack-black'))
