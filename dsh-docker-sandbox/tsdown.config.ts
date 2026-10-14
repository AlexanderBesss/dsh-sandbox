import { defineConfig } from 'tsdown'

const CLIENT_ID = 'dsh-docker-sandbox'

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
