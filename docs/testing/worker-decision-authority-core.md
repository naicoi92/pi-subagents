# Worker decision authority: API-core acceptance matrix

## Scope and authority

Pre-test matrix, recorded before tests or implementation. Sources: approved API-core task, parent `implementation-plan.md` CORE-01–07, `api-contract.md` (deadline correction included), `spec.md` WA-05/06/15/18/20/21. This is one coupled public registration/preparation contract, not native launch coverage.

Seam: `pi-subagents/worker-decision-authority`: session registration, asynchronous leaf preparation, safe consumed/committed state inspection, session disposal. Trusted host supplies target resolution, final admission/revision validation and clock. Owner supplies every selected or retained pair. No classifier, executor fallback selection, private host settings, transport, native foreground/background wiring, Jev rubric or UI.

| Criterion | Test IDs | Observable acceptance | Independent expected source |
| --- | --- | --- | --- |
| CORE-01 | C01-duplicate, C01-dispose, C01-missing, C01-session | One session owner; duplicate conflict; old dispose cannot remove replacement; never-owned explicit `unowned`; disposed session blocks | Approved optional registration and identity-checked disposal contract |
| CORE-02 | C02-pair, C02-reject, C02-resolve, C02-revision, C02-notify, C02-ceiling, C02-support, C02-closed-context, C02-notify-dispose | Complete pair passes trusted validator before logical commit; scope rejection blocks; resolve-target is host-owned; current revisions checked; applied notification after commit at most once | Literal `provider/target:medium`, trusted scope-denied fixture, no inferred pair |
| CORE-03 | C03-projection | Callback receives separate facts/private policy context; allowlisted facts projection preserves actual role/capabilities/task, drops extra configured thinking/routing fields | Exact literal task and factual role description; configured high and baseline low absent from projected facts |
| CORE-04 | C04-stale, C04-cancel, C04-deadline, C04-owner, C04-pending-deadline, C04-cancel-duplicate, C04-cancel-pending-duplicate, C04-cancel-joining, C04-owner-lifetime, C04-invalid-deadline | Generation, cancellation, session lifetime and finite hard deadline fence pending work and commitment, including hung callbacks | Typed blocked outcomes; zero applied receipts after invalid authority; deterministic clock |
| CORE-05 | C05-pending, C05-repeat, C05-attempt, C05-binding, C05-consumed, C05-generation | Claim precedes callback; duplicates join/reuse; runtime attempt does not reclassify; changed binding/revisions/generation cannot reset consumption; indeterminate stays consumed | One callback and one receipt per stable logical ID; consumed state readable without task content |
| CORE-06 | C06-cutoff, C06-exhausted, C06-late-validation, C06-no-assessment, C06-admission | Classifier cutoff distinct from hard deadline; live owner explicitly retains verified original pair in reserve; exhausted budget rejects; no assessment time still permits owner fallback | At admission 1000, hard deadline 3000, timeout 1000: cutoff 2000; original `provider/original:low` committed before 3000; reserve 500 ms |
| CORE-07 | C07-missing, C07-unknown, C07-model, C07-reason, C07-null, C07-null-thinking, C07-missing-model | Incomplete/invalid reply rejected without synthesizing role high or effort; safe typed reasons only | Missing/null/unknown thinking is invalid, literal medium independent of role high; no raw task/provider error in outcomes |

Tests use Node's test runner with deterministic fake clock/timer callbacks, no sleeps, inference or native workers. RED first checks missing public module; subsequent slices target public behavioral outcomes. Validation commands and raw exits are recorded in external implementation artifact, not asserted here in advance.

## Deferred evidence

All seven CORE criteria are testable at this seam. Native exact-envelope/fork/runtime/workflow/nested coverage, cross-process cancellation/transport, crash-durable consumed ledger and termination/lease proof remain follow-on integration work. An in-memory logical commitment is not provider execution proof or durable exactly-once inference. A new runtime attempt may reuse commitment only after integration proves existing termination/lease conditions; this API never spawns or authorizes that recovery itself.

## Review correction matrix (before regression tests)

Source: exact-head BLOCK review of `8ac9492d8fa0744d96b3b1e875cb7d0bb327aa3f` and approved same-seam correction task. These refine CORE-04/05, not native acceptance. Limits are engineering admission bounds, not routing policy.

| Criterion | Test IDs | Observable acceptance | Independent expected source |
| --- | --- | --- | --- |
| CORE-04 | C04-final-deadline, C04-final-dispose, C04-reuse-final, C04-resolver-final | Revision getter #4 advancing to hard deadline or disposing owner blocks before ledger commitment with zero applied receipt; resolver/reuse also fenced after synchronous callbacks/serialization/hash; observer disposal after commit still cannot roll back | Parent public probes reproduced `committed` after deadline/disposal; correct result blocked, state not committed; hard deadline literal 5000 |
| CORE-05 | C05-canonical, C05-canonical-unresolved, C05-canonical-array, C05-canonical-invalid | Named-field nested policy projection ignores record insertion order/unknown extra keys, validates declared fields; equivalent duplicate revalidates same receipt without assessment/notification; meaningful array order and actual value changes still conflict | Parent reordered-record probe and explicit typed field contract |
| CORE-05 | C05-limit-sessions, C05-limit-tombstones, C05-limit-session-entries, C05-limit-total-entries, C05-limit-ids | Fail-closed capacity before allocation/callback; retain consumed identities without eviction/reset; existing duplicate join/revalidation allowed at saturation; all ID admissions reject malformed/oversized values before lookup/hash, including unknown-session disposal | Finite engineering caps: 256 retained sessions, 256 entries/session, 4096 total entries, 256 UTF-8 bytes per session/logical/attempt/generation ID; exact limit accepted, next rejected; capacity-exceeded typed reason |

Capacity tests execute isolated fixture processes with public API only; no production ledger-reset API. Terminal tombstones count toward session cap, consumed entries count for process lifetime. No LRU or clearing state to admit new assessments.
