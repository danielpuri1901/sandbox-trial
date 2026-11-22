// Sleep-and-wake trial: the same six timed steps against each sandbox provider.
// Usage: node --env-file=.env trial.mjs <e2b|daytona|sprites|modal|vercel|all>
import { appendFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const STEPS = ['create', 'write', 'sleep', 'wake', 'verify', 'destroy'];
const STEP_TIMEOUT_MS = 120_000;
const RESULTS = new URL('./results.jsonl', import.meta.url);

// Every provider runs these exact POSIX shell scripts.
const DIR = 'D="${HOME:-$PWD}/sleep-wake-trial"';
// "alive" only if the pid in the file is still our sleeper (guards against pid reuse after a reboot).
const PID_STATUS = [
  'p=$(cat "$D/pid" 2>/dev/null) || { echo pid=none; exit 0; }',
  'if tr "\\0" " " 2>/dev/null < "/proc/$p/cmdline" | grep -q "^sleep 600"; then echo pid=alive; else echo pid=dead; fi',
].join('\n');
const WRITE = (token) => [
  'set -e',
  DIR,
  'mkdir -p "$D"',
  `printf %s ${token} > "$D/token"`,
  // setsid moves the sleeper out of the exec session, so ending the session does not kill it.
  'if command -v setsid >/dev/null 2>&1; then nohup setsid sleep 600 >/dev/null 2>&1 & else nohup sleep 600 >/dev/null 2>&1 & fi',
  'echo $! > "$D/pid"',
  'sync',
].join('\n');
const CHECK = [DIR, PID_STATUS].join('\n');
const VERIFY = [DIR, 'echo "token=$(cat "$D/token" 2>/dev/null)"', PID_STATUS].join('\n');

const env = (k) => process.env[k];
const vercelCreds = () => ({ token: env('VERCEL_TOKEN'), teamId: env('VERCEL_TEAM_ID'), projectId: env('VERCEL_PROJECT_ID') });

// Each provider: create a sandbox at its default size, run a shell script (return stdout, throw on non-zero exit),
// sleep, wake, destroy. State lives on the context object `c`.
const PROVIDERS = {
  e2b: {
    pkg: 'e2b',
    env: ['E2B_API_KEY'],
    primitive: 'pause() (default mode "full": memory + filesystem) -> connect()',
    async create(c) {
      const { Sandbox } = await import('e2b');
      c.sbx = await Sandbox.create();
    },
    async run(c, script) {
      return (await c.sbx.commands.run(script)).stdout; // throws CommandExitError on a non-zero exit
    },
    async sleep(c) { await c.sbx.pause(); },
    async wake(c) { await c.sbx.connect(); },
    async destroy(c) { if (c.sbx) await c.sbx.kill(); },
  },

  daytona: {
    pkg: '@daytona/sdk',
    env: ['DAYTONA_API_KEY'],
    // Stopped and paused sandboxes are both billed for disk only; pause also keeps memory.
    primitive: 'pause() (memory + disk) -> resume()',
    async create(c) {
      const { Daytona } = await import('@daytona/sdk');
      c.sbx = await new Daytona().v2.create(); // platform default image and size
      // create() returns when its wait ends, even if the sandbox has not started yet.
      if (c.sbx.state !== 'started') await c.sbx.wait({ timeoutSeconds: 120 });
    },
    async run(c, script) {
      const r = await c.sbx.exec(script);
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode ?? r.reason}: ${r.stderr}`);
      return r.stdout;
    },
    async sleep(c) { await c.sbx.pause({ timeoutSeconds: 120 }); },
    async wake(c) { await c.sbx.resume({ timeoutSeconds: 120 }); },
    async destroy(c) { if (c.sbx) await c.sbx.delete({ timeoutSeconds: 120 }); },
  },

  sprites: {
    pkg: '@fly/sprites',
    env: ['SPRITES_TOKEN'],
    // The SDK has no sleep call: a Sprite pauses itself after about 30 s without exec activity.
    primitive: 'idle auto-pause (no SDK call; polled getSprite().status until warm or cold) -> next exec wakes it',
    async create(c) {
      const { SpritesClient } = await import('@fly/sprites');
      c.client = new SpritesClient(env('SPRITES_TOKEN'));
      c.sprite = await c.client.createSprite(`trial-${randomBytes(4).toString('hex')}`);
    },
    async run(c, script) {
      // exec() splits its string on spaces without a shell, so run sh explicitly.
      return String((await c.sprite.execFile('sh', ['-c', script])).stdout);
    },
    async sleep(c) {
      const end = Date.now() + STEP_TIMEOUT_MS;
      while (Date.now() < end) {
        const { status } = await c.client.getSprite(c.sprite.name);
        if (status === 'warm' || status === 'cold') return `reached ${status}`;
        await delay(2000);
      }
      throw new Error('Sprite did not report warm or cold');
    },
    async wake() {}, // the wake step's first exec wakes the Sprite
    async destroy(c) { if (c.sprite) await c.sprite.delete(); },
  },

  modal: {
    pkg: 'modal',
    env: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    // Only persistent sandboxes (experimental in this SDK) pause and resume in place; the others need a new sandbox.
    primitive: 'experimentalPause() on an experimentalPersistent sandbox -> experimentalResume()',
    async create(c) {
      const { ModalClient } = await import('modal');
      c.modal = new ModalClient();
      const app = await c.modal.apps.fromName('sandbox-trial', { createIfMissing: true });
      // Modal has no default image; Debian slim is close to the Debian/Ubuntu images the other providers boot.
      const image = c.modal.images.fromRegistry('debian:bookworm-slim');
      c.sb = await c.modal.sandboxes.create(app, image, { experimentalPersistent: true });
    },
    async run(c, script) {
      const p = await c.sb.exec(['sh', '-c', script]);
      const [out, err, code] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
      if (code !== 0) throw new Error(`exit ${code}: ${err}`);
      return out;
    },
    async sleep(c) { await c.sb.experimentalPause(); },
    async wake(c) { await c.sb.experimentalResume(); },
    async destroy(c) {
      try { if (c.sb) await c.sb.terminate(); } finally { c.modal?.close(); }
    },
  },

  vercel: {
    pkg: '@vercel/sandbox',
    env: ['VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'],
    // A persistent sandbox snapshots its filesystem when the session stops and restores it on resume.
    primitive: 'stop() (persistent sandbox: filesystem snapshot) -> Sandbox.get({ resume: true })',
    async create(c) {
      const { Sandbox } = await import('@vercel/sandbox');
      c.Sandbox = Sandbox;
      c.sb = await Sandbox.create({ ...vercelCreds(), persistent: true });
    },
    async run(c, script) {
      const r = await c.sb.runCommand('sh', ['-c', script]);
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${await r.stderr()}`);
      return r.stdout();
    },
    async sleep(c) { await c.sb.stop(); },
    async wake(c) { c.sb = await c.Sandbox.get({ ...vercelCreds(), name: c.sb.name, resume: true }); },
    async destroy(c) { if (c.sb) await c.sb.delete({ deleteOrphanSnapshots: true }); },
  },
};

const oneLine = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 500);
const version = (pkg) => JSON.parse(readFileSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url))).version;
const parse = (out) => Object.fromEntries(String(out).trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function trial(name) {
  const p = PROVIDERS[name];
  const missing = p.env.filter((k) => !env(k));
  if (missing.length) return console.log(`skip ${name}: missing env ${missing.join(', ')}`);

  const r = { provider: name, sdk: `${p.pkg}@${version(p.pkg)}`, time: new Date().toISOString(), ms: {}, primitive: p.primitive, file_ok: null, ram_kept: null, error: null };
  console.log(`run ${name} (${r.sdk}): ${p.primitive}`);
  const c = { token: randomBytes(16).toString('hex') };
  const errors = [];
  const step = async (s, fn, timed = true) => {
    const t0 = performance.now();
    try {
      const out = await withTimeout(fn());
      if (timed) r.ms[s] = Math.round(performance.now() - t0);
      return out;
    } catch (e) {
      throw new Error(`${s}: ${oneLine(e)}`);
    }
  };

  let creating;
  try {
    // create and wake both count until a command runs, so every provider is timed to the same ready point.
    await step('create', async () => { creating = p.create(c); await creating; await p.run(c, 'true'); });
    await step('write', () => p.run(c, WRITE(c.token)));
    const before = parse(await step('pre-sleep check', () => p.run(c, CHECK), false)).pid;
    if (before !== 'alive') errors.push(`pre-sleep check: background sleep is ${before}, so ram_kept cannot be checked`);
    const reached = await step('sleep', () => p.sleep(c));
    if (typeof reached === 'string') r.primitive += ` [${reached}]`;
    await step('wake', async () => { await p.wake(c); await p.run(c, 'true'); });
    const v = parse(await step('verify', () => p.run(c, VERIFY)));
    r.file_ok = v.token === c.token;
    r.ram_kept = before === 'alive' && v.pid !== 'none' ? v.pid === 'alive' : null;
  } catch (e) {
    errors.push(e.message);
  } finally {
    // A create that outlived its timeout can still return a sandbox; wait for it so destroy deletes it.
    await withTimeout(Promise.resolve(creating).catch(() => {})).catch(() => {});
    await step('destroy', () => p.destroy(c)).catch((e) => errors.push(e.message));
  }
  r.error = errors.join('; ') || null;
  appendFileSync(RESULTS, JSON.stringify(r) + '\n');
  return r;
}

// A stray rejection from one SDK must not end the other providers' runs.
process.on('unhandledRejection', (e) => console.error(`unhandled rejection: ${oneLine(e)}`));

const arg = process.argv[2];
const names = arg === 'all' ? Object.keys(PROVIDERS) : [arg];
if (!names.every((n) => Object.hasOwn(PROVIDERS, n))) {
  console.error(`usage: node --env-file=.env trial.mjs <${Object.keys(PROVIDERS).join('|')}|all>`);
  process.exit(2);
}
const results = [];
for (const n of names) {
  const r = await trial(n);
  if (r) results.push(r);
}
if (results.length) {
  console.table(Object.fromEntries(results.map((r) => [r.provider, {
    ...Object.fromEntries(STEPS.map((s) => [`${s} ms`, r.ms[s] ?? '-'])),
    file_ok: r.file_ok,
    ram_kept: r.ram_kept,
    error: r.error ? r.error.slice(0, 60) : '',
  }])));
  if (results.some((r) => r.error)) process.exitCode = 1;
}
