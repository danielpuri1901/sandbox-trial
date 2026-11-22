# Sandbox trial

This repository compares sandbox providers as the home of a long-lived, event-driven AI agent.
It has two tests.
The sleep-wake test times one sleep and one wake on each provider.
The agent lifecycle test runs a small copy of the agent-fleet actor loop on each provider for several simulated days.
Every number in the result files is measured by these scripts.

## Providers

`providers.mjs` holds one adapter for each provider.
Each adapter can create a sandbox, run a shell script, sleep, wake and destroy.
Both tests use the same adapters, so every provider runs the same steps.

| Provider | Sleep | Wake |
|---|---|---|
| E2B | `pause()`, which keeps memory and disk | `connect()` |
| Daytona | `stop()` on the v0 API, which keeps the disk only | `start()` |
| Sprites | No SDK call: the test waits 45 s without commands, so the sandbox pauses itself | The next command |
| Baseten | No SDK call: the test waits 45 s without requests (standby cannot be seen in the API) | The next command |
| Modal | A memory and disk snapshot, then `terminate()` | A new sandbox from the snapshot |
| Vercel | `stop()` on a persistent sandbox | `Sandbox.get({ resume: true })` |

The Vercel adapter exists, but our runs skip it because the keys are not set.

## Setup

You need Node 24.
Run `npm install --ignore-scripts`.
Put the provider keys in `.env`.
`.env.example` lists the names.
The `.env` file is ignored by git.
Never commit it.

## Sleep-wake test

`sleep-wake-test.mjs` runs six timed steps on each provider: create, write, sleep, wake, verify and destroy.
The write step saves a random token to a file and starts a background process.
After the wake, the verify step checks two things.

- `file_ok`: the token file is still there and holds the same token.
- `ram_kept`: the background process is still alive, so memory survived the sleep.

Run it:

```sh
node --env-file=.env sleep-wake-test.mjs <e2b|daytona|sprites|baseten|modal|vercel|all>
```

Each run adds one line to `results.jsonl` for each provider that ran.

## Agent lifecycle test

`agent-lifecycle-test.mjs` checks if the sandbox disk can be the home of an agent that sleeps and wakes for days.
It copies the shape of agent-fleet slice 1.

- The brain runs on this computer.
  Each awake period starts one fresh Pi session (the agent-fleet harness, version 0.85.1).
- The hands run in the sandbox.
  Pi's own read, write, edit and bash tools send every operation to the sandbox.
- The agent home lives on the sandbox disk, in `~/agent`.
  In agent-fleet this home is copied to S3.
  Here the sandbox disk is the only copy.
- The agent talks to the company only through `company`, a shell script in `~/bin`.
  Every call writes one row to `~/agent/ledger.jsonl`, stamped with the simulated time.
- The test script plays the rest of agent-fleet: the inbox, the wake rule, the orphan rule and the buyer.

### One awake period

1. The test wakes the sandbox, or creates it for the first period.
2. It writes the simulated time to `~/agent/clock` and reads a hash of the ledger.
3. Pi gets the agent contract as its system prompt and the pending events as its first prompt.
4. The agent works until it runs `company sleep --until <time> --on <event types> --task <text>`.
5. The test reads `sleep.json` and the ledger, then puts the sandbox to sleep with the provider's sleep call.

The agent wakes at its alarm time, or earlier for an event type it listed in `--on`.
A `buyer_message` always wakes it.
Other events wait in the inbox until the next wake.
If a period ends without `company sleep`, the test counts an orphan and wakes the agent one simulated day later.

The simulated clock jumps from one wake to the next.
Between two periods the test pauses in real time, so that providers that sleep when idle really go idle.
The pause starts when the awake period ends and includes the sleep call.
It is the simulated gap scaled down, and never shorter than 45 s.

### Scenarios

`basic` is the default.
It has one agent and 3 simulated days, and 1 simulated day takes 2 real minutes.
The buyer asks for a follow-up at day 1 10:00 and sends drawings on day 2.

`heavy` has 5 agents for each provider by default, and 14 simulated days.
1 simulated day takes 1 real minute.
Each agent has its own sandbox, and all agents of one provider run at the same time.
Each agent gets its own buyer from a seed (agent N uses `--seed` times 1000 plus N, and `--seed` is 1 by default), so every provider gets the same buyers.
Each buyer comes from a real UK notice in `notices.json` (see Real notices below): the buyer organisation, the project title, the place, the value and the deadline.
The wall data (bending moment and pile length) is seeded, because notices do not give it.
The tonnage comes from the notice value when there is one.
Each buyer sends 7 to 9 events:

- a request for a quote, with the wall bending moment, pile length, tonnage and delivery time,
- a message that the buyer is busy, with a time when the agent must follow up (the buyer stays quiet until then),
- `quote_opened`, which does not wake the agent unless it asks for it,
- `price_change` from the company, which never wakes the agent and raises the list prices from the moment it is delivered,
- a competitor's price,
- a question about the delivery date,
- the decision, sometimes with an extra reminder or an extra `quote_opened` before it.

The buyer has a hidden need: the smallest section modulus that passes the statics rule and the drivability rule, the pile length, the tonnage, a budget in EUR/t and a decision day.
The buyer decides by a fixed rule, from ledger rows only.
It orders when all of these are true at the decision time:

- the agent sent a quote whose section, length, tonnage and validity fit the need,
- the quote price is within the budget and not below the floor,
- every promise due by then was resolved by its due time,
- the agent sent a message in the follow-up window the buyer asked for.

Otherwise the buyer goes to another supplier.
By default the buyer's messages are fixed templates.
With `--buyer-text llm`, a model writes them (see Noise below), but the same rule still decides.

### The company command

| Command | What it does |
|---|---|
| `message send --to buyer --text [--re]` | Sends a message to the buyer, and `--re` names the event it answers. |
| `catalog search --q` | Lists the sections that match the text (heavy scenario only). |
| `price get --section --length` | Gives the list price in EUR/t (heavy scenario only). |
| `quote create --section --length --tonnes --price --valid-until` | Creates a quote, or refuses a price below the floor with exit code 3 and a `quote_rejected` row (heavy scenario only). |
| `quote send --id [--re]` | Sends a quote to the buyer (heavy scenario only). |
| `promise add --due --text` | Records a promise and returns its id. |
| `promise list` | Shows the open promises. |
| `promise resolve --id` | Marks a promise as kept. |
| `note --text` | Writes a note to the ledger. |
| `sleep --until --on --task` | Ends the awake period. |

The floor is 85% of the list price.
No command prints it.
A wrong argument exits with code 2 and writes a `usage_error` row.
With noise on, any call can fail for a moment with exit code 75 and a `transient_failure` row.
In the heavy scenario, and in any run with noise on, the test adds an `event_received` row to the ledger for each event it delivers, so the agent can see which event ids it already got.

### Run it

```sh
# Pi with a model, basic scenario
node --env-file=.env agent-lifecycle-test.mjs <provider|all> [--model <id>]

# Heavy scenario
node --env-file=.env agent-lifecycle-test.mjs all --scenario heavy [--agents N] [--model <id>]

# No model calls: a fake agent sends fixed company calls through the same tool path
node --env-file=.env agent-lifecycle-test.mjs all --scenario heavy --fake-agent

# Real-life noise, replayable with the same seed
node --env-file=.env agent-lifecycle-test.mjs all --scenario heavy --noise heavy --seed 7 [--buyer-text llm]

# Daniel as the buyer, in a terminal
node --env-file=.env agent-lifecycle-test.mjs e2b --scenario heavy --human-buyer
```

Pi mode and `--buyer-text llm` need the model key in `ANTHROPIC_SECRET`.
The value can be a raw key or JSON.
For JSON the test takes the field `aws-inference`, or else the first string value.
`--model` takes any model in `model-prices.json`.
The default is `claude-haiku-5-5`.

With `--fake-agent` in the heavy scenario, odd agents keep every promise and win the order.
Even agents miss the follow-up and offer prices below the floor, so they lose.
With noise on, the even agents also answer a repeated event a second time and keep writing to a buyer who cancelled.
This shows the heavy checks both passing and failing without a model.

### Output

The test adds rows to `lifecycle-results.jsonl`.
There is one row for each awake period, one summary row for each agent (`"summary": "agent"`) and one summary row for each provider (`"summary": "provider"`).
Older rows from before the heavy scenario have `"summary": true` and no `scenario` field.

Each period row has these measures:

- `wake_ms`: from the wake call (or the create call in period 1) until the first command in the sandbox returns,
- `period_ms`: from that point until the end of the awake period, without the sleep call,
- `sleep_ms`: the provider's sleep call,
- `wake_retries`: wake attempts that failed and were retried,
- `faults`: every fault that fired in the period (see Noise),
- `save_ms` and `recovery_ms`: the home copy after the period, and the time to bring the agent back after a sandbox kill,
- `buyer_messages`: the text the buyer model wrote, with `--buyer-text llm`,
- `tool_calls`, `tool_errors` and `tool_rtt_median_ms`: the agent's tool calls, the ones that failed, and the median time of one call,
- `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_write`, `tokens_total` and `cost_usd`, as Pi reports them,
- `home_bytes`: the total size of the files in `~/agent` at the end of the period,
- `home_intact`: true when the ledger after the wake has the same SHA-256 hash as before the sleep,
- `orphan`: true when the period ended without `company sleep`,
- `cap`: which limit ended the period, if one did.

Every row also names the commit of the test code (`code`), the noise level, the run seed and the buyer (template, model or human).
The test prints one table with a row for each provider.

### Checks

| Check | Meaning |
|---|---|
| `promise_kept` | The agent sent a message in the follow-up window: day 1 10:00 to 12:00 in basic, the time the buyer asked for plus 2 hours in heavy. |
| `promises_kept` | Every promise due by the last awake period was resolved by its due time (heavy only). |
| `order_won` | The buyer ordered (heavy only). |
| `quotes_rejected` | The number of quotes the company refused because the price was below the floor (heavy only). |
| `orphans` | The number of awake periods that ended without `company sleep`. |
| `events_once` | Every event reached the agent at least once and was marked handled once. |
| `no_double_action` | The agent never sent two messages or two quotes with `--re` for the same event id (heavy only). |
| `no_message_after_cancel` | After the buyer cancelled the project, the agent sent no message in a later period (only for the cancelled project). |
| `home_intact_all` | The ledger survived every sleep. |
| `recovered_after_kill` | After the sandbox was killed, the agent came back in a new sandbox from the home copy with no ledger row lost. |

The provider summary counts the agents that passed each check.
`agents_ok` counts the agents that finished the scenario with no error and no limit stop.

### Limits that stop a run

- 100 tool calls in one awake period.
- 300,000 tokens in one awake period.
- 2,000,000 tokens for one provider, shared by all its agents.
- 6 awake periods in basic and 20 in heavy.
- 100,000 buyer model tokens for the whole run, with `--buyer-text llm`.
  After that the buyer falls back to the templates.

## Noise

Real life is messy, so the heavy scenario can add faults on purpose with `--noise light` or `--noise heavy` (the default is `off`).
Every fault comes from `--seed`, so a bad run replays exactly.
Each period row lists the faults that fired.
The noise is built for the heavy scenario; with the basic scenario the fake agent's fixed script no longer fits.

### Infra noise (chaos engineering)

| Fault | light | heavy |
|---|---|---|
| A company call fails for a moment with exit code 75 | 2% of calls | 8% of calls |
| `price get` answers a simulated 429 or 500 | 5% | 15% |
| The first wake attempt fails, and the test retries with backoff (2 s, 4 s, 8 s), as the agent-fleet sweeper pokes again | 5% of wakes | 15% of wakes |
| An event arrives a second time with the same id | 5% of events | 15% of events |
| An event arrives up to 1 simulated day late, so events can overtake each other | none | 30% of events |
| The sandbox is killed between two periods, once for each agent | none | yes |

With noise on, the test saves a copy of `~/agent` to this computer after every period, in the git-ignored folder `homes/`.
This is the role of the S3 copy in agent-fleet.
After a kill, the next period creates a new sandbox, installs the company side again and restores the home from that copy.

### World noise

- light and heavy: a silent stock change and a competitor who lowers the price again.
- heavy also: a duplicate tender notice, a project update from a later notice, a late delivery after an order, and one cancelled project in the run (a forced loss that is not the agent's fault).

### People noise

With `--buyer-text llm`, Claude Haiku 5.5 writes each buyer message from the template facts, the agent's last message and a seeded style.
The styles are vague, typos, a contradiction, a change of mind, a second contact person and an angry tone.
Each buyer also sends 1 or 2 noise emails: an out-of-office reply, an irrelevant email or a message sent to the wrong address.
The buyer model never sees the floor or the budget.
Its tokens and cost are counted apart from the agent's.

### Human buyer

`--human-buyer` runs one agent with Daniel as the buyer.
The test shows each message the agent sends and waits for a typed reply.
An empty line means silence.
At the end the test asks for order or loss, and that answer decides the deal.
The fixed rule's decision is kept next to it for comparison.
The results have `"buyer": "human"`.

## Real notices

`fetch-notices.mjs` fetches real UK notices from the Find a Tender OCDS API and saves `notices.json`.
It keeps projects whose CPV code starts with 45241, 45243, 45244, 45246, 45247 or 452622 (harbour, coastal, marine, river and flood works, dams and canals, and piling).
It waits at least 1 second between requests and slows down when the API answers 429.
It keeps only organisation-level facts: buyer organisation, title, value, deadline, place and CPV codes.
It drops every contact point and street address, and cuts email addresses and phone numbers out of the text it keeps.
A later release of the same project becomes a project update event.
Contains public sector information licensed under the Open Government Licence v3.0.

## Known limits

- Pi runs on this computer, so every tool call travels to the provider's API and back.
  In agent-fleet the agent runs inside the sandbox, so its tool calls are local.
  The tool times here measure the remote path.
- The agent can read `~/bin/company` and find the floor rule.
  It can also write to the ledger directly.
  The contract forbids both, but nothing stops it.
  The buyer checks the floor again from the price history, but it does not detect a forged row.
- The real pause between periods is about 1 to 2 minutes for one simulated day.
  The test does not show what a provider does after hours or days of idle time.
- Sprites and Baseten have no sleep call.
  On Baseten, the test cannot see if the sandbox really went to standby.
- One sandbox command can carry about 70 KB.
  A larger file write fails.
- E2B and Modal sandboxes are created with a 1 hour lifetime, and Baseten deletes a sandbox after 1 hour.
  A run must end within that time.
- The buyer is a fixed rule.
  It does not negotiate or react beyond its schedule and its decision, even when a model writes its messages.
- The buyer model can still change a fact in a message, although it is told not to.
  The rule decides from the hidden need, not from the text.
- `no_double_action` sees only replies that name their event with `--re`.
  An agent that answers a repeated event without `--re` is not caught.
- The fake agent knows the buyer's hidden need.
  It tests the harness, not the skill of an agent.
- All timings come from one computer and one network location.
