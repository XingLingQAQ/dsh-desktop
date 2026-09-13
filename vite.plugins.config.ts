import { defineConfig } from 'vite'

/**
 * Builds the desktop's built-in DSH client plugins.
 *
 * A plugin bundle is not an application: the DSH module system hands the factory
 * a `require` and expects a CommonJS module back, resolving externals against a
 * frozen table of platform words. So the output is CJS with every one of those
 * words external — bundling React would give the plugin a second copy and break
 * hooks — wrapped in the registration call the module system listens for.
 *
 * PLATFORM must mirror the seed table of the client the shell ACTUALLY serves,
 * not the upstream source tree. A word missing here gets bundled in (fine); a
 * word listed here but absent at runtime becomes a `require` miss that takes
 * down EVERY plugin in the page at once, not just the one that asked for it.
 *
 * Verified live against the pinned harness by reading `__DSH_MODULES__.seed`
 * in the webview: the map holds exactly the seven words below. Upstream's
 * `platform.ts` additionally lists `dsh-client-web-react`, `ui-attachment` and
 * `schema-form`, but the served bundle does not seed them — requiring any of
 * the three is a hard failure. If a plugin genuinely needs one, bump the
 * harness rather than adding it here.
 */

const PLATFORM = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const PLUGINS = [
  { id: '@dsh-desktop/store', entry: 'src-plugins/store/index.tsx', out: 'store.js' },
  { id: '@dsh-desktop/models-manager', entry: 'src-plugins/models-manager/index.tsx', out: 'models-manager.js' },
  { id: '@dsh-desktop/usage', entry: 'src-plugins/usage/index.tsx', out: 'usage.js' },
]

export default defineConfig({
  // The shell's own config owns `src/`; this one only builds plugin bundles.
  root: __dirname,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  define: {
    // `motion` reads process.env.NODE_ENV at render (useStrictMode /
    // AnimatePresence). The DSH webview is a browser page with no `process`
    // global, so the expression must be folded away at build time. The shell
    // dev server serves the app unbundled with NODE_ENV=development, and the
    // plugin runs in that same page — match it.
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
  build: {
    outDir: 'dist-plugins',
    emptyOutDir: true,
    // A plugin's styles must travel inside the bundle: the module system fetches
    // one script and nothing else. The plugin injects its own <style> tag, which
    // DSH claims for it during materialization.
    cssCodeSplit: false,
    target: 'es2020',
    minify: false,
    rollupOptions: {
      input: Object.fromEntries(PLUGINS.map(p => [p.id, p.entry])),
      external: PLATFORM,
      // Vite's app-mode default for this is `false`, which tells rollup the
      // entry is an application and lets it drop the entry's exports. The
      // factory body still runs — styles inject, requires resolve — but
      // `module.exports` comes back empty and cordis rejects a plugin with no
      // `apply`. `lib.formats` used to imply this; an explicit `input` map does not.
      preserveEntrySignatures: 'strict',
      output: {
        // `lib.formats` used to set this; with an explicit `input` map the
        // format has to be named here or rollup emits ESM `import`s, which the
        // CJS factory wrapper cannot host.
        format: 'cjs',
        // One self-contained file per plugin: the module system fetches a single
        // script per id, so shared code must be duplicated into each bundle
        // rather than hoisted into a chunk nobody loads.
        inlineDynamicImports: false,
        entryFileNames: (chunkInfo) => {
          const plugin = PLUGINS.find(p => p.id === chunkInfo.name)
          return plugin ? plugin.out : '[name].js'
        },
        // `exports`/`module` come from the wrapper, `require` from the factory
        // parameter — exactly the CJS surface the module system provides.
        banner: (chunkInfo) => {
          const plugin = PLUGINS.find(p => p.id === chunkInfo.name)
          if (!plugin) return ''
          return [
            `window.__ModuleLoader__.load({`,
            `  id: ${JSON.stringify(plugin.id)},`,
            `  factory: function (require) {`,
            `var module = { exports: {} };`,
            `var exports = module.exports;`,
          ].join('\n')
        },
        footer: (chunkInfo) => {
          const plugin = PLUGINS.find(p => p.id === chunkInfo.name)
          return plugin ? ['return module.exports;', '  },', '});'].join('\n') : ''
        },
      },
    },
  },
})
