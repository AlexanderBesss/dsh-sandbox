import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-fs': fileURLToPath(new URL('./stubs/dsh-fs.ts', import.meta.url)),
      '@deepseek-ai/dsh-shell': fileURLToPath(new URL('./stubs/dsh-shell.ts', import.meta.url)),
      '@deepseek-ai/dsh-subprocess': fileURLToPath(new URL('./stubs/dsh-subprocess.ts', import.meta.url)),
      '@deepseek-ai/dsh-terminal': fileURLToPath(new URL('./stubs/dsh-terminal.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    env: { DSH_DOCKER: '1' },
    testTimeout: 300000,
    hookTimeout: 300000,
  },
})
