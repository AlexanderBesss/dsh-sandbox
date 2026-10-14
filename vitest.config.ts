import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

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
