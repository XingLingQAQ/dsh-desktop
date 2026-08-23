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
 * Keep PLATFORM in step with `packages/client/web/src/seed.ts` upstream. A word
 * missing here gets bundled in; a word listed here but absent upstream becomes a
 * `require` miss at materialization.
 */

const PLATFORM = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const PLUGIN_ID = '@dsh-desktop/store'

export default defineConfig({
  // The shell's own config owns `src/`; this one only builds plugin bundles.
  root: __dirname,
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  build: {
    outDir: 'dist-plugins',
    emptyOutDir: true,
    // A plugin's styles must travel inside the bundle: the module system fetches
    // one script and nothing else. The plugin injects its own <style> tag, which
    // DSH claims for it during materialization.
    cssCodeSplit: false,
    target: 'es2020',
    minify: false,
    lib: {
      entry: 'src-plugins/store/index.tsx',
      formats: ['cjs'],
      fileName: () => 'store.js',
    },
    rollupOptions: {
      external: PLATFORM,
      output: {
        // `exports`/`module` come from the wrapper, `require` from the factory
        // parameter — exactly the CJS surface the module system provides.
        banner: [
          `window.__ModuleLoader__.load({`,
          `  id: ${JSON.stringify(PLUGIN_ID)},`,
          `  factory: function (require) {`,
          `var module = { exports: {} };`,
          `var exports = module.exports;`,
        ].join('\n'),
        footer: ['return module.exports;', '  },', '});'].join('\n'),
      },
    },
  },
})
