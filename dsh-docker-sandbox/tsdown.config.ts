import { defineConfig } from 'tsdown'

/** The Loader entry name the DSH client module system registers this bundle under. */
const CLIENT_ID = 'dsh-docker-sandbox'

/**
 * The DSH client module system consumes a lazy-CJS bundle: the file registers a
 * factory through `window.__ModuleLoader__.load`, and the factory receives the
 * platform `require` for its externals. `tsdown` emits the CJS body; the banner
 * and footer supply the registration wrapper, matching the shape the shipped
 * client plugins ship (`var module = { exports: {} } … return module.exports`).
 */
const banner = [
  `window.__ModuleLoader__.load({`,
  `\tid: ${JSON.stringify(CLIENT_ID)},`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
].join('\n')

const footer = `\t\treturn module.exports;\n\t}\n});`

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  dts: false,
  clean: false,
  // The package is `"type": "module"`, so tsdown would emit `.cjs`; the client
  // loader is handed the exports target as a script, so keep the `.js` name the
  // shipped client plugins use.
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-modules',
    ],
  },
  banner,
  footer,
})
