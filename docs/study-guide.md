# Study guide: sandbox trial

One topic.
It explains what the trial found, for a short video.

| Topic | What to study | Where it appears |
|---|---|---|
| **1. Where should a long-running agent sleep?** | Why a long-lived, event-driven agent needs a home that sleeps cheap, wakes fast and never loses its files. The three tests: sleep and wake on five sandbox clouds, a small copy of the agent-fleet loop, and 14 simulated days with injected faults and sandbox kills. The results: all five kept the files, three kept memory, every killed sandbox got its files back from an outside copy, and the model cost about 40 times more than the sandboxes. The takeaway: for an agent whose memory is files, a fast wake and an outside copy of the files matter more than keeping memory. The limits: one run, one seed, short sleeps. | [docs/write-up.md](write-up.md), [README.md](../README.md) |
