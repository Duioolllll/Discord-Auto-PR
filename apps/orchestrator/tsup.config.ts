import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/main.ts', 'src/service.ts', 'src/outbox.ts'],
  format: ['esm'],
  external: [/^@hub\//],
  clean: true,
  sourcemap: true,
});
