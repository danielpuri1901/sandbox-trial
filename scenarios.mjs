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
  agent: (i) => ({
    id: `a${i}`,
    seed: null,
    persona: null,
    events: BASIC_EVENTS.map((e) => ({ ...e })),
    followUp: [toMin('day 1 10:00'), toMin('day 1 12:00')],
  }),
  fake: (agent, state, n) => BASIC_FAKE[n - 1] ?? [],
};

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
Keep customer.md (facts about the buyer and the project, each with its source and date), tasks.md (open tasks, each with a due time) and progress.md (one short record for each awake period: done, open, next) up to date.
Never edit ledger.jsonl, clock or the files in ~/company. The company command writes them.
End every awake period with \`company sleep --until "day N HH:MM" --on buyer_message --task "..."\`.
Run \`company --help\` to see the company commands.
`;

// mulberry32: a small seeded random number generator, so every provider gets the same buyers and events.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heavyAgent(i) {
  const seed = 1000 + i;
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const project = ['river cofferdam', 'quay wall', 'basement wall', 'flood defence wall'][int(0, 3)];
  const moment = int(25, 90) * 10; // kNm/m
  const length = int(8, 22); // m
  const tonnes = int(12, 60) * 10;
  const weeks = int(3, 8);
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
    project, moment, length, tonnes, weeks, need, section, list0, budget, competitor, rise,
    followAt: quietDay * DAY + 600, decideAt: decideDay * DAY + 900,
  };
  const ev = (kind, type, t, payload, meta) => ({ kind, type, at: fmt(t), payload, meta });
  const events = [
    ev('rfq', 'buyer_message', int(8, 11) * 60, {
      text: `We need steel sheet piles for a ${project}. Wall bending moment ${moment} kNm/m, steel grade S355GP, pile length ${length} m, about ${tonnes} t. Delivery within ${weeks} weeks of the order. Please send your quote.`,
    }),
    ev('ask', 'buyer_message', DAY + int(9, 16) * 60, {
      text: `Thank you. Our engineer is checking the wall and we are on site until day ${quietDay}. If you have not heard from us by day ${quietDay} 10:00, follow up then.`,
    }),
    ev('opened', 'quote_opened', 2 * DAY + int(9, 17) * 60, { text: 'The buyer opened your quote page.' }),
    ev('price', 'price_change', int(3, 6) * DAY + int(6, 8) * 60, { text: `List prices for all sections rise by ${rise}% from now.` }, { factor: 100 + rise }),
    ev('competitor', 'buyer_message', competitorAt, {
      text: `Another mill offers piles for this wall at ${competitor} EUR/t. Can you do better?`,
    }),
    ev('delivery', 'buyer_message', competitorAt + int(1, 2) * DAY + int(0, 2) * 60, {
      text: `Can you deliver ${tonnes} t of ${length} m piles within ${weeks} weeks of the order? Please confirm the delivery plan.`,
    }),
    ev('decision', 'buyer_message', persona.decideAt, null), // the buyer decides when this event is delivered
  ];
  if (r() < 0.5) events.push(ev('opened', 'quote_opened', competitorAt + DAY + 120, { text: 'The buyer opened your quote page again.' }));
  if (r() < 0.5) events.push(ev('reminder', 'buyer_message', (decideDay - 2) * DAY + 600, { text: `A reminder: we decide on day ${decideDay}.` }));
  events.sort((a, b) => toMin(a.at) - toMin(b.at));
  events.forEach((e, k) => (e.id = `ev-${k + 1}`));
  return {
    id: `a${i}`,
    seed,
    persona,
    events,
    followUp: [persona.followAt, persona.followAt + 120],
    // --fake-agent: odd agents keep every promise and win, even agents miss the follow-up and quote below the floor.
    fakeRole: i % 2 ? 'good' : 'bad',
  };
}

// The buyer's fixed rule, read from structured ledger rows only. `factorAt(t)` is the price factor at time t.
export function buyerDecides(persona, followUp, allRows, factorAt) {
  const D = persona.decideAt;
  const rows = allRows.filter((r) => toMin(r.at) <= D);
  const quotes = new Map(rows.filter((r) => r.type === 'quote_create').map((r) => [r.id, r]));
  const fits = (q) =>
    q &&
    modulus(q.section) >= persona.need &&
    q.length === persona.length &&
    q.tonnes >= persona.tonnes &&
    q.price <= persona.budget &&
    q.price >= floorPrice(q.section, q.length, factorAt(toMin(q.at))) &&
    toMin(q.valid_until) >= D;
  const sent = rows.filter((r) => r.type === 'quote_send').map((r) => quotes.get(r.id));
  const fitting = sent.filter(fits).sort((a, b) => a.price - b.price);
  const reasons = [];
  if (!fitting.length) reasons.push(sent.length ? 'no sent quote fits the need, budget, floor and deadline' : 'no quote sent');
  const broken = brokenPromises(rows, D);
  if (broken.length) reasons.push(`broken promises: ${broken.join(', ')}`);
  if (!followedUp(rows, followUp)) reasons.push('no follow-up in the window the buyer asked for');
  return reasons.length
    ? { decision: 'loss', quote: null, reasons, text: 'We have decided to go with another supplier.' }
    : { decision: 'order', quote: fitting[0].id, reasons, text: `We place the order for quote ${fitting[0].id}. Please confirm the rolling date.` };
}

// --fake-agent for the heavy scenario: plain rules on the delivered events, sent through the same bash tool as Pi.
function heavyFake(agent, state, n, due, wake, now) {
  const P = agent.persona;
  const good = agent.fakeRole === 'good';
  const cmds = [];
  for (const e of due) if (e.type === 'price_change') state.factor = e.meta.factor;
  const factor = state.factor ?? 100;
  state.quotes ??= 0;
  state.promises ??= 0;
  const quote = (price) => [
    `company quote create --section ${P.section} --length ${P.length} --tonnes ${P.tonnes} --price ${price} --valid-until +14d`,
    `company quote send --id Q-${++state.quotes}`,
  ];
  const say = (text) => `company message send --to buyer --text ${arg(text)}`;
  for (const e of due) {
    if (e.kind === 'rfq' && good) {
      const price = listPrice(P.section, P.length, factor);
      cmds.push('company catalog search --q Z-', `company price get --section ${P.section} --length ${P.length}`, ...quote(price),
        say(`Our quote Q-${state.quotes}: ${P.tonnes} t of ${P.section}, ${P.length} m, at ${price} EUR/t.`));
    } else if (e.kind === 'rfq') {
      // Below the floor: the company refuses it, so no quote id is used.
      cmds.push(`company price get --section ${P.section} --length ${P.length}`,
        `company quote create --section ${P.section} --length ${P.length} --tonnes ${P.tonnes} --price ${floorPrice(P.section, P.length, factor) - 10} --valid-until +14d`,
        say('We will send our quote soon.'));
    } else if (e.kind === 'ask') {
      state.follow = `P-${++state.promises}`;
      cmds.push(`company promise add --due ${arg(fmt(P.followAt))} --text ${arg('Follow up with the buyer')}`,
        say(`Thank you. I will follow up on ${fmt(P.followAt)}.`));
    } else if (e.kind === 'competitor' && good) {
      const price = Math.max(floorPrice(P.section, P.length, factor) + 1, Math.min(P.budget, P.competitor) - 2);
      cmds.push(`company price get --section ${P.section} --length ${P.length}`, ...quote(price),
        say(`Revised quote Q-${state.quotes} at ${price} EUR/t.`));
    } else if (e.kind === 'competitor') {
      cmds.push(`company quote create --section ${P.section} --length ${P.length} --tonnes ${P.tonnes} --price ${floorPrice(P.section, P.length, factor) - 5} --valid-until +14d`,
        say('We cannot match that price.'));
    } else if (e.kind === 'delivery' && good) {
      const id = `P-${++state.promises}`;
      cmds.push(`company promise add --due ${arg(fmt(now + 240))} --text ${arg('Confirm the delivery plan in writing')}`,
        say(`Yes: ${P.tonnes} t of ${P.length} m piles within ${P.weeks} weeks of the order, in two deliveries.`),
        `company promise resolve --id ${id}`);
    } else if (e.kind === 'delivery') {
      cmds.push(say('Delivery should be fine.'));
    } else if (e.kind === 'decision') {
      cmds.push(`company note --text ${arg(`Buyer decision: ${e.payload.text}`)}`, say('Thank you for your answer.'));
    } else {
      cmds.push(`company note --text ${arg(`${e.type}: ${e.payload.text}`)}`);
    }
  }
  if (good && state.follow && !state.followDone && now >= P.followAt) {
    state.followDone = true;
    cmds.push(say('Following up as promised: does the quote fit your wall?'), `company promise resolve --id ${state.follow}`, 'company promise list');
  }
  cmds.push(`echo ${arg(`- ${fmt(now)}: period ${n}, handled ${due.map((e) => e.id).join(' ') || wake.reason}`)} >> progress.md`);
  if (good && state.follow && !state.followDone) {
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
