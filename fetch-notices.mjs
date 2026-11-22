// Fetches real UK notices for marine, river and piling works from the Find a Tender OCDS API and saves a small
// fixture (notices.json) that the heavy scenario uses for its buyers. No person's name, email or phone is kept.
// Usage: node fetch-notices.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--max-pages N]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
// Harbour, coastal defence, marine, river regulation and flood control, dams and canals, piling.
const CPV_PREFIXES = ['45241', '45243', '45244', '45246', '45247', '452622'];
// The API takes one stage for each query. Each stage can add projects; a later release of a project already kept
// becomes its update event.
const STAGES = ['tender', 'planning', 'award'];
const WANT = 50;
const LICENCE = 'Contains public sector information licensed under the Open Government Licence v3.0.';

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: new Date(Date.now() - 2 * 365 * 86_400_000).toISOString().slice(0, 10) },
    to: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    'max-pages': { type: 'string', default: '150' },
  },
});
const maxPages = Number(values['max-pages']);

// Free text can carry contact details, so emails and phone numbers are cut out of every kept string.
const scrub = (s) =>
  typeof s === 'string'
    ? s
        .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email removed]')
        .replace(/\+?\d[\d ()-]{8,}\d/g, '[number removed]')
        .replace(/\s+/g, ' ')
        .trim()
    : null;
const cpvsOf = (r) =>
  [
    r.tender?.classification?.id,
    ...(r.tender?.items ?? []).flatMap((i) => [i.classification?.id, ...(i.additionalClassifications ?? []).map((a) => a.id)]),
  ].filter(Boolean);
const inScope = (c) => CPV_PREFIXES.some((p) => c.startsWith(p));
// The main CPV code must be in scope, or one of at most 25 codes: long lists name every kind of works, so a notice
// with one piling code among 80 others is usually not about piling.
const MAX_CODES = 25;
const matches = (r) => {
  const cpvs = cpvsOf(r);
  return inScope(cpvs[0] ?? '') || (cpvs.length <= MAX_CODES && cpvs.some(inScope));
};

// Only organisation-level facts are kept: no contact point, no street address, no person.
function compact(r) {
  const buyer = (r.parties ?? []).find((p) => p.roles?.includes('buyer'));
  const value = r.tender?.value ?? r.tender?.lots?.find((l) => l.value)?.value ?? r.awards?.find((a) => a.value)?.value;
  const delivery = r.tender?.items?.find((i) => i.deliveryLocation || i.deliveryAddresses?.length);
  return {
    release_id: r.id,
    date: r.date,
    tag: r.tag,
    buyer: scrub(r.buyer?.name ?? buyer?.name),
    title: scrub(r.tender?.title),
    value: value?.amount ? { amount: value.amount, currency: value.currency } : null,
    deadline: r.tender?.tenderPeriod?.endDate ?? null,
    locality: scrub(buyer?.address?.locality) ?? null,
    region: delivery?.deliveryAddresses?.[0]?.region ?? buyer?.address?.region ?? null,
    location: scrub(delivery?.deliveryLocation?.description),
    cpv: [...new Set(cpvsOf(r))],
  };
}

// Saved after every page, so a stopped run still leaves a fixture.
function save() {
  const notices = [...byOcid].map(([ocid, releases]) => ({ ocid, releases: releases.sort((a, b) => a.date.localeCompare(b.date)) }));
  writeFileSync(
    new URL('./notices.json', import.meta.url),
    `${JSON.stringify(
      {
        licence: LICENCE,
        source: API,
        fetched_at: new Date().toISOString(),
        query: { from: values.from, to: values.to, stages: STAGES, cpv_prefixes: CPV_PREFIXES, max_codes: MAX_CODES, pages },
        notices,
      },
      null,
      1,
    )}\n`,
  );
  return notices;
}

const byOcid = new Map();
let pages = 0;
for (const stage of STAGES) {
  let url = `${API}?${new URLSearchParams({ stages: stage, limit: '100', updatedFrom: `${values.from}T00:00:00`, updatedTo: `${values.to}T00:00:00` })}`;
  while (url && pages < maxPages && byOcid.size < WANT) {
    let res;
    // The API answers 429 when asked too often: wait as told (or 30 s, doubling), then ask again.
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, { headers: { 'User-Agent': 'sandbox-trial/0.1', Accept: 'application/json' } });
      if (res.status !== 429 || attempt === 5) break;
      const wait = Number(res.headers.get('retry-after')) * 1000 || 30_000 * 2 ** attempt;
      console.log(`429 Too Many Requests, waiting ${Math.round(wait / 1000)} s`);
      await delay(wait);
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    const pkg = await res.json();
    pages++;
    for (const r of pkg.releases ?? []) {
      if (!matches(r)) continue;
      const list = byOcid.get(r.ocid) ?? [];
      if (!list.some((x) => x.release_id === r.id)) list.push(compact(r));
      byOcid.set(r.ocid, list);
    }
    save();
    console.log(`${stage} page ${pages}: ${pkg.releases?.length ?? 0} releases, ${byOcid.size} matching projects`);
    url = pkg.links?.next ?? null;
    await delay(2000); // at least 1 second between requests; 2 s keeps clear of the rate limit
  }
}

const notices = save();
console.log(`saved ${notices.length} projects (${notices.filter((n) => n.releases.length > 1).length} with a later release) to notices.json`);
