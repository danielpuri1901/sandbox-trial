# Where should a long-running agent sleep?

Draft of the post for danielpuri.com, November 2026.

I tested five sandbox clouds as the home of an agent that sleeps between events for weeks.
All five kept its files.
Three kept its memory.
The model cost about 40 times more than the sandboxes.

I am building agent-fleet, a copy of an architecture Kavak described on a podcast: one sales agent per customer, each in its own microVM.
The agent does not run all the time.
It wakes on an event, such as a buyer's message or its own alarm, works for a few minutes, picks its next wake time and goes back to sleep.
A relationship can last months.

So the agent needs a home that sleeps cheap, wakes fast and never loses its files.
I run agent-fleet on AWS AgentCore, which throws the microVM away at every sleep and copies the agent's files back from S3 at the next wake.
Several newer sandbox clouds can pause a microVM instead.
I wanted to know if that is better for agents like mine.

I tested E2B, Daytona, Fly Sprites, Modal and Baseten, all on free credits.
Azure would not give me a second free trial, and Google's trial credit does not cover its agent sandboxes, so both are missing.

## Test 1: sleep and wake

One script does the same six steps on every provider.
It creates a sandbox, writes a file, starts a background process, puts the sandbox to sleep, wakes it, and checks if the file and the process survived.
I ran it five times per provider.

| Provider | Wake, median | Memory kept |
|---|---|---|
| Fly Sprites | 0.16 s | 5 of 5 |
| Baseten | 0.35 s | 5 of 5 |
| E2B | 0.54 s | 5 of 5 |
| Modal | 0.67 s | 0 of 5 |
| Daytona | 0.85 s | 0 of 5 |

The file survived every time.
"Sleep" means a different thing on each provider.
E2B has a real pause call.
Sprites and Baseten have no sleep call at all: they pause themselves when nothing talks to them, so I waited 45 seconds.
Daytona refused to pause its default container sandbox, so I used stop and start.
Modal only gave me a memory snapshot that restores into a new sandbox, and the background process did not come back.
For comparison, agent-fleet's own numbers on AgentCore: a cold wake takes about 1.4 seconds, the files come back from S3 in 60 milliseconds, and memory is never kept.

## Test 2: a small copy of the agent

Sleep and wake numbers say nothing about an agent.
So I copied the agent-fleet loop into a small test.
The agent runs on the Pi harness with Claude Opus 5.5.
Its tools run inside the sandbox, and its memory is a set of files on the sandbox disk: a contract, a goal, tasks, progress notes and an append-only ledger.
A small `company` command lets it message the buyer, add a promise and go to sleep:

```bash
company sleep --until "day 1 10:00" --on buyer_message --task "Follow up if no drawings"
```

A script on my laptop plays the rest of the world.
It holds the agent's inbox and wakes the sandbox when an event matches what the agent asked for, or when its alarm time passes.
Every wake starts a fresh model session, so the files are the only memory.

In the first scenario a buyer asks for a quote and says "follow up on day 1 if you have not heard from us".
On day 1 nothing happens, so the agent has to wake from its own alarm.
All five providers passed: promise kept, no agent asleep without an alarm, every event handled once, and every file intact after every wake.
The surprise was tool calls.
One takes 61 to 73 milliseconds on Daytona and 216 to 352 on the others.
An agent makes a lot of them, so that adds up.

## Test 3: real-life noise

That scenario was too easy: two tool calls per wake.
The real world is messy, so I made a harder one.
Five agents per provider, 14 simulated days, each selling to a buyer built from a real UK public tender notice.
A small model writes the buyer's messages, with typos, vague answers, out-of-office replies and changes of mind.
A fixed rule decides if the buyer orders, so the outcome depends on what the agent did, not on the buyer model's mood.

On top of that I injected faults with a fixed seed, so every provider got the same bad luck.
Commands fail at random.
Events arrive twice, late, or out of order.
Prices change silently.
One project is cancelled.
Wakes fail and must be retried.
And once per agent, I destroyed its sandbox between two wakes.
The test then restores the agent's files from a copy on my laptop into a new sandbox, like agent-fleet does from S3.

| Provider | Agents that finished | Wake, median | Back after a kill |
|---|---|---|---|
| Fly Sprites | 5 of 5 | 0.22 s | 1.8 to 5.2 s |
| Baseten | 5 of 5 | 0.31 s | 3.8 to 6.8 s |
| E2B | 5 of 5 | 0.70 s | 1.9 to 5.1 s |
| Modal | 5 of 5 | 1.08 s | 2.8 to 6.6 s |
| Daytona | 4 of 5 | 1.10 s | 0.9 to 4.6 s |

Every one of the 25 agents got its files back after its sandbox was killed, with no ledger row lost.
No agent answered a duplicated event twice, slept without an alarm, quoted below the hidden price floor, or kept writing to the cancelled buyer.
I also blocked the agents from reading the file that holds the floor, and none tried.
One Daytona agent stopped on day 7 when an SDK call timed out.
That is a gap in my test, not in Daytona: agent-fleet would simply wake the agent again.

Orders ranged from 1 of 5 to 4 of 5 per provider.
With five agents each, that is model randomness, not a difference between providers.
The whole run cost $12.15 in model tokens.
The sandboxes used about $0.30 of free credits across all three tests.

## What I think

For an agent whose memory is files, keeping memory across a sleep does not matter much.
What matters is a fast wake and files that never get lost.
A killed sandbox takes its disk with it, so the files need a copy outside the sandbox.
The provider's disk alone is not durability.
That is why agent-fleet saves every wake to S3, and why I am staying on AgentCore for now.

If I needed a process to keep running across a sleep, I would pick E2B for its explicit pause, or Sprites or Baseten if I can live with them deciding when to sleep.
Whatever you pick, the model bill will dwarf the sandbox bill.

## What I got wrong

- My first Sprites measurement said "asleep" 170 milliseconds after the last command while the background process was still running.
It measured nothing.
Waiting out the idle window fixed it.
- Two test runs started in the same millisecond and shared their file backups.
On Modal, an agent got the other run's files back after a kill and lost ledger rows.
The backup layer is where durability bugs hide.
- I guessed the big run would cost $5 to $10, then $35.
It cost $12.

Limits: one run with one seed, five agents per provider, from one laptop.
The sleeps were 45 seconds to a few minutes, not days, so I have not tested how long each provider keeps a sleeping sandbox.
Baseten deletes sandboxes after 7 days by default, and Modal keeps memory snapshots for 7 days.
