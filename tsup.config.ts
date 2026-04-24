import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'index':             'src/index.ts',
    'tool-schema/index': 'src/tool-schema/index.ts',
    'prompt-safe/index': 'src/prompt-safe/index.ts',
    'cost-guard/index':  'src/cost-guard/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  splitting: false,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' }
  },
})
