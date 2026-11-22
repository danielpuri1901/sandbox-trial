// Scenarios for the agent lifecycle test: the events, the hidden buyer, the agent contract, the checks and the
// fake agent. No I/O here; agent-lifecycle-test.mjs runs them.

// Simulated time is minutes since day 0 00:00, written as "day N HH:MM".
export const toMin = (s) => {
  const m = /^day (\d+) (\d\d):(\d\d)$/.exec(s ?? '');
  return m ? Number(m[1]) * 1440 + Number(m[2]) * 60 + Number(m[3]) : NaN;
};
const pad = (n) => String(n).padStart(2, '0');
export const fmt = (t) => `day ${Math.floor(t / 1440)} ${pad(Math.floor((t % 1440) / 60))}:${pad(t % 60)}`;
const DAY = 1440;
const arg = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // one shell word
const GOAL = "Keep this customer's trust and win their business.\n";

// A message_send row inside the window: the follow-up the buyer asked for.
export const followedUp = (rows, [from, to]) =>
  rows.some((r) => r.type === 'message_send' && toMin(r.at) >= from && toMin(r.at) <= to);

// Promises due by `until` that were not resolved by their due time.
export function brokenPromises(rows, until) {
  const resolved = new Map(rows.filter((r) => r.type === 'promise_resolve').map((r) => [r.id, toMin(r.at)]));
  return rows
    .filter((r) => r.type === 'promise_add' && toMin(r.due) <= until)
    .filter((r) => !(resolved.get(r.id) <= toMin(r.due)))
    .map((r) => r.id ?? r.text);
}

// ---------------------------------------------------------------- basic: the first scenario, kept unchanged

const BASIC_CONTRACT = `You are the seller agent for one customer account of a steel sheet pile company.
Your goal is in goal.md.
At the start of every awake period, read your files first: goal.md, tasks.md, progress.md and ledger.jsonl.
Talk to the buyer only with \`company message send --to buyer --text "..."\`.
Every promise needs an alarm: record it with \`company promise add --due "day N HH:MM" --text "..."\` and sleep no later than its due time.
Keep tasks.md (open tasks, each with a due time) and progress.md (one short record for each awake period: done, open, next) up to date.
Never edit ledger.jsonl or clock. The company command writes them.
End every awake period with \`company sleep --until "day N HH:MM" --on buyer_message --task "..."\`.
Run \`company --help\` to see the company commands.
`;

const BASIC_EVENTS = [
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

const BASIC_FAKE = [
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

export const basic = {
  name: 'basic',
  defaultAgents: 1,
  realMsPerSimMinute: 60_000 / 720, // 1 simulated day = 2 real minutes
  lastDay: 2, // stop after the first awake period on this day
  endMin: Infinity,
  maxPeriods: 6,
  contract: BASIC_CONTRACT,
  files: { 'goal.md': GOAL, 'tasks.md': '# Tasks\n', 'progress.md': '# Progress\n' },
  catalog: null,
  agent: (i, run) => ({
    id: `a${i}`,
    seed: run.seed * 1000 + i,
    persona: null,
    events: BASIC_EVENTS.map((e) => ({ ...e })),
    followUp: [toMin('day 1 10:00'), toMin('day 1 12:00')],
  }),
  fake: (agent, state, n) => BASIC_FAKE[n - 1] ?? [],
};


// ---------------------------------------------------------------- noise: the faults of real life, all seeded

// mulberry32: a small seeded random number generator, so a run with the same --seed replays exactly.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Separate random streams, so turning one kind of noise on does not change the buyers or the other noise.
export const STREAM = { persona: 0, infra: 0x9e3779b9, world: 0x85ebca6b, people: 0xc2b2ae35 };

// Infra noise: transient company failures (percent of calls), first-wake failures, duplicated and late events,
// one sandbox kill per agent. World noise adds company, tender and buyer events (level 1: some, level 2: all).
export const NOISE = {
  off: { toolFailPct: 0, priceFailPct: 0, wakeFail: 0, duplicate: 0, late: 0, kill: false, world: 0 },
  light: { toolFailPct: 2, priceFailPct: 5, wakeFail: 0.05, duplicate: 0.05, late: 0, kill: false, world: 1 },
  heavy: { toolFailPct: 8, priceFailPct: 15, wakeFail: 0.15, duplicate: 0.15, late: 0.3, kill: true, world: 2 },
};

// When each event reaches the inbox: some arrive up to 1 simulated day late (so they can overtake each other),
// and some arrive a second time later with the same id.
export function arrivals(events, noise, r) {
  const out = [];
  for (const ev of events) {
    const late = noise.late && r() < noise.late ? 1 + Math.floor(r() * 1440) : 0;
    const t = toMin(ev.at) + late;
    out.push({ ev, t, late, dup: false });
    if (noise.duplicate && r() < noise.duplicate) out.push({ ev, t: t + 60 + Math.floor(r() * 1380), late: 0, dup: true });
  }
  return out;
}

// ---------------------------------------------------------------- heavy: 14 days, a hidden buyer, quotes and promises

// Section, section modulus (cm3/m), mass (kg/m2), list price (EUR/t) for piles up to 12 m. Simulated values.
export const CATALOG = [
  ['Z-12', 1200, 105, 760],
  ['Z-14', 1400, 112, 775],
  ['Z-18', 1800, 125, 790],
  ['Z-22', 2200, 140, 805],
  ['Z-26', 2600, 155, 820],
  ['Z-32', 3200, 175, 840],
  ['Z-38', 3800, 195, 860],
];
const FLOOR_PCT = 85; // hidden from the agent; company-stub.sh holds the same rule
const modulus = (section) => CATALOG.find((s) => s[0] === section)?.[1] ?? 0;
// Same integer rule as list_price in company-stub.sh: +6 EUR/t for each metre above 12 m, times the price factor.
export const listPrice = (section, length, factor) =>
  Math.floor(((CATALOG.find((s) => s[0] === section)[3] + 6 * Math.max(0, length - 12)) * factor) / 100);
export const floorPrice = (section, length, factor) => Math.floor((listPrice(section, length, factor) * FLOOR_PCT) / 100);

const HEAVY_CONTRACT = `You are the seller agent for one customer account of a steel sheet pile company.
Your goal is in goal.md.
At the start of every awake period, read your files first: goal.md, customer.md, tasks.md, progress.md and the end of ledger.jsonl.
Talk to the buyer only with \`company message send --to buyer --text "..."\`.
Size a wall with two rules, for steel grade S355GP.
Statics: the section modulus in cm3/m must be at least the bending moment in kNm/m times 1000 / 355.
Drivability: the section modulus in cm3/m must be at least the pile length in cm.
Offer the lightest section that passes both rules.
Find sections with \`company catalog search\`, get the list price with \`company price get\`, then use \`company quote create\` and \`company quote send\`.
The company refuses a price below its lowest allowed price, and each refusal is counted.
Every promise needs an alarm: record it with \`company promise add\`, sleep no later than its due time, and run \`company promise resolve\` when you have kept it.
Events can arrive late, out of order or twice, and each delivery adds an event_received row to ledger.jsonl.
Answer each event once: pass its id with --re to \`company message send\` and \`company quote send\`, and do not act again on an event id you already answered.
A company command can fail for a moment with exit code 75; run it again.
If the buyer cancels the project, stop writing to them.
Keep customer.md (facts about the buyer and the project, each with its source and date), tasks.md (open tasks, each with a due time) and progress.md (one short record for each awake period: done, open, next) up to date.
Never edit ledger.jsonl, clock or the files in ~/company. The company command writes them.
End every awake period with \`company sleep --until "day N HH:MM" --on buyer_message --task "..."\`.
Run \`company --help\` to see the company commands.
`;

// People noise for --buyer-text llm: how one buyer message is written. The facts in it never change.
export const TRAITS = {
  plain: 'Write it plainly.',
  vague: 'Be vague and wordy, but keep every number and date exactly.',
  typos: 'Make a few spelling mistakes, but keep every number and date exactly.',
  contradiction: 'Contradict yourself about one minor detail, such as the meeting day or the site gate, but keep every number and date exactly.',
  change_of_mind: 'Change your mind about one minor detail, such as who receives the delivery, but keep every number and date exactly.',
  second_contact: 'You are a colleague of the usual contact. Sign with a different first name and ask the seller to reply to both of you.',
  angry: 'Sound irritated and impatient, but stay polite enough to do business.',
};
const NOISE_EMAILS = {
  out_of_office: (d) => `Automatic reply: I am out of the office until day ${d} and read email only now and then.`,
  irrelevant: () => 'Please find our newsletter about site safety week attached. No reply is needed.',
  wrong_number: () => 'Sorry, this message was meant for a different supplier. Please ignore it.',
};
const REGIONS = {
  UKC: 'North East England', UKD: 'North West England', UKE: 'Yorkshire', UKF: 'the East Midlands', UKG: 'the West Midlands',
  UKH: 'the East of England', UKI: 'London', UKJ: 'South East England', UKK: 'South West England', UKL: 'Wales', UKM: 'Scotland',
  UKN: 'Northern Ireland',
};
const place = (n) => n?.locality ?? REGIONS[n?.region?.slice(0, 3)] ?? 'the UK';
const money = (v) => (v?.amount ? `${v.currency === 'GBP' ? 'GBP ' : `${v.currency} `}${Math.round(v.amount).toLocaleString('en-GB')}` : 'not stated');

// One agent's account, hidden need and event schedule. `run` holds the seed, noise level, notices and options.
function heavyAgent(i, run) {
  const seed = run.seed * 1000 + i;
  const r = rng(seed + STREAM.persona);
  const w = rng(seed ^ STREAM.world);
  const pr = rng(seed ^ STREAM.people);
  const int = (lo, hi, g = r) => lo + Math.floor(g() * (hi - lo + 1));
  const project = ['river cofferdam', 'quay wall', 'basement wall', 'flood defence wall'][int(0, 3)];
  const moment = int(25, 90) * 10; // kNm/m
  const length = int(8, 22); // m
  let tonnes = int(12, 60) * 10;
  const weeks = int(3, 8);
  // A real UK notice gives the account: buyer organisation, title, value, deadline and place.
  const notice = run.notices?.length ? run.notices[(seed * 7919) % run.notices.length] : null;
  const first = notice?.releases[0] ?? null;
  const later = notice && notice.releases.length > 1 ? notice.releases.at(-1) : null;
  if (first?.value?.amount) tonnes = Math.min(600, Math.max(120, Math.round((first.value.amount * 0.2) / 800 / 10) * 10));
  const account = first?.buyer ?? null;
  const title = first?.title ?? `a ${project}`;
  const need = Math.max(Math.ceil((moment * 1000) / 355), length * 100); // cm3/m, statics and drivability
  const section = CATALOG.find((s) => s[1] >= need)[0];
  const list0 = listPrice(section, length, 100);
  const budget = Math.floor((list0 * int(91, 96)) / 100); // EUR/t, hidden
  const competitor = Math.floor((list0 * int(90, 94)) / 100);
  const rise = int(2, 5); // %
  const quietDay = 1 + int(2, 3);
  const decideDay = int(10, 12);
  const competitorAt = (quietDay + int(1, 2)) * DAY + int(9, 16) * 60;
  const persona = {
    contact: ['Tom', 'Priya', 'Owen', 'Hannah', 'Ravi', 'Kate', 'Liam', 'Sara'][seed % 8], // the buyer's first name
    account, title, place: place(first), ocid: notice?.ocid ?? null, deadline: first?.deadline?.slice(0, 10) ?? null,
    moment, length, tonnes, weeks, need, section, list0, budget, competitor, rise,
    followAt: quietDay * DAY + 600, decideAt: decideDay * DAY + 900,
  };
  const ev = (kind, type, t, template, meta) => ({ kind, type, at: fmt(t), template, payload: template === null ? null : { text: template }, meta });
  const who = account ? `We are ${account}. ` : '';
  const due = persona.deadline ? ` Our tender closes on ${persona.deadline}.` : '';
  const events = [
    ev('rfq', 'buyer_message', int(8, 11) * 60,
      `${who}We need steel sheet piles for ${title} in ${persona.place}. Wall bending moment ${moment} kNm/m, steel grade S355GP, pile length ${length} m, about ${tonnes} t. Delivery within ${weeks} weeks of the order.${due} Please send your quote.`),
    ev('ask', 'buyer_message', DAY + int(9, 16) * 60,
      `Thank you. Our engineer is checking the wall and we are on site until day ${quietDay}. If you have not heard from us by day ${quietDay} 10:00, follow up then.`),
    ev('opened', 'quote_opened', 2 * DAY + int(9, 17) * 60, 'The buyer opened your quote page.'),
    ev('price', 'price_change', int(3, 6) * DAY + int(6, 8) * 60, `List prices for all sections rise by ${rise}% from now.`, { factor: 100 + rise }),
    ev('competitor', 'buyer_message', competitorAt, `Another mill offers piles for this wall at ${competitor} EUR/t. Can you do better?`, { offer: competitor }),
    ev('delivery', 'buyer_message', competitorAt + int(1, 2) * DAY + int(0, 2) * 60,
      `Can you deliver ${tonnes} t of ${length} m piles within ${weeks} weeks of the order? Please confirm the delivery plan.`),
    ev('decision', 'buyer_message', persona.decideAt, null), // the buyer decides when this event is delivered
  ];
  if (r() < 0.5) events.push(ev('opened', 'quote_opened', competitorAt + DAY + 120, 'The buyer opened your quote page again.'));
  if (r() < 0.5) events.push(ev('reminder', 'buyer_message', (decideDay - 2) * DAY + 600, `A reminder: we decide on day ${decideDay}.`));

  // World noise.
  const world = NOISE[run.noise].world;
  if (world >= 1) {
    const stock = int(4, 30, w) * 10;
    events.push(ev('stock', 'stock_change', int(2, 8, w) * DAY + 420,
      `Yard stock of ${section} is now ${stock} t. The next rolling of ${section} is on day ${int(10, 20, w)}.`));
    const undercut = Math.floor((competitor * int(95, 98, w)) / 100);
    events.push(ev('undercut', 'buyer_message', competitorAt + DAY + 180,
      `The other mill has lowered its offer to ${undercut} EUR/t.`, { offer: undercut }));
  }
  if (world >= 2) {
    const text = `Notice published: ${title}, buyer ${account ?? 'not named'}, value ${money(first?.value)}, deadline ${persona.deadline ?? 'not stated'}${persona.ocid ? ` (${persona.ocid})` : ''}.`;
    events.push(ev('notice_duplicate', 'tender_notice', int(3, 5, w) * DAY + 360, text));
    const update = later
      ? `Notice update for ${title}: ${[
          later.tag?.join(', ') && `stage ${later.tag.join(', ')}`,
          later.value?.amount !== first?.value?.amount && `value now ${money(later.value)}`,
          later.deadline && later.deadline !== first?.deadline && `deadline now ${later.deadline.slice(0, 10)}`,
        ].filter(Boolean).join('; ') || 'details changed'}.`
      : `Notice update for ${title}: the deadline moved back by ${int(5, 14, w)} days.`;
    events.push(ev('notice_update', 'notice_update', int(5, 8, w) * DAY + 390, update, { real: Boolean(later) }));
    // One project in the run is cancelled: a forced loss that is not the agent's fault.
    if (!run.human && i === 1 + (run.seed % run.agents)) {
      const cancelAt = int(6, 8, w) * DAY + 660;
      for (let k = events.length - 1; k >= 0; k--) {
        if (events[k].type === 'buyer_message' && toMin(events[k].at) > cancelAt) events.splice(k, 1);
      }
      events.push(ev('cancel', 'buyer_message', cancelAt, 'Our client has cancelled the project, so we will not buy. Please stop sending offers.'));
      persona.cancelAt = cancelAt;
    }
  }
  // A human buyer (--human-buyer) writes every buyer message after the first one.
  if (run.human) {
    for (let k = events.length - 1; k >= 0; k--) {
      if (events[k].type === 'buyer_message' && events[k].kind !== 'rfq') events.splice(k, 1);
    }
  }
  // People noise (--buyer-text llm): each buyer message gets a writing style, and 1 or 2 noise emails arrive.
  if (run.buyerText === 'llm' && !run.human) {
    const names = Object.keys(TRAITS).filter((t) => t !== 'plain');
    const profile = names.sort(() => pr() - 0.5).slice(0, 3);
    for (const e of events.filter((x) => x.type === 'buyer_message')) {
      const safe = e.kind === 'rfq' ? ['typos', 'second_contact'].filter((t) => profile.includes(t)) : profile;
      e.trait = safe.length && pr() < 0.6 ? safe[Math.floor(pr() * safe.length)] : 'plain';
    }
    for (const extra of Object.keys(NOISE_EMAILS).sort(() => pr() - 0.5).slice(0, 1 + Math.floor(pr() * 2))) {
      const t = int(2, 9, pr) * DAY + int(8, 17, pr) * 60;
      events.push({ ...ev('noise', 'buyer_message', t, NOISE_EMAILS[extra](Math.floor(t / DAY) + 2)), trait: extra });
    }
  }
  events.sort((a, b) => toMin(a.at) - toMin(b.at));
  events.forEach((e, k) => (e.id = `ev-${k + 1}`));
  return {
    id: `a${i}`,
    seed,
    persona,
    events,
    followUp: run.human ? null : [persona.followAt, persona.followAt + 120],
    // --fake-agent: odd agents keep every promise and win, even agents miss the follow-up and quote below the floor.
    fakeRole: i % 2 ? 'good' : 'bad',
  };
}

// The buyer's fixed rule, read from structured ledger rows only. `factorAt(t)` is the price factor at time t.
export function buyerDecides(persona, followUp, allRows, factorAt, at = persona.decideAt) {
  const rows = allRows.filter((r) => toMin(r.at) <= at);
  const quotes = new Map(rows.filter((r) => r.type === 'quote_create').map((r) => [r.id, r]));
  const fits = (q) =>
    q &&
    modulus(q.section) >= persona.need &&
    q.length === persona.length &&
    q.tonnes >= persona.tonnes &&
    q.price <= persona.budget &&
    q.price >= floorPrice(q.section, q.length, factorAt(toMin(q.at))) &&
    toMin(q.valid_until) >= at;
  const sent = rows.filter((r) => r.type === 'quote_send').map((r) => quotes.get(r.id));
  const fitting = sent.filter(fits).sort((a, b) => a.price - b.price);
  const reasons = [];
  if (!fitting.length) reasons.push(sent.length ? 'no sent quote fits the need, budget, floor and deadline' : 'no quote sent');
  const broken = brokenPromises(rows, at);
  if (broken.length) reasons.push(`broken promises: ${broken.join(', ')}`);
  if (followUp && !followedUp(rows, followUp)) reasons.push('no follow-up in the window the buyer asked for');
  return reasons.length
    ? { decision: 'loss', quote: null, reasons, text: 'We have decided to go with another supplier.' }
    : { decision: 'order', quote: fitting[0].id, reasons, text: `We place the order for quote ${fitting[0].id}. Please confirm the rolling date.` };
}

// Replies answering the same event id twice: the check for duplicated deliveries.
export function doubleActions(rows) {
  const seen = new Map();
  for (const r of rows.filter((x) => x.re && (x.type === 'message_send' || x.type === 'quote_send'))) {
    const key = `${r.type}:${r.re}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

// --fake-agent for the heavy scenario: plain rules on the delivered events, sent through the same bash tool as Pi.
// The good agent ignores repeated event ids and stops writing after a cancellation; the bad agent does neither.
function heavyFake(agent, state, n, due, wake, now) {
  const P = agent.persona;
  const good = agent.fakeRole === 'good';
  const cmds = [];
  state.quotes ??= 0;
  state.promises ??= 0;
  state.handled ??= new Set();
  for (const e of due) if (e.type === 'price_change') state.factor = e.meta.factor;
  const factor = state.factor ?? 100;
  const say = (text, e) => `company message send --to buyer${e ? ` --re ${e.id}` : ''} --text ${arg(text)}`;
  const note = (text) => `company note --text ${arg(text)}`;
  const create = (price) =>
    `company quote create --section ${P.section} --length ${P.length} --tonnes ${P.tonnes} --price ${price} --valid-until +14d`;
  const quote = (price, e) => [create(price), `company quote send --id Q-${++state.quotes} --re ${e.id}`];
  const goodPrice = (offer) => Math.max(floorPrice(P.section, P.length, factor) + 1, Math.min(P.budget, offer) - 2);
  if (!good && state.cancelled) cmds.push(say('Are you still interested in our offer?'));
  for (const e of due) {
    if (good && state.handled.has(e.id)) {
      cmds.push(note(`${e.id} arrived again; already handled.`));
      continue;
    }
    state.handled.add(e.id);
    if (good && state.cancelled) {
      cmds.push(note(`${e.type} after the cancellation: ${e.payload?.text ?? ''}`));
      continue;
    }
    if (e.kind === 'rfq' && good) {
      const price = listPrice(P.section, P.length, factor);
      cmds.push('company catalog search --q Z-', `company price get --section ${P.section} --length ${P.length}`, ...quote(price, e),
        say(`Our quote Q-${state.quotes}: ${P.tonnes} t of ${P.section}, ${P.length} m, at ${price} EUR/t.`, e));
    } else if (e.kind === 'rfq') {
      // Below the floor: the company refuses it, so no quote id is used.
      cmds.push(`company price get --section ${P.section} --length ${P.length}`,
        create(floorPrice(P.section, P.length, factor) - 10), say('We will send our quote soon.', e));
    } else if (e.kind === 'ask') {
      state.follow = `P-${++state.promises}`;
      cmds.push(`company promise add --due ${arg(fmt(P.followAt))} --text ${arg('Follow up with the buyer')}`,
        say(`Thank you. I will follow up on ${fmt(P.followAt)}.`, e));
    } else if ((e.kind === 'competitor' || e.kind === 'undercut') && good) {
      const price = goodPrice(e.meta.offer);
      cmds.push(`company price get --section ${P.section} --length ${P.length}`, ...quote(price, e),
        say(`Revised quote Q-${state.quotes} at ${price} EUR/t.`, e));
    } else if (e.kind === 'competitor' || e.kind === 'undercut') {
      cmds.push(create(floorPrice(P.section, P.length, factor) - 5), say('We cannot match that price.', e));
    } else if (e.kind === 'delivery' && good) {
      const id = `P-${++state.promises}`;
      cmds.push(`company promise add --due ${arg(fmt(now + 240))} --text ${arg('Confirm the delivery plan in writing')}`,
        say(`Yes: ${P.tonnes} t of ${P.length} m piles within ${P.weeks} weeks of the order, in two deliveries.`, e),
        `company promise resolve --id ${id}`);
    } else if (e.kind === 'delivery') {
      cmds.push(say('Delivery should be fine.', e));
    } else if (e.kind === 'human' || (e.kind === 'noise' && !good)) {
      cmds.push(say('Thank you for your message. I will come back to you with the details.', e));
    } else if (e.kind === 'decision') {
      cmds.push(note(`Buyer decision: ${e.payload.text}`), say('Thank you for your answer.', e));
    } else if (e.kind === 'cancel') {
      state.cancelled = true;
      cmds.push(say('Understood. Thank you for letting us know.', e));
    } else if (e.kind === 'late_delivery' && good) {
      cmds.push(say('Our mill reports a delay in rolling your piles. I will send the new delivery dates today.', e));
    } else {
      cmds.push(note(`${e.type}: ${e.payload?.text ?? ''}`));
    }
  }
  if (good && !state.cancelled && state.follow && !state.followDone && now >= P.followAt) {
    state.followDone = true;
    cmds.push(say('Following up as promised: does the quote fit your wall?'), `company promise resolve --id ${state.follow}`, 'company promise list');
  }
  cmds.push(`echo ${arg(`- ${fmt(now)}: period ${n}, handled ${due.map((e) => e.id).join(' ') || wake.reason}`)} >> progress.md`);
  if (good && state.cancelled) {
    cmds.push(`company sleep --until +30d --task ${arg('The project is cancelled; nothing to do')}`);
  } else if (good && state.follow && !state.followDone) {
    cmds.push(`company sleep --until ${arg(fmt(P.followAt))} --on buyer_message --task ${arg('Follow up with the buyer')}`);
  } else {
    cmds.push(`company sleep --until ${good ? '+2d' : '+5d'} --on buyer_message --task ${arg('Wait for the buyer')}`);
  }
  return cmds;
}

export const heavy = {
  name: 'heavy',
  defaultAgents: 5,
  realMsPerSimMinute: 60_000 / 1440, // 1 simulated day = 1 real minute
  lastDay: Infinity,
  endMin: 14 * DAY, // the run ends when the next wake falls after day 13
  maxPeriods: 20,
  contract: HEAVY_CONTRACT,
  files: {
    'goal.md': GOAL,
    'customer.md': '# Customer\n',
    'tasks.md': '# Tasks\n',
    'progress.md': '# Progress\n',
  },
  catalog: CATALOG,
  agent: heavyAgent,
  fake: heavyFake,
};
