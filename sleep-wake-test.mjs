// Sleep-and-wake test: the same six timed steps against each sandbox provider.
// Usage: node --env-file=.env sleep-wake-test.mjs <e2b|daytona|sprites|baseten|modal|vercel|all>
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PROVIDERS, oneLine, version, withTimeout } from './providers.mjs';

const STEPS = ['create', 'write', 'sleep', 'wake', 'verify', 'destroy'];
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
const parse = (out) => Object.fromEntries(String(out).trim().split('\n').map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

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
  console.error(`usage: node --env-file=.env sleep-wake-test.mjs <${Object.keys(PROVIDERS).join('|')}|all>`);
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