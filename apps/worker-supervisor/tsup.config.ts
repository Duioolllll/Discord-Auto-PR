import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  external: [/^@hub\//],
  clean: true,
  sourcemap: true,
});
