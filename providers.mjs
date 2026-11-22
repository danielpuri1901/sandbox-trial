// Shared sandbox provider map for the sleep-wake test and the agent lifecycle test.
// Each provider: create a sandbox at its default size, run a shell script (return stdout, throw on non-zero exit),
// sleep, wake, destroy. State lives on the context object `c`.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const STEP_TIMEOUT_MS = 120_000;

const env = (k) => process.env[k];
const vercelCreds = () => ({ token: env('VERCEL_TOKEN'), teamId: env('VERCEL_TEAM_ID'), projectId: env('VERCEL_PROJECT_ID') });

export const PROVIDERS = {
  e2b: {
    pkg: 'e2b',
    env: ['E2B_API_KEY'],
    primitive: 'pause() (default mode "full": memory + filesystem) -> connect()',
    async create(c) {
      const { Sandbox } = await import('e2b');
      // The default lifetime is 5 minutes, shorter than an agent awake period; 1 h is the Hobby maximum.
      c.sbx = await Sandbox.create({ timeoutMs: 3_600_000 });
    },
    async run(c, script) {
      return (await c.sbx.commands.run(script)).stdout; // throws CommandExitError on a non-zero exit
    },
    async sleep(c) { await c.sbx.pause(); },
    async wake(c) { await c.sbx.connect({ timeoutMs: 3_600_000 }); },
    async destroy(c) { if (c.sbx) await c.sbx.kill(); },
  },

  daytona: {
    pkg: '@daytona/sdk',
    env: ['DAYTONA_API_KEY'],
    // Dashboard API keys are rejected by the v2 API (401 on create) but work on v0, so the v0 client is used.
    // pause() (memory) is refused on the default container sandbox ("Pausing is not supported for this
    // sandbox"); docs limit it to VM sandboxes. stop() keeps the disk and is billed the same.
    primitive: 'v0 API: stop() (disk only; pause() refused on container sandboxes) -> start()',
    async create(c) {
      const { Daytona } = await import('@daytona/sdk');
      c.sbx = await new Daytona().v0.create(undefined, { timeout: 120 }); // default image and size
    },
    async run(c, script) {
      // Pass the script as base64 so no quoting can change it, whether or not executeCommand uses a shell.
      const b64 = Buffer.from(script).toString('base64');
      const r = await c.sbx.process.executeCommand(`sh -c "echo ${b64} | base64 -d | sh"`, undefined, undefined, 120);
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.result}`);
      return r.result;
    },
    async sleep(c) { await c.sbx.stop(120); },
    async wake(c) { await c.sbx.start(120); },
    async destroy(c) { if (c.sbx) await c.sbx.delete(120); },
  },

  sprites: {
    pkg: '@fly/sprites',
    env: ['SPRITES_TOKEN'],
    // The SDK has no sleep call: a Sprite pauses itself after about 30 s without exec activity.
    primitive: 'idle auto-pause (no SDK call; 45 s idle wait, then polled getSprite().status until warm or cold) -> next exec wakes it',
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
      // The first run saw "cold" 170 ms after the last exec while the sleeper still ran, so status
      // reported then is not a real pause. Wait past the ~30 s idle window before trusting it.
      const before = (await c.client.getSprite(c.sprite.name)).status;
      await delay(45_000);
      const end = Date.now() + STEP_TIMEOUT_MS - 50_000;
      while (Date.now() < end) {
        const { status } = await c.client.getSprite(c.sprite.name);
        if (status === 'warm' || status === 'cold') return `status ${before} at start, reached ${status} after idle wait`;
        await delay(2000);
      }
      throw new Error('Sprite did not report warm or cold');
    },
    async wake() {}, // the wake step's first exec wakes the Sprite
    async destroy(c) { if (c.sprite) await c.sprite.delete(); },
  },

  baseten: {
    pkg: '@basetenlabs/sandbox',
    env: ['BASETEN_API_KEY'],
    // No SDK sleep call: a sandbox goes on standby after a few seconds without requests (memory and
    // processes kept) and the next request resumes it. Status stays DEPLOYED on standby, so standby
    // itself is not observable; the 45 s wait matches the Sprites run.
    primitive: 'idle standby (no SDK call; 45 s idle wait, standby not observable) -> next exec resumes it',
    async create(c) {
      const { SandboxClient } = await import('@basetenlabs/sandbox');
      c.client = new SandboxClient({ apiKey: env('BASETEN_API_KEY') });
      // Safety net: Baseten deletes the sandbox after 1 h even if this script dies before destroy.
      c.sbx = await c.client.create({
        lifecycle: { expirationPolicies: [{ type: 'TTL_MAX_AGE', afterMs: 3_600_000, action: 'DELETE' }] },
      });
    },
    async run(c, script) {
      const b64 = Buffer.from(script).toString('base64');
      const r = await c.sbx.process.exec({ command: `echo ${b64} | base64 -d | sh`, waitForCompletion: true });
      if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${r.stderr}`);
      return r.stdout;
    },
    async sleep() { await delay(45_000); },
    async wake() {}, // the wake step's first exec resumes the sandbox
    async destroy(c) { if (c.sbx) await c.client.delete({ name: c.sbx.name }); },
  },

  modal: {
    pkg: 'modal',
    env: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
    // In-place pause needs persistent sandboxes, which this workspace is refused ("Persistent Sandboxes are
    // not available for this workspace yet"). So: memory + filesystem snapshot, terminate, restore into a
    // new sandbox. The snapshot itself has no delete call in this SDK; Modal keeps memory snapshots 7 days.
    primitive: 'experimentalSnapshot() (memory + filesystem) + terminate() -> sandboxes.experimentalFromSnapshot()',
    async create(c) {
      const { ModalClient } = await import('modal');
      c.modal = new ModalClient();
      const app = await c.modal.apps.fromName('sandbox-trial', { createIfMissing: true });
      // Modal has no default image; Debian slim is close to the Debian/Ubuntu images the other providers boot.
      const image = c.modal.images.fromRegistry('debian:bookworm-slim');
      // The default lifetime is 5 minutes, shorter than an agent awake period.
      c.sb = await c.modal.sandboxes.create(app, image, { experimentalEnableSnapshot: true, timeoutMs: 3_600_000 });
    },
    async run(c, script) {
      const p = await c.sb.exec(['sh', '-c', script]);
      const [out, err, code] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
      if (code !== 0) throw new Error(`exit ${code}: ${err}`);
      return out;
    },
    async sleep(c) {
      c.snap = await c.sb.experimentalSnapshot();
      await c.sb.terminate();
    },
    async wake(c) { c.sb = await c.modal.sandboxes.experimentalFromSnapshot(c.snap); },
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

export const oneLine = (e) => String(e?.message ?? e).replace(/\s+/g, ' ').trim().slice(0, 500);
export const version = (pkg) => JSON.parse(readFileSync(new URL(`./node_modules/${pkg}/package.json`, import.meta.url))).version;

export function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${STEP_TIMEOUT_MS / 1000} s`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
