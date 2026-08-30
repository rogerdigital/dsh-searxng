import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: 'esm' as const,
  dts: true,
  target: 'es2022',
  platform: 'node' as const,
}

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    clean: true,
  },
  {
    ...shared,
    entry: { cli: 'src/cli.ts' },
    clean: false,
    dts: false,
    // The npx CLI must work before a DSH host resolves this plugin's peers.
    deps: { alwaysBundle: [/.*/], onlyBundle: false },
  },
])
