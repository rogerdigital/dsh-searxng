import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  // Self-contained transpile: no project references, no type-check — mirrors
  // the standalone-plugin guidance in the dsh plugin publish guide.
  target: 'es2022',
  platform: 'node',
  clean: true,
})
