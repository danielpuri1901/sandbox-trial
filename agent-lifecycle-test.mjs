// Agent lifecycle test: one seller agent lives through 3 simulated days on each sandbox provider.
// A scaled-down copy of the agent-fleet actor loop: the brain (one fresh Pi session per awake period) runs on this
// Mac, the hands (Pi's read, write, edit and bash tools) run in the sandbox, and the agent home lives on the sandbox disk.
// Usage: node --env-file=.env agent-lifecycle-test.mjs <provider|all> [--fake-agent] [--model <id>]
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { PROVIDERS, oneLine, version, withTimeout } from './providers.mjs';

const MAX_TOOL_CALLS_PER_PERIOD = 100;
const MAX_TOKENS_PER_PERIOD = 300_000;
const MAX_TOKENS_PER_PROVIDER = 2_000_000; // safety stop for one provider's whole run
const MAX_PERIODS = 6;
const LAST_DAY = 2; // the run stops after its first awake period on this simulated day
const MIN_PAUSE_MS = 45_000;
const REAL_MS_PER_SIM_MINUTE = 60_000 / 720; // 1 simulated day = 2 real minutes
const ALWAYS_WAKE = ['buyer_message'];
const PRICES = JSON.parse(readFileSync(new URL('./model-prices.json', import.meta.url)));
const RESULTS = new URL('./lifecycle-results.jsonl', import.meta.url);

// Simulated time is minutes since day 0 00:00, written as "day N HH:MM".
const toMin = (s) => {
  const m = /^day (\d+) (\d\d):(\d\d)$/.exec(s ?? '');
  return m ? Number(m[1]) * 1440 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};
const pad = (n) => String(n).padStart(2, '0');
const fmt = (t) => `day ${Math.floor(t / 1440)} ${pad(Math.floor((t % 1440) / 60))}:${pad(t % 60)}`;

const EVENTS = [
  {
    id: 'ev-1',
    type: 'buyer_message',
    at: 'day 0 09:00',
    payload: {
      text: 'We need about 120 m of steel sheet piles for a river cofferdam. Our engineer sends drawings tomorrow. If you have not heard from us by day 1 10:00, follow up then.',
    },
  },
  {
    id: 'ev-2',
    type: 'buyer_message',
    at: 'day 2 10:00',
    payload: { text: 'Drawings attached: 12 m piles, delivery in 3 weeks. Please send a quote.' },
  },
];
const PROMISE_WINDOW = [toMin('day 1 10:00'), toMin('day 1 12:00')];

const CONTRACT = `You are the seller agent for one customer account of a steel sheet pile company.
Your goal is in goal.md.
At the start of every awake period, read your files first: goal.md, tasks.md, progress.md and ledger.jsonl.
Talk to the buyer only with \`company message send --to buyer --text "..."\`.
Every promise needs an alarm: record it with \`company promise add --due "day N HH:MM" --text "..."\` and sleep no later than its due time.
Keep tasks.md (open tasks, each with a due time) and progress.md (one short record for each awake period: done, open, next) up to date.
Never edit ledger.jsonl or clock. The company command writes them.
End every awake period with \`company sleep --until "day N HH:MM" --on buyer_message --task "..."\`.
Run \`company --help\` to see the company commands.
`;
const GOAL = "Keep this customer's trust and win their business.\n";

// The company CLI stub, installed in the sandbox as ~/bin/company.
const COMPANY = readFileSync(new URL('./company-stub.sh', import.meta.url), 'utf8');

// --fake-agent: the same company calls every run, sent through the same bash tool that Pi uses.
const FAKE_SCRIPT = [
  [
    'company promise add --due "day 1 10:00" --text "Follow up if the drawings have not arrived"',
    'company sleep --until "day 1 10:00" --on buyer_message --task "Follow up on the drawings"',
  ],
  [
    'company message send --to buyer --text "Following up as promised: have the drawings for the cofferdam been sent?"',
    'company sleep --until +2d --on buyer_message --task "Wait for the drawings"',
  ],
  [
    'company message send --to buyer --text "Thank you for the drawings. Our quote for 120 m of 12 m piles follows today."',
    'company sleep --until +3d --on buyer_message --task "Follow up on the quote"',
  ],
];

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const b64 = (s) => Buffer.from(s).toString('base64');
const ms = (t0) => Math.round(performance.now() - t0);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

// Runs one POSIX sh script in the sandbox. The script travels as base64, so no quoting can change it.
// ponytail: the script is one shell argument, so one call carries at most about 70 KB (Linux limits one argument
// to 128 KiB, and Daytona and Baseten encode it again); split big writes if an agent ever needs them.
function sh(p, c, script) {
  const env = `export HOME="\${HOME:-${c.home}}"; export PATH=${q(`${c.home}/bin`)}:"$PATH"\n`;
  return withTimeout(p.run(c, `echo ${b64(env + script)} | base64 -d | sh`));
}

// Pi's own read, write, edit and bash tools, with every file and shell operation sent to the sandbox.
// Pi resolves paths on the Mac, so "~" comes back as the Mac home and is mapped to the sandbox home here.
function sandboxTools(p, c) {
  const mac = homedir();
  const at = (path) => (path === mac || path.startsWith(`${mac}/`) ? c.home + path.slice(mac.length) : path);
  const run = (script) => sh(p, c, script);
  const readFile = async (path) => Buffer.from(await run(`base64 < ${q(at(path))}`), 'base64');
  const writeFile = async (path, content) => {
    await run(`printf %s ${b64(content)} | base64 -d > ${q(at(path))}`);
  };
  const access = (tests) => async (path) => {
    const out = await run(`${tests.map((t) => `test ${t} ${q(at(path))}`).join(' && ')} && echo ok || echo no`);
    if (out.trim() !== 'ok') throw new Error(`ENOENT: no such file or directory, access '${path}'`);
  };
  const exec = async (command, cwd, { onData, timeout }) => {
    const mark = `__exit_${randomBytes(6).toString('hex')}=`;
    const out = await run(
      [
        `cd ${q(at(cwd))} || exit 1`,
        'S=sh; command -v bash >/dev/null 2>&1 && S=bash',
        timeout ? `T=; command -v timeout >/dev/null 2>&1 && T="timeout ${Math.ceil(timeout)}"` : 'T=',
        `$T $S -c "$(echo ${b64(command)} | base64 -d)" </dev/null 2>&1`,
        `printf '\\n%s%s' ${mark} "$?"`,
      ].join('\n'),
    );
    const i = out.lastIndexOf(`\n${mark}`);
    if (i < 0) throw new Error(`no exit code in sandbox output: ${oneLine(out)}`);
    onData(Buffer.from(out.slice(0, i)));
    const exitCode = Number(out.slice(i + 1 + mark.length));
    if (timeout && exitCode === 124) throw new Error(`timeout:${timeout}`);
    return { exitCode };
  };
  const tools = {
    read: createReadToolDefinition(c.agentDir, { operations: { readFile, access: access(['-r']) } }),
    write: createWriteToolDefinition(c.agentDir, {
      operations: { writeFile, mkdir: async (dir) => void (await run(`mkdir -p ${q(at(dir))}`)) },
    }),
    edit: createEditToolDefinition(c.agentDir, { operations: { readFile, writeFile, access: access(['-r', '-w']) } }),
    // exec ignores the env Pi passes: it is this Mac's environment, keys included, and must not reach the sandbox.
    bash: createBashToolDefinition(c.agentDir, { operations: { exec }, exposeSessionEnvironment: false }),
  };
  // Every tool call is counted and timed here, in Pi mode and in fake mode alike.
  for (const t of Object.values(tools)) {
    const execute = t.execute;
    t.execute = async (...args) => {
      const st = c.period;
      if (st.calls >= MAX_TOOL_CALLS_PER_PERIOD) {
        st.cap ??= 'tool_calls';
        st.stop();
        throw new Error('Tool call cap reached. This awake period ends now.');
      }
      st.calls++;
      const t0 = performance.now();
      try {
        return await execute(...args);
      } finally {
        st.rtt.push(performance.now() - t0);
      }
    };
  }
  return tools;
}

const installHome = (c) => {
  const file = (name, text) => `printf %s ${b64(text)} | base64 -d > "$A/${name}"`;
  const bin = `${c.home}/bin`;
  return [
    'set -e',
    `A=${q(c.agentDir)}`,
    `mkdir -p "$A" ${q(bin)}`,
    file('AGENTS.md', CONTRACT),
    file('goal.md', GOAL),
    file('tasks.md', '# Tasks\n'),
    file('progress.md', '# Progress\n'),
    ': > "$A/ledger.jsonl"',
    `printf %s ${b64(COMPANY.replace('__AGENT_DIR__', () => q(c.agentDir)))} | base64 -d > ${q(`${bin}/company`)}`,
    `chmod +x ${q(`${bin}/company`)}`,
  ].join('\n');
};
// stderr is closed so a stray message cannot mix into the base64 output on providers that merge the streams.
const LEDGER_DUMP = 'if [ -f "$A/ledger.jsonl" ]; then echo ledger=found; base64 < "$A/ledger.jsonl"; else echo ledger=missing; fi';
const startScript = (c, now) =>
  ['exec 2>/dev/null', `A=${q(c.agentDir)}`, 'rm -f "$A/sleep.json"', `printf %s ${q(fmt(now))} > "$A/clock"`, LEDGER_DUMP].join('\n');
const endScript = (c) =>
  [
    'exec 2>/dev/null',
    `A=${q(c.agentDir)}`,
    'if [ -f "$A/sleep.json" ]; then echo "sleep=$(base64 < "$A/sleep.json" | tr -d "\\n")"; else echo sleep=; fi',
    LEDGER_DUMP,
  ].join('\n');
// Returns the ledger text, or null when the file is gone.
function readLedger(out) {
  const i = out.indexOf('ledger=');
  if (i < 0) throw new Error(`no ledger marker in sandbox output: ${oneLine(out)}`);
  const rest = out.slice(i);
  if (rest.startsWith('ledger=missing')) return null;
  return Buffer.from(rest.slice(rest.indexOf('\n') + 1), 'base64').toString('utf8');
}
const sha256 = (text) => (text === null ? null : createHash('sha256').update(text).digest('hex'));

// The agent-fleet firstPrompt shape: the state, the pending events, then the instruction to decide and sleep.
function firstPrompt(c, now, events, wake) {
  const lines = events.map((e) => JSON.stringify({ id: e.id, type: e.type, payload: e.payload, at: e.at }));
  if (wake.reason === 'alarm') lines.push(JSON.stringify({ type: 'alarm', payload: { task: wake.task }, at: fmt(now) }));
  return [
    `# Your state\nSimulated time now: ${fmt(now)}. Your files are in ${c.agentDir}.`,
    `# Events since your last sleep\n${lines.join('\n') || '(none)'}`,
    'Decide what to do. When you have no more work now, run "company sleep" with a time and a task.',
  ].join('\n\n');
}

// Pi 0.85.1 has no Claude 5.5 in its catalog, so the model object is built here (copied from agent-fleet
// runtime/pi-session.ts buildModel). contextWindow is 100,000 because Haiku 5.5 charges more above that.
function buildModel(id, p) {
  return {
    id,
    name: id,
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: true,
    input: ['text'],
    cost: { input: p.inputPerMTok, output: p.outputPerMTok, cacheRead: p.cacheReadPerMTok, cacheWrite: p.cacheWritePerMTok },
    contextWindow: 100000,
    maxTokens: 32000,
    compat: { supportsTemperature: false, forceAdaptiveThinking: true },
  };
}

// One awake period with a fresh Pi session, set up the agent-fleet way (runtime/pi-session.ts startPiSession).
async function piPeriod(c, prompt, { model, apiKey }, providerTokens) {
  process.env.PI_OFFLINE = '1';
  // Pi's auth and model files stay in a temporary folder on the Mac.
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-agent-'));
  let session;
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: join(agentDir, 'models.json'),
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey('anthropic', apiKey);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: c.agentDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => CONTRACT,
      appendSystemPromptOverride: () => [],
    });
    await resourceLoader.reload();
    // customTools with the built-in names replace Pi's local read, bash, edit and write.
    ({ session } = await createAgentSession({
      cwd: c.agentDir,
      agentDir,
      model: buildModel(model, PRICES[model]),
      thinkingLevel: 'low',
      modelRuntime,
      resourceLoader,
      tools: ['read', 'bash', 'edit', 'write'],
      customTools: Object.values(c.tools),
      sessionManager: SessionManager.inMemory(c.agentDir),
      settingsManager,
    }));
    const st = c.period;
    st.stop = () => {
      if (st.stopping) return;
      st.stopping = true;
      session.abort().catch(() => {});
    };
    session.subscribe((e) => {
      if (e.type !== 'message_end') return;
      const used = session.getSessionStats().tokens.total;
      if (used > MAX_TOKENS_PER_PERIOD) {
        st.cap ??= 'period_tokens';
        st.stop();
      } else if (providerTokens + used > MAX_TOKENS_PER_PROVIDER) {
        st.cap ??= 'provider_tokens';
        st.stop();
      }
    });
    let error = null;
    try {
      await session.prompt(prompt);
    } catch (e) {
      if (!st.cap) error = oneLine(e);
    }
    // After its retries, Pi ends the run with an assistant message that carries the error.
    const last = session.messages.filter((m) => m.role === 'assistant').at(-1);
    if (!error && !st.cap && last?.stopReason === 'error') error = oneLine(last.errorMessage ?? 'model error');
    const s = session.getSessionStats();
    return {
      tokens_in: s.tokens.input,
      tokens_out: s.tokens.output,
      tokens_cache_read: s.tokens.cacheRead,
      tokens_cache_write: s.tokens.cacheWrite,
      tokens_total: s.tokens.total,
      cost_usd: s.cost,
      error,
      failed: error !== null,
    };
  } finally {
    session?.dispose();
    rmSync(agentDir, { recursive: true, force: true });
  }
}

async function fakePeriod(c, n) {
  const script = FAKE_SCRIPT[n - 1] ?? [];
  for (const [i, command] of script.entries()) {
    try {
      await c.tools.bash.execute(`fake-${n}-${i}`, { command }, undefined, undefined, undefined);
    } catch (e) {
      return { error: `${command.split(' --')[0]}: ${oneLine(e)}`, failed: false };
    }
  }
  return { error: null, failed: false };
}

async function lifecycle(name, opts) {
  const p = PROVIDERS[name];
  const missing = p.env.filter((k) => !process.env[k]);
  if (missing.length) return console.log(`skip ${name}: missing env ${missing.join(', ')}`);

  const base = { provider: name, sdk: `${p.pkg}@${version(p.pkg)}`, mode: opts.fake ? 'fake' : 'pi', model: opts.model };
  if (!opts.fake) base.pi = `@earendil-works/pi-coding-agent@${version('@earendil-works/pi-coding-agent')}`;
  console.log(`run ${name} (${base.sdk}, mode ${base.mode}, model ${opts.model})`);
  const t0 = performance.now();
  const c = {};
  const rows = [];
  const inbox = EVENTS.map((e) => ({ ...e, t: toMin(e.at) }));
  const delivered = []; // event ids, once for each awake period that handled them
  const ledgerRows = new Map(); // every ledger line seen at any period end, so a later disk loss cannot hide it
  const rtts = [];
  let wake = { t: inbox[0].t, reason: inbox[0].id }; // no agent yet: its first event wakes it
  let prevHash;
  let tokens = 0;
  let cost = 0;
  let stopped = null;
  let creating;
  const errors = [];
  let row;
  try {
    for (let n = 1; n <= MAX_PERIODS; n++) {
      const now = wake.t;
      // Every pending event up to now is delivered, also the types that could not wake the agent.
      const due = inbox.filter((e) => e.t <= now).sort((a, b) => a.t - b.t);
      for (const e of due) inbox.splice(inbox.indexOf(e), 1);
      row = {
        ...base,
        period: n,
        sim_time: fmt(now),
        wake_reason: wake.reason,
        events: due.map((e) => e.id),
        wake_ms: null,
        period_ms: null,
        sleep_ms: null,
        tool_calls: 0,
        tool_rtt_median_ms: null,
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_total: 0,
        cost_usd: 0,
        home_intact: null,
        slept: null,
        orphan: null,
        cap: null,
        error: null,
      };
      rows.push(row);

      // Wake: from the wake primitive (create in period 1) until the first command returns.
      const w0 = performance.now();
      if (n === 1) {
        await withTimeout((creating = p.create(c)));
      } else {
        await withTimeout(p.wake(c));
      }
      await withTimeout(p.run(c, 'true'));
      row.wake_ms = ms(w0);

      const p0 = performance.now();
      if (n === 1) {
        c.home = (await withTimeout(p.run(c, 'echo "${HOME:-$PWD}"'))).trim();
        c.agentDir = `${c.home}/agent`;
        c.tools = sandboxTools(p, c);
        await sh(p, c, installHome(c));
      }
      const hash = sha256(readLedger(await sh(p, c, startScript(c, now))));
      if (n > 1) row.home_intact = hash !== null && hash === prevHash;

      c.period = { calls: 0, rtt: [], cap: null, stop() {} };
      const result = opts.fake
        ? await fakePeriod(c, n)
        : await piPeriod(c, firstPrompt(c, now, due, wake), opts, tokens);
      const { failed, ...fields } = result;
      Object.assign(row, fields);
      // A failed period keeps its events for the next one, as in agent-fleet.
      if (failed) inbox.push(...due);
      else delivered.push(...row.events);

      const out = await sh(p, c, endScript(c));
      const ledger = readLedger(out);
      prevHash = sha256(ledger);
      for (const line of (ledger ?? '').split('\n').filter(Boolean)) {
        if (ledgerRows.has(line)) continue;
        try {
          ledgerRows.set(line, JSON.parse(line));
        } catch {
          ledgerRows.set(line, null);
        }
      }
      const sleepB64 = /^sleep=(.*)$/m.exec(out)?.[1] ?? '';
      let sleep = null;
      if (sleepB64) {
        try {
          sleep = JSON.parse(Buffer.from(sleepB64, 'base64').toString('utf8'));
          if (!Number.isFinite(sleep.until_min)) throw new Error('no until_min');
        } catch (e) {
          sleep = null;
          row.error = [row.error, `sleep.json unreadable: ${oneLine(e)}`].filter(Boolean).join('; ');
        }
      }
      row.slept = sleep;
      row.orphan = sleep === null;
      row.tool_calls = c.period.calls;
      row.tool_rtt_median_ms = median(c.period.rtt);
      rtts.push(...c.period.rtt);
      row.cap = c.period.cap;
      tokens += row.tokens_total;
      cost += row.cost_usd;
      row.period_ms = ms(p0);
      console.log(
        `${name} period ${n} ${row.sim_time} woke on ${row.wake_reason}: ${row.tool_calls} tool calls, ` +
          `${sleep ? `sleeps until ${sleep.until}` : 'ORPHAN'}${row.error ? `, error: ${row.error.slice(0, 120)}` : ''}`,
      );

      // Next wake: the alarm, or the first pending event the agent listens for, whichever comes first.
      // Orphan rule: no sleep.json means a wake on the next simulated day.
      const alarm = sleep ? sleep.until_min : now + 1440;
      const on = [...ALWAYS_WAKE, ...(Array.isArray(sleep?.on) ? sleep.on : [])];
      const next = inbox.filter((e) => on.includes(e.type)).sort((a, b) => a.t - b.t)[0];
      wake =
        next && next.t <= alarm
          ? { t: Math.max(next.t, now), reason: next.id }
          : { t: alarm, reason: 'alarm', task: sleep ? sleep.task : 'Default wake: no next step was set' };

      if (Math.floor(now / 1440) >= LAST_DAY || n === MAX_PERIODS) break;
      if (tokens >= MAX_TOKENS_PER_PROVIDER) {
        stopped = 'provider_tokens';
        break;
      }
      // The real pause starts when the awake period ends and includes the sleep primitive,
      // so the idle time between periods is the same on every provider.
      const pauseEnd = Date.now() + Math.max(MIN_PAUSE_MS, (wake.t - now) * REAL_MS_PER_SIM_MINUTE);
      const s0 = performance.now();
      await withTimeout(p.sleep(c));
      row.sleep_ms = ms(s0);
      await delay(Math.max(0, pauseEnd - Date.now()));
    }
  } catch (e) {
    errors.push(oneLine(e));
    if (row) row.error = [row.error, oneLine(e)].filter(Boolean).join('; ');
    stopped ??= 'error';
  } finally {
    // A create that outlived its timeout can still return a sandbox; wait for it so destroy deletes it.
    await withTimeout(Promise.resolve(creating).catch(() => {})).catch(() => {});
    await withTimeout(p.destroy(c)).catch((e) => errors.push(`destroy: ${oneLine(e)}`));
  }

  const checks = rows.map((r) => r.home_intact).filter((x) => x !== null);
  const summary = {
    ...base,
    summary: true,
    periods: rows.length,
    promise_kept: [...ledgerRows.values()].some((r) => {
      const t = toMin(r?.at);
      return r?.type === 'message_send' && t >= PROMISE_WINDOW[0] && t <= PROMISE_WINDOW[1];
    }),
    orphans: rows.filter((r) => r.orphan === true).length,
    events_once: EVENTS.every((e) => delivered.filter((id) => id === e.id).length === 1),
    home_intact_all: checks.length ? checks.every(Boolean) : null,
    wake_ms: rows.map((r) => r.wake_ms),
    tool_calls: rows.reduce((s, r) => s + r.tool_calls, 0),
    tool_rtt_median_ms: median(rtts),
    tokens_total: tokens,
    cost_usd: cost,
    wall_ms: ms(t0),
    stopped,
    error: errors.join('; ') || null,
  };
  for (const r of [...rows, summary]) appendFileSync(RESULTS, `${JSON.stringify({ time: new Date().toISOString(), ...r })}\n`);
  return summary;
}

// The secret may be a raw key or JSON. For JSON take the field "aws-inference", else the first string value
// (the agent-fleet runtime/main.ts rule).
function parseKey(secret) {
  try {
    const json = JSON.parse(secret);
    if (typeof json === 'string') return json;
    if (json && typeof json === 'object') {
      if (typeof json['aws-inference'] === 'string') return json['aws-inference'];
      const first = Object.values(json).find((v) => typeof v === 'string');
      if (typeof first === 'string') return first;
    }
  } catch {}
  return secret.trim();
}

// A stray rejection from one SDK must not end the other providers' runs.
process.on('unhandledRejection', (e) => console.error(`unhandled rejection: ${oneLine(e)}`));

const usage = `usage: node --env-file=.env agent-lifecycle-test.mjs <${Object.keys(PROVIDERS).join('|')}|all> [--fake-agent] [--model <${Object.keys(PRICES).join('|')}>]`;
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { 'fake-agent': { type: 'boolean', default: false }, model: { type: 'string', default: 'claude-haiku-5-5' } },
  });
} catch (e) {
  console.error(`${oneLine(e)}\n${usage}`);
  process.exit(2);
}
const [arg, ...extra] = args.positionals;
const names = arg === 'all' ? Object.keys(PROVIDERS) : [arg];
if (extra.length || !names.every((n) => Object.hasOwn(PROVIDERS, n))) {
  console.error(usage);
  process.exit(2);
}
const model = args.values.model;
if (!Object.hasOwn(PRICES, model)) {
  console.error(`unknown model "${model}": model-prices.json has ${Object.keys(PRICES).join(', ')}`);
  process.exit(2);
}
const opts = { fake: args.values['fake-agent'], model };
if (!opts.fake) {
  const secret = process.env.ANTHROPIC_SECRET;
  delete process.env.ANTHROPIC_SECRET; // the key lives only in opts from here on, never in the environment
  if (!secret?.trim()) {
    console.log('skip all providers: missing env ANTHROPIC_SECRET (the model key). Set it, or pass --fake-agent.');
    process.exit(0);
  }
  opts.apiKey = parseKey(secret);
}

const summaries = (
  await Promise.all(names.map((n) => lifecycle(n, opts).catch((e) => console.error(`${n} failed before its run: ${oneLine(e)}`))))
).filter(Boolean);
if (summaries.length) {
  console.table(
    Object.fromEntries(
      summaries.map((s) => [
        s.provider,
        {
          periods: s.periods,
          'wake ms': s.wake_ms.join(' / '),
          'tool rtt ms': s.tool_rtt_median_ms,
          promise_kept: s.promise_kept,
          orphans: s.orphans,
          events_once: s.events_once,
          home_intact_all: s.home_intact_all,
          'cost usd': Number(s.cost_usd.toFixed(4)),
          'wall s': Math.round(s.wall_ms / 1000),
          error: s.error ? s.error.slice(0, 60) : '',
        },
      ]),
    ),
  );
  if (summaries.some((s) => s.error)) process.exitCode = 1;
}
