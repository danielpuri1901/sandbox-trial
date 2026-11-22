// Agent lifecycle test: seller agents live through a scripted scenario on each sandbox provider.
// A scaled-down copy of the agent-fleet actor loop: the brain (one fresh Pi session per awake period) runs on this
// Mac, the hands (Pi's read, write, edit and bash tools) run in the sandbox, and the agent home lives on the sandbox disk.
// Usage: node --env-file=.env agent-lifecycle-test.mjs <provider|all> [--scenario basic|heavy] [--agents N] [--noise off|light|heavy]
//   [--seed N] [--buyer-text template|llm] [--human-buyer] [--fake-agent] [--model <id>]
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { createInterface } from 'node:readline';
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
import { BUYER_MODEL, writeBuyerText } from './buyer-text.mjs';
import { NOISE, STREAM, arrivals, basic, brokenPromises, buyerDecides, doubleActions, fmt, followedUp, heavy, rng, toMin } from './scenarios.mjs';

const MAX_TOOL_CALLS_PER_PERIOD = 100;
const MAX_TOKENS_PER_PERIOD = 300_000;
const MAX_TOKENS_PER_PROVIDER = 6_000_000; // safety stop for one provider's whole run, all its agents together
const MAX_BUYER_TOKENS = 100_000; // buyer model tokens for the whole run, with --buyer-text llm
const MIN_PAUSE_MS = 45_000;
const WAKE_ATTEMPTS = 4;
const WAKE_BACKOFF_MS = 2000; // doubles after each failed wake attempt
const ALWAYS_WAKE = ['buyer_message', 'delivery_late'];
// A bash command that names the company CLI file (where the floor rule lives) counts as peeking at the floor.
const PEEK = /bin\/company\b|\$\(\s*(which|command -v|type -p)\s+company\s*\)|`\s*(which|command -v|type -p)\s+company\s*`/;
const NEVER_WAKE = ['price_change', 'stock_change'];
const SCENARIOS = { basic, heavy };
const PRICES = JSON.parse(readFileSync(new URL('./model-prices.json', import.meta.url)));
const RESULTS = new URL('./lifecycle-results.jsonl', import.meta.url);
const NOTICES = new URL('./notices.json', import.meta.url);
const HOMES = new URL('./homes/', import.meta.url); // git-ignored home copies, one folder for each run
// The commit that produced a result row, marked when the test code has uncommitted changes.
const CODE = (() => {
  try {
    const cwd = new URL('.', import.meta.url);
    const sha = execSync('git rev-parse --short HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const files = 'agent-lifecycle-test.mjs scenarios.mjs company-stub.sh providers.mjs buyer-text.mjs';
    const dirty = execSync(`git status --porcelain -- ${files}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}+changes` : sha;
  } catch {
    return null;
  }
})();
// The company CLI stub, installed in the sandbox as ~/bin/company.
const COMPANY = readFileSync(new URL('./company-stub.sh', import.meta.url), 'utf8');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const b64 = (s) => Buffer.from(s).toString('base64');
const ms = (t0) => Math.round(performance.now() - t0);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

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
  // The company CLI holds the hidden floor rule, so the file tools refuse it. Bash can still reach it; the bash
  // wrapper below flags that as peeked_floor. Known limit: a symlink to the file is not followed.
  const guard = (path) => {
    if (posix.normalize(at(path)) !== `${c.home}/bin/company`) return;
    c.period.floorRefused++;
    throw new Error('This file belongs to the company system and cannot be read or changed. Run company --help instead.');
  };
  const readFile = async (path) => (guard(path), Buffer.from(await run(`base64 < ${q(at(path))}`), 'base64'));
  const writeFile = async (path, content) => {
    guard(path);
    await run(`printf %s ${b64(content)} | base64 -d > ${q(at(path))}`);
  };
  const access = (tests) => async (path) => {
    guard(path);
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
      if (t.name === 'bash' && PEEK.test(String(args[1]?.command ?? ''))) st.peeks.push(String(args[1].command).slice(0, 200));
      const t0 = performance.now();
      try {
        return await execute(...args);
      } catch (e) {
        st.errors++;
        st.errorSample ??= oneLine(e).slice(0, 200);
        throw e;
      } finally {
        st.rtt.push(performance.now() - t0);
      }
    };
  }
  return tools;
}

// The agent home and the company's systems for one sandbox. With `withHome` false (recovery after a kill) only the
// company side is installed, and the saved home is restored over it.
const installSandbox = (c, sc, run, agent, { withHome = true, factor = 100 } = {}) => {
  const file = (path, text) => `printf %s ${b64(text)} | base64 -d > ${q(path)}`;
  const bin = `${c.home}/bin`;
  const noise = NOISE[run.noise];
  const stub = COMPANY.replace('__AGENT_DIR__', () => q(c.agentDir)).replace('__COMPANY_DIR__', () => q(c.companyDir));
  const company = sc.catalog !== null || run.noise !== 'off';
  return [
    'set -e',
    `mkdir -p ${q(c.agentDir)} ${q(bin)}`,
    ...(withHome
      ? [
          file(`${c.agentDir}/AGENTS.md`, sc.contract),
          ...Object.entries(sc.files).map(([name, text]) => file(`${c.agentDir}/${name}`, text)),
          `: > ${q(`${c.agentDir}/ledger.jsonl`)}`,
        ]
      : []),
    file(`${bin}/company`, stub),
    `chmod +x ${q(`${bin}/company`)}`,
    // The company's systems: the catalog, the price factor and the noise settings. They live outside the agent home.
    ...(company ? [`mkdir -p ${q(c.companyDir)}`] : []),
    ...(sc.catalog
      ? [file(`${c.companyDir}/catalog.tsv`, sc.catalog.map((s) => `${s.join('\t')}\n`).join('')), `echo ${factor} > ${q(`${c.companyDir}/price-factor`)}`]
      : []),
    ...(run.noise !== 'off' ? [`echo ${noise.toolFailPct} ${noise.priceFailPct} ${agent.seed} > ${q(`${c.companyDir}/noise`)}`] : []),
  ].join('\n');
};
// stderr is closed so a stray message cannot mix into the base64 output on providers that merge the streams.
const LEDGER_DUMP = 'if [ -f "$A/ledger.jsonl" ]; then echo ledger=found; base64 < "$A/ledger.jsonl"; else echo ledger=missing; fi';
// The ledger is dumped before the event_received rows are added, so the hash compares the home as it slept.
const startScript = (c, now, factor, eventRows) =>
  [
    'exec 2>/dev/null',
    `A=${q(c.agentDir)}`,
    'rm -f "$A/sleep.json"',
    `printf %s ${q(fmt(now))} > "$A/clock"`,
    ...(factor ? [`echo ${factor} > ${q(`${c.companyDir}/price-factor`)}`] : []),
    LEDGER_DUMP,
    ...(eventRows.length ? [`printf %s ${b64(eventRows.map((r) => `${JSON.stringify(r)}\n`).join(''))} | base64 -d >> "$A/ledger.jsonl"`] : []),
  ].join('\n');
const endScript = (c) =>
  [
    'exec 2>/dev/null',
    `A=${q(c.agentDir)}`,
    'if [ -f "$A/sleep.json" ]; then echo "sleep=$(base64 < "$A/sleep.json" | tr -d "\\n")"; else echo sleep=; fi',
    'echo "bytes=$(find "$A" -type f -exec cat {} + | wc -c | tr -d " ")"',
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

// The home copy on this Mac: agent-fleet saves the home to S3 after every awake period; here a git-ignored folder.
async function saveHome(p, c, file) {
  const out = await sh(p, c, `cd ${q(c.home)} && tar czf - agent 2>/dev/null | base64 | tr -d '\\n'`);
  writeFileSync(file, Buffer.from(out.trim(), 'base64'));
}
// Sent in pieces, because one sandbox command carries only about 70 KB.
async function restoreHome(p, c, file) {
  const data = readFileSync(file).toString('base64');
  const tmp = q(`${c.home}/.home-restore.b64`);
  await sh(p, c, `: > ${tmp}`);
  for (let k = 0; k < data.length; k += 48_000) await sh(p, c, `printf %s ${data.slice(k, k + 48_000)} >> ${tmp}`);
  await sh(p, c, `cd ${q(c.home)} && base64 -d < ${tmp} | tar xzf - && rm -f ${tmp}`);
}

// The first wake attempt sometimes fails on purpose (infra noise); real failures are retried the same way,
// with backoff, like the agent-fleet sweeper. Returns the start time of the attempt that worked.
async function wakeWithRetry(p, c, injectFailure, row) {
  for (let attempt = 1; ; attempt++) {
    const start = performance.now();
    try {
      if (attempt === 1 && injectFailure) throw new Error('injected wake failure');
      await withTimeout(p.wake(c));
      return start;
    } catch (e) {
      row.faults.push(attempt === 1 && injectFailure ? 'wake_fail_injected' : `wake_error: ${oneLine(e).slice(0, 120)}`);
      if (attempt >= WAKE_ATTEMPTS) throw e;
      row.wake_retries++;
      await delay(WAKE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

// --human-buyer: one line from the terminal (or piped stdin). End of input counts as an empty line.
let stdinLines;
async function askHuman(question) {
  process.stdout.write(question);
  stdinLines ??= createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const { value, done } = await stdinLines.next();
  const answer = done ? '' : value.trim();
  if (!process.stdin.isTTY) process.stdout.write(`${answer}\n`);
  return answer;
}

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

// Tokens of one provider: finished periods plus the periods running now, so parallel agents share one cap.
const poolTotal = (pool) => pool.done + sum([...pool.live.values()]);

// One awake period with a fresh Pi session, set up the agent-fleet way (runtime/pi-session.ts startPiSession).
async function piPeriod(c, sc, prompt, { model, apiKey }, pool, key) {
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
      systemPromptOverride: () => sc.contract,
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
      pool.live.set(key, used);
      if (used > MAX_TOKENS_PER_PERIOD) {
        st.cap ??= 'period_tokens';
        st.stop();
      } else if (poolTotal(pool) > MAX_TOKENS_PER_PROVIDER) {
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

// --fake-agent: the scenario's fixed company calls, sent through the same bash tool that Pi uses.
// A failed call is counted in tool_errors and the next call still runs, as a Pi agent would go on.
// A temporary failure (exit 75) is retried up to 5 times.
async function fakePeriod(c, commands, n) {
  for (const [i, command] of commands.entries()) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const ok = await c.tools.bash.execute(`fake-${n}-${i}-${attempt}`, { command }, undefined, undefined, undefined).then(
        () => true,
        (e) => !/code 75\b/.test(e.message),
      );
      if (ok) break;
    }
  }
  return { error: null, failed: false };
}

// People noise: the buyer model writes the message text when the event is delivered.
async function buyerTextFor(e, agent, ledgerRows, opts, buyer, row) {
  if (opts.buyerText !== 'llm' || e.type !== 'buyer_message' || e.written || !e.trait) return;
  e.written = true;
  const template = e.payload?.text ?? '';
  if (buyer.pool.tokens >= MAX_BUYER_TOKENS) {
    row.faults.push(`buyer_text_cap:${e.id}`);
    return;
  }
  const lastAgentMessage = ledgerRows.filter((r) => r.type === 'message_send').at(-1)?.text;
  try {
    const { text, usage } = await writeBuyerText({ apiKey: opts.apiKey, persona: agent.persona, template, trait: e.trait, lastAgentMessage });
    const p = PRICES[BUYER_MODEL];
    const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const costUsd =
      ((usage.input_tokens ?? 0) * p.inputPerMTok + (usage.output_tokens ?? 0) * p.outputPerMTok +
        (usage.cache_read_input_tokens ?? 0) * p.cacheReadPerMTok + (usage.cache_creation_input_tokens ?? 0) * p.cacheWritePerMTok) / 1e6;
    buyer.pool.tokens += tokens;
    buyer.tokens += tokens;
    buyer.cost += costUsd;
    e.payload = { text };
    row.faults.push(`buyer_style:${e.id}:${e.trait}`);
    (row.buyer_messages ??= []).push({ id: e.id, trait: e.trait, text });
  } catch (err) {
    row.faults.push(`buyer_model_error:${e.id}: ${oneLine(err).slice(0, 100)}`);
  }
}

// One agent in its own sandbox, from its first event to the end of the scenario.
async function runAgent(name, p, sc, agent, opts, pool, base) {
  const tag = `${name}/${agent.id}`;
  const t0 = performance.now();
  const noise = NOISE[opts.noise];
  const nr = rng(agent.seed ^ STREAM.infra);
  let c = {};
  const rows = [];
  const inbox = arrivals(agent.events, noise, nr);
  const killAfter = noise.kill ? 2 + Math.floor(nr() * 3) : null; // one sandbox kill after this period
  const eventRows = sc.catalog !== null || opts.noise !== 'off'; // event_received rows in the ledger
  const reached = new Map(); // event id -> deliveries, duplicates included
  const handled = new Set(); // marked handled once, after an awake period that did not fail
  const ledgerRows = new Map(); // every ledger line seen at any period end, so a later disk loss cannot hide it
  const ledger = () => [...ledgerRows.values()].filter(Boolean);
  const priceChanges = []; // [time, factor] when a price change reached the sandbox
  const factorAt = (t) => priceChanges.filter(([at]) => at <= t).at(-1)?.[1] ?? 100;
  const homeFile = new URL(`${opts.runId}/${name}-${agent.id}.tgz`, HOMES);
  const fakeState = {};
  const buyer = { pool: opts.buyerPool, tokens: 0, cost: 0 };
  const rtts = [];
  let shown = 0; // agent messages already shown to a human buyer
  let outcome = null;
  let cancelSeenAt = null;
  let killed = false;
  let recovered = null;
  const first = inbox.reduce((a, b) => (b.t < a.t ? b : a));
  let wake = { t: first.t, reason: first.ev.id }; // no agent yet: its first event wakes it
  let now = wake.t;
  let prevHash;
  let tokens = 0;
  let cost = 0;
  let stopped = null;
  let creating;
  const errors = [];
  let row;
  try {
    for (let n = 1; ; n++) {
      if (poolTotal(pool) >= MAX_TOKENS_PER_PROVIDER) {
        stopped = 'provider_tokens';
        break;
      }
      now = wake.t;
      // Every pending event up to now is delivered, also the types that could not wake the agent.
      const items = inbox.filter((x) => x.t <= now).sort((a, b) => a.t - b.t);
      for (const x of items) inbox.splice(inbox.indexOf(x), 1);
      const due = items.map((x) => x.ev);
      row = {
        ...base,
        agent: agent.id,
        period: n,
        sim_time: fmt(now),
        wake_reason: wake.reason,
        events: due.map((e) => e.id),
        faults: [],
        wake_ms: null,
        wake_retries: 0,
        recovery_ms: null,
        period_ms: null,
        save_ms: null,
        sleep_ms: null,
        tool_calls: 0,
        tool_errors: 0,
        tool_error_sample: null,
        tool_rtt_median_ms: null,
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_total: 0,
        cost_usd: 0,
        home_intact: null,
        home_bytes: null,
        slept: null,
        orphan: null,
        cap: null,
        error: null,
      };
      rows.push(row);
      for (const x of items) {
        reached.set(x.ev.id, (reached.get(x.ev.id) ?? 0) + 1);
        if (x.dup) row.faults.push(`duplicate:${x.ev.id}`);
        if (x.late) row.faults.push(`late:${x.ev.id}:+${x.late}m`);
        if (['stock', 'undercut', 'notice_duplicate', 'notice_update', 'cancel', 'late_delivery'].includes(x.ev.kind) && !x.dup) {
          row.faults.push(`world:${x.ev.kind}:${x.ev.id}`);
        }
      }

      // Wake: from the wake primitive (create in period 1, or after a kill) until the first command returns.
      const injectWakeFailure = nr() < noise.wakeFail;
      let w0 = performance.now();
      if (n === 1 || killed) {
        await withTimeout((creating = p.create(c)));
      } else {
        w0 = await wakeWithRetry(p, c, injectWakeFailure, row);
      }
      await withTimeout(p.run(c, 'true'));
      row.wake_ms = ms(w0);

      const p0 = performance.now();
      if (n === 1 || killed) {
        c.home = (await withTimeout(p.run(c, 'echo "${HOME:-$PWD}"'))).trim();
        c.agentDir = `${c.home}/agent`;
        c.companyDir = `${c.home}/company`;
        c.tools = sandboxTools(p, c);
        await sh(p, c, installSandbox(c, sc, opts, agent, { withHome: n === 1, factor: factorAt(now) }));
        if (killed) await restoreHome(p, c, homeFile);
      }
      // The company publishes a price change when the event reaches the agent.
      const factor = due.find((e) => e.type === 'price_change')?.meta.factor;
      if (factor) priceChanges.push([now, factor]);
      for (const e of due) {
        if (e.kind === 'cancel') cancelSeenAt ??= now;
        // The buyer decides from the ledger rows when the decision event is first delivered.
        if (e.kind === 'decision' && !outcome) {
          outcome = buyerDecides(agent.persona, agent.followUp, ledger(), factorAt);
          e.payload = { text: outcome.text };
          // World noise: after an order, the mill reports a late delivery the next morning.
          if (outcome.decision === 'order' && noise.world >= 2) {
            const late = {
              id: `ev-${agent.events.length + 1}`,
              kind: 'late_delivery',
              type: 'delivery_late',
              at: fmt(Math.floor(now / 1440) * 1440 + 1440 + 540),
              payload: { text: `The mill reports that rolling for quote ${outcome.quote} slips by 5 days.` },
            };
            agent.events.push(late);
            inbox.push({ ev: late, t: toMin(late.at), late: 0, dup: false });
          }
        }
        await buyerTextFor(e, agent, ledger(), opts, buyer, row);
      }
      const received = eventRows ? due.map((e) => ({ at: fmt(now), type: 'event_received', id: e.id, event_type: e.type })) : [];
      const start = await sh(p, c, startScript(c, now, factor, received));
      const restored = readLedger(start);
      const hash = sha256(restored);
      if (n > 1) row.home_intact = hash !== null && hash === prevHash;
      if (killed) {
        const kept = new Set((restored ?? '').split('\n').filter(Boolean));
        recovered = { period: n, recovery_ms: ms(w0), rows_lost: [...ledgerRows.keys()].filter((l) => !kept.has(l)).length, home_intact: row.home_intact };
        row.recovery_ms = recovered.recovery_ms;
        row.faults.push(`recovered:${recovered.rows_lost} rows lost`);
        killed = false;
      }

      c.period = { calls: 0, errors: 0, errorSample: null, rtt: [], cap: null, peeks: [], floorRefused: 0, stop() {} };
      const result = opts.fake
        ? await fakePeriod(c, sc.fake(agent, fakeState, n, due, wake, now), n)
        : await piPeriod(c, sc, firstPrompt(c, now, due, wake), opts, pool, tag);
      const { failed, ...fields } = result;
      Object.assign(row, fields);
      // A failed period keeps its events for the next one, as in agent-fleet.
      if (failed) inbox.push(...items.map((x) => ({ ...x, t: now })));
      else for (const e of due) handled.add(e.id);

      const out = await sh(p, c, endScript(c));
      const text = readLedger(out);
      prevHash = sha256(text);
      const fresh = [];
      for (const line of (text ?? '').split('\n').filter(Boolean)) {
        if (ledgerRows.has(line)) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch {}
        ledgerRows.set(line, parsed);
        if (parsed) fresh.push(parsed);
      }
      const transient = fresh.filter((r) => r.type === 'transient_failure');
      if (transient.length) row.faults.push(`transient:${transient.length}`, ...transient.filter((r) => r.http).map((r) => `http_${r.http}`));
      row.home_bytes = Number(/^bytes=(\d+)$/m.exec(out)?.[1] ?? NaN) || null;
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
      row.tool_errors = c.period.errors;
      row.tool_error_sample = c.period.errorSample;
      row.peeked_floor = c.period.peeks.length > 0;
      row.floor_peeks = c.period.peeks;
      row.floor_reads_refused = c.period.floorRefused;
      row.tool_rtt_median_ms = median(c.period.rtt);
      rtts.push(...c.period.rtt);
      row.cap = c.period.cap;
      tokens += row.tokens_total;
      cost += row.cost_usd;
      pool.live.delete(tag);
      pool.done += row.tokens_total;
      row.period_ms = ms(p0);
      if (opts.noise !== 'off') {
        const s0 = performance.now();
        await saveHome(p, c, homeFile);
        row.save_ms = ms(s0);
      }
      console.log(
        `${tag} period ${n} ${row.sim_time} woke on ${row.wake_reason}: ${row.tool_calls} tool calls` +
          `${row.tool_errors ? ` (${row.tool_errors} failed)` : ''}, ${sleep ? `sleeps until ${sleep.until}` : 'ORPHAN'}` +
          `${row.faults.length ? ` [${row.faults.join(', ').slice(0, 160)}]` : ''}` +
          `${row.error ? `, error: ${row.error.slice(0, 120)}` : ''}`,
      );

      // --human-buyer: show what the agent wrote and take the buyer's reply from the terminal.
      if (opts.human) {
        const sent = ledger().filter((r) => r.type === 'message_send');
        for (const m of sent.slice(shown)) console.log(`\nAgent to buyer (${m.at}): ${m.text}`);
        if (sent.length > shown) {
          shown = sent.length;
          const reply = await askHuman('Buyer reply (empty line = silence): ');
          if (reply) {
            const e = { id: `ev-${agent.events.length + 1}`, kind: 'human', type: 'buyer_message', at: fmt(now + 60), payload: { text: reply } };
            agent.events.push(e);
            inbox.push({ ev: e, t: now + 60, late: 0, dup: false });
          }
        }
      }

      // Next wake: the alarm, or the first pending event the agent listens for, whichever comes first.
      // Orphan rule: no sleep.json means a wake on the next simulated day.
      const alarm = sleep ? sleep.until_min : now + 1440;
      const on = [...ALWAYS_WAKE, ...(Array.isArray(sleep?.on) ? sleep.on : [])].filter((t) => !NEVER_WAKE.includes(t));
      const next = inbox.filter((x) => on.includes(x.ev.type)).sort((a, b) => a.t - b.t)[0];
      wake =
        next && next.t <= alarm
          ? { t: Math.max(next.t, now), reason: next.ev.id }
          : { t: alarm, reason: 'alarm', task: sleep ? sleep.task : 'Default wake: no next step was set' };

      if (Math.floor(now / 1440) >= sc.lastDay || wake.t >= sc.endMin) break;
      if (n >= sc.maxPeriods) {
        stopped = 'max_periods';
        break;
      }
      if (poolTotal(pool) >= MAX_TOKENS_PER_PROVIDER) {
        stopped = 'provider_tokens';
        break;
      }
      // The real pause starts when the awake period ends and includes the sleep primitive,
      // so the idle time between periods is the same on every provider.
      const pauseEnd = Date.now() + Math.max(MIN_PAUSE_MS, (wake.t - now) * sc.realMsPerSimMinute);
      const s0 = performance.now();
      if (n === killAfter) {
        // Infra noise: the sandbox dies between two periods. The next period recovers from the home copy.
        await withTimeout(p.destroy(c));
        row.faults.push('sandbox_killed');
        c = {};
        creating = undefined;
        killed = true;
      } else {
        await withTimeout(p.sleep(c));
      }
      row.sleep_ms = ms(s0);
      await delay(Math.max(0, pauseEnd - Date.now()));
    }
  } catch (e) {
    errors.push(oneLine(e));
    if (row) row.error = [row.error, oneLine(e)].filter(Boolean).join('; ');
    stopped ??= 'error';
  } finally {
    pool.live.delete(tag);
    // A create that outlived its timeout can still return a sandbox; wait for it so destroy deletes it.
    await withTimeout(Promise.resolve(creating).catch(() => {})).catch(() => {});
    await withTimeout(p.destroy(c)).catch((e) => errors.push(`destroy: ${oneLine(e)}`));
  }

  const L = ledger();
  const checks = rows.map((r) => r.home_intact).filter((x) => x !== null);
  const isHeavy = sc.catalog !== null;
  let humanDecision = null;
  if (opts.human) {
    const answer = (await askHuman('Decision, order or loss: ')).toLowerCase();
    humanDecision = answer === 'order' ? 'order' : 'loss';
    outcome = { ...buyerDecides(agent.persona, null, L, factorAt, now), decided_by: 'rule (for comparison)' };
  }
  const faultCounts = {};
  for (const f of rows.flatMap((r) => r.faults)) {
    const kind = f.split(':')[0];
    faultCounts[kind] = (faultCounts[kind] ?? 0) + 1;
  }
  const summary = {
    ...base,
    summary: 'agent',
    agent: agent.id,
    seed: agent.seed,
    periods: rows.length,
    promise_kept: agent.followUp ? followedUp(L, agent.followUp) : null,
    promises_kept: isHeavy ? brokenPromises(L, now).length === 0 : null,
    order_won: humanDecision ? humanDecision === 'order' : isHeavy ? outcome?.decision === 'order' : null,
    project_cancelled: Boolean(agent.persona?.cancelAt),
    quotes_rejected: isHeavy ? L.filter((r) => r.type === 'quote_rejected').length : null,
    peeked_floor: rows.some((r) => r.peeked_floor),
    floor_reads_refused: sum(rows.map((r) => r.floor_reads_refused ?? 0)),
    orphans: rows.filter((r) => r.orphan === true).length,
    events_once: agent.events.every((e) => (reached.get(e.id) ?? 0) >= 1 && handled.has(e.id)),
    no_double_action: isHeavy ? doubleActions(L).length === 0 : null,
    double_actions: isHeavy ? doubleActions(L) : null,
    no_message_after_cancel:
      cancelSeenAt === null ? null : !L.some((r) => r.type === 'message_send' && toMin(r.at) > cancelSeenAt),
    home_intact_all: checks.length ? checks.every(Boolean) : null,
    recovered_after_kill: recovered,
    human_decision: humanDecision,
    decision: outcome ?? (agent.persona?.cancelAt ? { decision: 'cancelled', reasons: ['the buyer cancelled the project'] } : null),
    persona: agent.persona,
    fake_role: opts.fake ? (agent.fakeRole ?? null) : null,
    faults_fired: faultCounts,
    wake_ms: rows.map((r) => r.wake_ms),
    wake_retries: sum(rows.map((r) => r.wake_retries)),
    tool_calls: sum(rows.map((r) => r.tool_calls)),
    tool_errors: sum(rows.map((r) => r.tool_errors)),
    tool_rtt_median_ms: median(rtts),
    home_bytes: rows.at(-1)?.home_bytes ?? null,
    tokens_total: tokens,
    cost_usd: cost,
    buyer_tokens: buyer.tokens,
    buyer_cost_usd: buyer.cost,
    wall_ms: ms(t0),
    stopped,
    error: errors.join('; ') || null,
  };
  for (const r of [...rows, summary]) appendFileSync(RESULTS, `${JSON.stringify({ time: new Date().toISOString(), ...r })}\n`);
  return summary;
}

// One provider: its agents run in parallel, each in its own sandbox. One agent's failure never stops the others.
async function lifecycle(name, sc, opts) {
  const p = PROVIDERS[name];
  const missing = p.env.filter((k) => !process.env[k]);
  if (missing.length) return console.log(`skip ${name}: missing env ${missing.join(', ')}`);

  const base = {
    provider: name,
    sdk: `${p.pkg}@${version(p.pkg)}`,
    scenario: sc.name,
    noise: opts.noise,
    run_seed: opts.seed,
    buyer: opts.human ? 'human' : opts.buyerText === 'llm' ? `model ${BUYER_MODEL}` : 'template',
    mode: opts.fake ? 'fake' : 'pi',
    model: opts.model,
    code: CODE,
  };
  if (!opts.fake) base.pi = `@earendil-works/pi-coding-agent@${version('@earendil-works/pi-coding-agent')}`;
  console.log(
    `run ${name} (${base.sdk}, scenario ${sc.name}, ${opts.agents} agents, noise ${opts.noise}, seed ${opts.seed}, buyer ${base.buyer}, mode ${base.mode}, model ${opts.model})`,
  );
  const t0 = performance.now();
  const pool = { done: 0, live: new Map() };
  const run = { seed: opts.seed, noise: opts.noise, notices: opts.notices, agents: opts.agents, human: opts.human, buyerText: opts.buyerText };
  const agents = Array.from({ length: opts.agents }, (_, k) => sc.agent(k + 1, run));
  const results = await Promise.all(agents.map((a) => runAgent(name, p, sc, a, opts, pool, base)));
  const count = (key) => (results.every((r) => r[key] === null) ? null : results.filter((r) => r[key] === true).length);
  const applies = (key) => results.filter((r) => r[key] !== null).length;
  const faults = {};
  for (const r of results) for (const [k, v] of Object.entries(r.faults_fired)) faults[k] = (faults[k] ?? 0) + v;
  const summary = {
    ...base,
    summary: 'provider',
    agents: results.length,
    agents_ok: results.filter((r) => !r.error && !r.stopped).length,
    orders_won: count('order_won'),
    projects_cancelled: results.filter((r) => r.project_cancelled).length,
    promise_kept: count('promise_kept'),
    promises_kept: count('promises_kept'),
    events_once: count('events_once'),
    no_double_action: count('no_double_action'),
    peeked_floor: count('peeked_floor'),
    no_message_after_cancel: count('no_message_after_cancel'),
    no_message_after_cancel_applies: applies('no_message_after_cancel'),
    home_intact_all: count('home_intact_all'),
    recovered_after_kill: results.filter((r) => r.recovered_after_kill && r.recovered_after_kill.rows_lost === 0 && r.recovered_after_kill.home_intact).length,
    kills: results.filter((r) => r.recovered_after_kill).length,
    orphans: sum(results.map((r) => r.orphans)),
    quotes_rejected: results.every((r) => r.quotes_rejected === null) ? null : sum(results.map((r) => r.quotes_rejected ?? 0)),
    faults_fired: faults,
    periods: sum(results.map((r) => r.periods)),
    wake_ms_median: median(results.flatMap((r) => r.wake_ms.filter((x) => x !== null))),
    tool_rtt_median_ms: median(results.map((r) => r.tool_rtt_median_ms).filter((x) => x !== null)),
    tokens_total: pool.done,
    cost_usd: sum(results.map((r) => r.cost_usd)),
    buyer_tokens: sum(results.map((r) => r.buyer_tokens)),
    buyer_cost_usd: sum(results.map((r) => r.buyer_cost_usd)),
    wall_ms: ms(t0),
    errors: results.filter((r) => r.error || r.stopped).map((r) => `${r.agent}: ${r.error ?? r.stopped}`),
  };
  appendFileSync(RESULTS, `${JSON.stringify({ time: new Date().toISOString(), ...summary })}\n`);
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

const usage = `usage: node --env-file=.env agent-lifecycle-test.mjs <${Object.keys(PROVIDERS).join('|')}|all> [--scenario basic|heavy] [--agents N] [--noise off|light|heavy] [--seed N] [--buyer-text template|llm] [--human-buyer] [--fake-agent] [--model <${Object.keys(PRICES).join('|')}>]`;
let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      'fake-agent': { type: 'boolean', default: false },
      'human-buyer': { type: 'boolean', default: false },
      model: { type: 'string', default: 'claude-haiku-5-5' },
      scenario: { type: 'string', default: 'basic' },
      agents: { type: 'string' },
      noise: { type: 'string', default: 'off' },
      seed: { type: 'string', default: '1' },
      'buyer-text': { type: 'string', default: 'template' },
    },
  });
} catch (e) {
  console.error(`${oneLine(e)}\n${usage}`);
  process.exit(2);
}
const fail = (message) => {
  console.error(`${message}\n${usage}`);
  process.exit(2);
};
const [arg, ...extra] = args.positionals;
const names = arg === 'all' ? Object.keys(PROVIDERS) : [arg];
if (extra.length || !names.every((n) => Object.hasOwn(PROVIDERS, n))) fail('name one provider or all');
const v = args.values;
if (!Object.hasOwn(SCENARIOS, v.scenario)) fail(`unknown scenario "${v.scenario}"`);
const sc = SCENARIOS[v.scenario];
if (!Object.hasOwn(NOISE, v.noise)) fail(`--noise must be ${Object.keys(NOISE).join(', ')}`);
if (!['template', 'llm'].includes(v['buyer-text'])) fail('--buyer-text must be template or llm');
const seed = Number(v.seed);
if (!Number.isInteger(seed) || seed < 0 || seed > 1_000_000) fail('--seed must be a whole number from 0 to 1000000');
let agentCount = v.agents === undefined ? sc.defaultAgents : Number(v.agents);
if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > 50) fail('--agents must be a whole number from 1 to 50');
if (v['human-buyer']) {
  if (arg === 'all' || sc !== heavy) fail('--human-buyer needs one provider and --scenario heavy');
  agentCount = 1;
}
if (!Object.hasOwn(PRICES, v.model)) fail(`unknown model "${v.model}": model-prices.json has ${Object.keys(PRICES).join(', ')}`);
const opts = {
  fake: v['fake-agent'],
  human: v['human-buyer'],
  model: v.model,
  agents: agentCount,
  noise: v.noise,
  seed,
  buyerText: v['buyer-text'],
  buyerPool: { tokens: 0 },
  notices: existsSync(NOTICES) ? JSON.parse(readFileSync(NOTICES, 'utf8')).notices : [],
  // Unique across processes started in the same millisecond, so two runs never share home copies.
  runId: `${new Date().toISOString().replace(/[:.]/g, '-')}-seed${seed}-${randomBytes(3).toString('hex')}`,
};
// The model key: for the Pi agent, and for the buyer model with --buyer-text llm.
if (!opts.fake || opts.buyerText === 'llm') {
  const secret = process.env.ANTHROPIC_SECRET;
  delete process.env.ANTHROPIC_SECRET; // the key lives only in opts from here on, never in the environment
  if (!secret?.trim()) {
    console.log('skip all providers: missing env ANTHROPIC_SECRET (the model key). Set it, or pass --fake-agent without --buyer-text llm.');
    process.exit(0);
  }
  opts.apiKey = parseKey(secret);
}
if (opts.noise !== 'off') mkdirSync(new URL(`${opts.runId}/`, HOMES), { recursive: true });

const summaries = (
  await Promise.all(names.map((n) => lifecycle(n, sc, opts).catch((e) => console.error(`${n} failed before its run: ${oneLine(e)}`))))
).filter(Boolean);
if (summaries.length) {
  const of = (k, s, n = s.agents) => (k === null ? '-' : `${k}/${n}`);
  console.table(
    Object.fromEntries(
      summaries.map((s) => [
        s.provider,
        {
          ok: of(s.agents_ok, s),
          orders: of(s.orders_won, s),
          promise_kept: of(s.promise_kept, s),
          promises_kept: of(s.promises_kept, s),
          events_once: of(s.events_once, s),
          no_double: of(s.no_double_action, s),
          peeked: of(s.peeked_floor, s),
          cancel_ok: s.no_message_after_cancel_applies ? of(s.no_message_after_cancel, s, s.no_message_after_cancel_applies) : '-',
          home_intact: of(s.home_intact_all, s),
          recovered: s.kills ? `${s.recovered_after_kill}/${s.kills}` : '-',
          orphans: s.orphans,
          rejected: s.quotes_rejected ?? '-',
          periods: s.periods,
          'wake ms': s.wake_ms_median,
          'rtt ms': s.tool_rtt_median_ms,
          tokens: s.tokens_total,
          'cost usd': Number(s.cost_usd.toFixed(4)),
          'wall s': Math.round(s.wall_ms / 1000),
          errors: s.errors.join('; ').slice(0, 50),
        },
      ]),
    ),
  );
  if (opts.buyerText === 'llm') {
    console.log(`buyer model: ${sum(summaries.map((s) => s.buyer_tokens))} tokens, ${sum(summaries.map((s) => s.buyer_cost_usd)).toFixed(4)} USD`);
  }
  if (summaries.some((s) => s.errors.length)) process.exitCode = 1;
}
