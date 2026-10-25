import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const source = fileURLToPath(new URL('../../', import.meta.url));
export const cliIds = {
  app: '123456789012345678',
  guild: '234567890123456789',
  user: '345678901234567890',
};
export const cliFakeToken = 'test-only-discord-token-never-send-to-discord';
export async function discordCliFixture() {
  const root = await mkdtemp(join(tmpdir(), 'hub-discord-cli-'));
  const files = [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'scripts/local-env.mjs',
    'scripts/discord.ts',
    'scripts/discord-config.ts',
    'apps/discord-bot/package.json',
    ...['main', 'commands', 'control-client', 'integration'].map(
      (name) => `apps/discord-bot/src/${name}.ts`,
    ),
  ];
  for (const path of files) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await copyFile(join(source, path), join(root, path));
  }
  await mkdir(join(root, 'node_modules'));
  await symlink(join(source, 'node_modules/tsx'), join(root, 'node_modules/tsx'));
  await mkdir(join(root, 'apps/discord-bot/node_modules'), { recursive: true });
  await symlink(
    join(source, 'apps/discord-bot/node_modules/discord.js'),
    join(root, 'apps/discord-bot/node_modules/discord.js'),
  );
  const state = {
    calls: [] as { method: string; path: string }[],
    commands: [{ name: 'unmanaged', type: 1, description: 'Preserve' }] as Record<
      string,
      unknown
    >[],
    guildQueries: 0,
    emptyGuildsFirst: false,
    discordStatus: 200,
    stallAuthentication: false,
    registrationStatus: 200,
    apiStatus: 200,
    gatewayReplies: [] as { content: string; allowedMentions: { parse: string[] } }[],
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://127.0.0.1').pathname;
    state.calls.push({ method: request.method!, path });
    response.setHeader('content-type', 'application/json');
    const send = (value: unknown, status = 200) => {
      response.statusCode = status;
      response.end(JSON.stringify(value));
    };
    if (path.startsWith('/api/v10/')) {
      if (request.headers.authorization !== `Bot ${cliFakeToken}`)
        return send({ message: 'invalid test authentication', code: 0 }, 401);
      if (state.discordStatus !== 200)
        return send(
          { message: 'Test rejection without raw response exposure', code: 0 },
          state.discordStatus,
        );
      if (path.endsWith('/oauth2/applications/@me')) {
        if (state.stallAuthentication) return;
        return send({ id: cliIds.app });
      }
      if (path.endsWith('/users/@me/guilds')) {
        state.guildQueries++;
        return send(
          state.emptyGuildsFirst && state.guildQueries === 1
            ? []
            : [{ id: cliIds.guild, name: 'Test server' }],
        );
      }
      if (path === `/api/v10/guilds/${cliIds.guild}`)
        return send({ id: cliIds.guild, name: 'Test server' });
      if (path === `/api/v10/applications/${cliIds.app}/guilds/${cliIds.guild}/commands`) {
        if (request.method === 'GET') return send(state.commands);
        if (request.method === 'POST') {
          if (state.registrationStatus !== 200)
            return send({ code: 50013, message: 'test-only denied' }, state.registrationStatus);
          let body = '';
          for await (const chunk of request) body += chunk;
          const command = { ...JSON.parse(body), type: 1 };
          const index = state.commands.findIndex(
            (item) => item.name === command.name && item.type === 1,
          );
          if (index < 0) state.commands.push(command);
          else state.commands[index] = command;
          return send(command, 201);
        }
      }
      return send({ code: 10004, message: 'Unknown test guild' }, 404);
    }
    if (path === '/gateway-reply') {
      let body = '';
      for await (const chunk of request) body += chunk;
      state.gatewayReplies.push(JSON.parse(body));
      return send({ ok: true });
    }
    if (state.apiStatus !== 200) return send({ error: 'UNAUTHORIZED' }, state.apiStatus);
    if (path === '/readyz') return send({ ok: true });
    if (path === '/me') return send({ id: `discord:${cliIds.user}`, admin: false });
    if (path === '/repositories') return send([{ fullName: 'test/installed', enabled: true }]);
    return send({ error: 'NOT_FOUND' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  const adapter = join(root, 'test-integration.mjs');
  const clientAdapter = join(root, 'test-client.mjs');
  const preload = join(root, 'test-preload.mjs');
  const integrationUrl = pathToFileURL(join(root, 'apps/discord-bot/src/integration.ts')).href;
  await writeFile(
    adapter,
    `export * from ${JSON.stringify(integrationUrl)};\nimport { discordRest as original } from ${JSON.stringify(integrationUrl)};\nexport function discordRest(token,signal) { const rest=original(token,signal); rest.options.api=${JSON.stringify(base + '/api')}; rest.options.timeout=500; return rest; }\n`,
  );
  await writeFile(
    clientAdapter,
    `import { createRequire } from 'node:module';\nconst sdk=createRequire(${JSON.stringify(pathToFileURL(join(root, 'apps/discord-bot/package.json')).href)})('discord.js');\nexport const Events=sdk.Events; export const GatewayIntentBits=sdk.GatewayIntentBits;\nexport class Client extends sdk.Client {\n async login() { this.keepAlive=setInterval(()=>{},1000); this.emit(Events.ClientReady,this); const interaction={ guildId:${JSON.stringify(cliIds.guild)}, commandName:'help', id:'test-interaction', user:{id:${JSON.stringify(cliIds.user)}}, options:{}, isAutocomplete:()=>false, isChatInputCommand:()=>true, deferReply:async()=>{}, editReply:async(reply)=>{await fetch(${JSON.stringify(base + '/gateway-reply')},{method:'POST',body:JSON.stringify(reply)});} }; this.emit(Events.InteractionCreate,{...interaction,guildId:'999999999999999999',isChatInputCommand:()=>{throw Error('wrong guild dispatched');}}); this.emit(Events.InteractionCreate, interaction); return 'test-only'; }\n async destroy(){clearInterval(this.keepAlive);await super.destroy();}\n}\n`,
  );
  await writeFile(
    preload,
    `import { registerHooks } from 'node:module';\nimport net from 'node:net';\nconst connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){let options=args[0];if(Array.isArray(options))options=options[0];const host=typeof options==='object'?(options.host??options.hostname??'localhost'):(typeof args[1]==='string'?args[1]:'localhost');if(!['127.0.0.1','localhost','::1'].includes(host))throw Error('External network disabled in CLI test');return connect.apply(this,args);};\nregisterHooks({resolve(specifier,context,next){ const parent=context.parentURL??''; if((parent.endsWith('/scripts/discord.ts')||parent.endsWith('/apps/discord-bot/src/main.ts')) && specifier.endsWith('/integration.js')) return {url:${JSON.stringify(pathToFileURL(adapter).href)},shortCircuit:true}; if(parent.endsWith('/apps/discord-bot/src/main.ts')&&specifier==='discord.js')return {url:${JSON.stringify(pathToFileURL(clientAdapter).href)},shortCircuit:true}; return next(specifier,context); }});\n`,
  );
  await writeFile(
    join(root, '.env'),
    `# Test configuration only\nCONTROL_API_URL=${base}\nADMIN_API_TOKEN=\nBOT_API_TOKEN=\nWORKER_ENROLLMENT_TOKEN=\nGITHUB_WEBHOOK_SECRET=\nDASHBOARD_SESSION_SECRET=\nGITHUB_APP_ID=keep-test-value\n`,
    { mode: 0o600 },
  );
  const children = new Set<ChildProcessWithoutNullStreams>();
  function run(command: string, terminal = false) {
    const args = command.split(' ');
    // The script command is fixed test code; no credentials or user input enter the shell command.
    const child = terminal
      ? spawn('script', ['-qefc', `pnpm ${command}`, '/dev/null'], {
          cwd: root,
          detached: true,
          env: environment(),
        })
      : spawn('pnpm', args, { cwd: root, detached: true, env: environment() });
    children.add(child);
    let output = '';
    child.stdout.on('data', (value) => {
      output += value.toString();
    });
    child.stderr.on('data', (value) => {
      output += value.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        children.delete(child);
        resolve(code);
      });
    });
    let consumed = 0;
    const waitFor = async (marker: string, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const clean = stripVTControlCharacters(output);
        const index = clean.indexOf(marker, consumed);
        if (index >= 0) {
          consumed = index + marker.length;
          return;
        }
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`CLI exited before ${marker}: ${clean}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`CLI deadline before ${marker}: ${stripVTControlCharacters(output)}`);
    };
    const reply = async (marker: string, answer = '') => {
      await waitFor(marker);
      child.stdin.write(`${answer}\n`);
    };
    const finish = async (timeout = 15000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('CLI did not exit')), timeout);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    return { child, waitFor, reply, finish, output: () => stripVTControlCharacters(output) };
  }
  function environment(): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      PATH: process.env.PATH!,
      COREPACK_HOME: process.env.COREPACK_HOME,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      NO_PROXY: '127.0.0.1,localhost',
      TERM: 'xterm',
      LANG: 'C.UTF-8',
      SHELL: '/bin/sh',
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    };
  }
  async function stop(child: ChildProcessWithoutNullStreams) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        if (child.pid)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* Already exited. */
          }
        resolve();
      }, 1000);
      timer.unref();
    });
  }
  return {
    root,
    state,
    run,
    stop,
    readEnvironment: () => readFile(join(root, '.env'), 'utf8'),
    close: async () => {
      await Promise.all([...children].map(stop));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { force: true, recursive: true });
    },
  };
}
