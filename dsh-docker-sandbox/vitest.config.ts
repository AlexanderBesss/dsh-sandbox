import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The DSH seam packages (`dsh-fs`, `dsh-shell`, …) are provided by the app at
 * runtime and are deliberately not installed here — the plugin compiles against
 * the ambient declarations in `src/seams.d.ts`. Unit tests therefore resolve
 * them to minimal stand-ins that carry just the runtime shape the plugin
 * touches: the `Service` base and the error classes it throws.
 */
const stub = (name: string) => fileURLToPath(new URL(`./test/stubs/${name}.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-fs': stub('dsh-fs'),
      '@deepseek-ai/dsh-shell': stub('dsh-shell'),
      '@deepseek-ai/dsh-subprocess': stub('dsh-subprocess'),
      '@deepseek-ai/dsh-terminal': stub('dsh-terminal'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
})
