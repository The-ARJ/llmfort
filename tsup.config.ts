import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index':             'src/index.ts',
    'tool-schema/index': 'src/tool-schema/index.ts',
    'prompt-safe/index': 'src/prompt-safe/index.ts',
    'cost-guard/index':  'src/cost-guard/index.ts',
    'struct-out/index':      'src/struct-out/index.ts',
    'context-trim/index':    'src/context-trim/index.ts',
    'retry-llm/index':       'src/retry-llm/index.ts',
    'error-normalize/index': 'src/error-normalize/index.ts',
    'cache-key/index':       'src/cache-key/index.ts',
    'stream-tools/index':    'src/stream-tools/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' }
  },
})
