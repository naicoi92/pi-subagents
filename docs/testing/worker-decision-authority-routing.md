# Worker decision authority routing delta — pre-code acceptance matrix

Base: `4bdc08783401969db94d8a46543d31840f23202b`. Scope: public in-process registry/types, tests and documentation only. Native foreground/background wiring, lifecycle event integration, classifier/Jev/UI, detached transport and provider execution are not implemented or proven here.

| Criterion | Requirement | Test IDs | Independent expected source |
| --- | --- | --- | --- |
| ROUTE-01 | Session snapshot distinguishes never-owned, active, missing and disposed; immutable metadata only | R01-states | Literal registered generation, lifetime 10000 and assessment timeout 250; no callback or task in snapshot |
| ROUTE-02 | Explicit finite nonnegative registration assessment timeout; caller cannot extend owner budget | R02-invalid, R02-budget, R02-zero | Required registration field; cutoff min(admission + owner timeout, admission + caller timeout, hard deadline - 500); zero permits live owner fallback |
| ROUTE-03 | Snapshot then replacement/disposal cannot authorize stale preparation | R03-race | Existing generation fence; no assessment or notification for stale request |
| ROUTE-04 | Matching nonterminal invalidation aborts pending work, retains consumed identity and permits re-registration | R04-pending, R04-committed, R04-indeterminate | One assessment per logical ID; retained committed pair revalidated without second assessment/notification |
| ROUTE-05 | Stale invalidator cannot kill replacement | R05-stale | Matching generation only; replacement stays active and can prepare new work |
| ROUTE-06 | New APIs validate IDs, preserve caps and never allocate absent sessions | R06-capacity, R06-id | Existing literal caps: 256 sessions, 256 entries/session, 4096 entries total, 256 UTF-8 bytes/ID; isolated capacity fixture |

`test/unit/worker-decision-authority-routing.test.ts` owns routing assertions; existing core/capacity fixtures receive explicit registration budgets. Budget regressions run against existing exports before source changes (behavioral RED). New-export tests are separately identified as missing-API RED, not native-wiring evidence.

Registration budget is authoritative. Existing preparation `classifierTimeoutMs` remains a finite nonnegative per-request tightening cap, never an alternate default. Host callers can later use active snapshot timeout as this cap. Snapshot is fencing metadata, not proof owner is live; preparation rechecks owner, deadline and generation. Nonterminal invalidation never resets ledger or terminal tombstone. Snapshot/invalidator read misses consume no retained-session slot.

Verification: targeted Node unit tests using deterministic clocks/local callbacks; relevant core/model/thinking/launch-contract neighbor tests only; source and focused fixture TypeScript checks; diff/lock/staging checks. No full suite, native children, model inference or deployment. Independent review required before native integration.
