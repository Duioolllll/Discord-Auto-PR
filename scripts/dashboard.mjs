import { existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const environment = new URL('../.env', import.meta.url);
if (existsSync(environment)) process.loadEnvFile(fileURLToPath(environment));
process.chdir(fileURLToPath(new URL('../apps/dashboard', import.meta.url)));
// Next dev respawns a server and copies execArgv to NODE_OPTIONS; --env-file is disallowed there.
await import(new URL('../apps/dashboard/node_modules/next/dist/bin/next', import.meta.url).href);
