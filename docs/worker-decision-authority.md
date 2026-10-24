# Worker decision authority API core

`pi-subagents/worker-decision-authority` exports a trusted, in-process session-owner registry and asynchronous leaf-decision preparation. **Native executors do not call this API yet.** Registration alone does not intercept any launch. Foreground/background, deferred/workflow/fork/nested transport and native proof are separate integration work.

## Ownership and outcomes

`registerWorkerDecisionAuthority({ sessionId, lifetimeDeadline, authority })` registers one owner and returns `{ generation, dispose() }`. Duplicate registration throws `WorkerDecisionAuthorityError` with typed `owner-conflict`. Generation is immutable. Disposing aborts pending preparation; old disposal cannot remove a replacement. Replacing an owner requires disposal, never silent overwrite. Owner callbacks are snapshotted at registration.

`disposeWorkerDecisionSession(sessionId)` terminates that session identity and aborts outstanding work. Registration cannot revive it. Session IDs must identify distinct originating sessions; do not reuse them after termination.

`prepareWorkerDecision(input)` returns one of:

- `unowned`: this session has never registered an owner and the request did not name an expected generation. Later integration must preserve existing launch behavior on this optional path, not attribute a Jev selection.
- `blocked` with a safe typed `reason`: missing expected owner, stale generation, disposed session, cancellation/deadline, invalid reply, denied admission or consumed-indeterminate assessment. A previously owned session does not silently become unowned after disposal.
- `committed` with immutable `receipt`: exact pair passed trusted validation and was logically committed. This is not a spawn, lease, provider execution or terminal receipt.

`getWorkerDecisionState(sessionId, logicalLaunchId)` reports `unconsumed`, consumed `pending`/`blocked`/`indeterminate`, or the committed receipt. No task content or raw exception is returned.

## Input boundary

Preparation accepts three separate records:

- `control`: stable logical launch ID, separate runtime attempt ID, owner generation, actual fresh/fork context and optional finite launch deadline.
- `facts`: complete authored/materialized task, optional factual role introduction and verified capability descriptions with provenance. Preparation copies only these named fields; unrelated configuration and caller routing fields are dropped.
- `policyContext`: definition/constraint revisions, fixed or selectable physical model contract, and original pair as verified with provenance/revisions or explicitly unresolved. This record is private orchestration context, **not classifier state**.

An owner should pass only `request.facts` to its assessment adapter, never spread the whole request or `policyContext`. Configured/default/baseline thinking must not be added to task/role prose. Factual role descriptions are allowed; the core does not judge natural-language descriptions or remove routing instructions embedded in authored task text. This boundary is not prompt-injection immunity.

Every accepted owner reply is `kind: "apply"` with explicit physical `model`, enum `thinking` and typed `reason` (`assessed`, `verified-original-retained`, `verified-target-retained`). `requestedThinking` optionally records pre-support-adjustment effort. `off` is valid only when trusted final admission confirms target support; it is never synthesized. A model-only, null, unknown-effort or suffix-bearing model reply is invalid, even when configured role thinking is high.

The owner can instead explicitly reject with a typed reason. Classification and fallback selection live in that owner, not this core. No model rankings, classifier, policy thresholds, guessed defaults or SDK session creation are included.

## Trusted host seam

`input.host` must supply:

- `getCurrentRevisions()`: current definition and constraint revisions, checked before callback, after awaits and immediately before logical commitment.
- `resolveTarget(model, request, { signal, hardDeadline })`: side-effect-free authoritative final-target support/baseline/admission evidence. The callback context exposes this as `resolveTarget(model)`, fenced by the same owner, cancellation, revisions and deadline. A resolved target must match requested physical ID and revisions. An unavailable effective baseline stays unresolved; do not create a session to discover it.
- `validate(pair, request, { signal, hardDeadline })`: validate exact physical ID, supported effort, availability, fixed/selectable contract, scope, ceilings, required extensions and budgets against the same resolved host definition. Return `valid` or typed refusal; do not silently substitute/clamp around policy. The core never imports private host APIs or assumes model support.

These callbacks are trusted code, not a sandbox. Integration must bind their request/definition/task snapshots correctly. The core does not claim to implement authoritative host baseline resolution.

## Deadlines and cancellation

Hard authority deadline is the minimum finite launch deadline and finite registered owner lifetime. Non-finite provided launch deadlines and invalid classifier timeouts are rejected. No automatic deadline extension exists.

Assessment cutoff is `min(admission + classifierTimeoutMs, hardDeadline - 500)`. The 500 ms reserve separates classifier time from resolution/validation/commit budget. `assessmentAvailable` is false when no assessment time remains. The owner must enforce its classifier cutoff and may explicitly retain a verified original pair while authority is still live. The core does not abort authority at assessment cutoff or choose fallback. At hard deadline, cancellation, owner replacement or session disposal, preparation settles blocked even if callback ignores its abort signal. Late replies cannot commit. Host work should cooperate with cancellation; JavaScript cannot forcibly terminate an arbitrary callback.

An injectable `WorkerDecisionClock` (`now`, absolute-deadline `schedule`) permits deterministic fixtures. Production defaults use host time and timers. Resolution and validation consume remaining budget; neither resets it. No new positive minimum validation-time threshold is invented: completion must occur strictly before the hard deadline.

## Consumption, recovery and notification

Claim occurs synchronously before `decide`, including reentrant callbacks. One assessment is consumed per stable logical launch ID, not per runtime attempt. Pending duplicate deliveries join the first result; a duplicate's cancellation/deadline only stops its own wait. Original request cancellation blocks the shared decision. Changed task/context/policy revisions produce `identity-conflict`, never a new assessment under the same logical ID. Owner succession preserves consumption.

Committed duplicate delivery revalidates the same pair under current authority and returns the same receipt without reassessment or another notification. This allows a later native integration to reuse selection for a separately authorized runtime attempt; **it does not authorize spawning or bypass termination/lease checks**. The committed receipt retains its original deciding generation.

Callback exceptions leave `consumed-indeterminate`, not an implicit retry or executor-selected baseline. Typed rejection/deadline/cancellation remains consumed. `onApplied` runs after validation and logical commitment, at most once. If it throws, commitment stays valid and result includes `notification: "failed"`; no raw error is returned. There is no observer retry/outbox guarantee.

Registry and ledger are process-local, shared across duplicate imports using the existing global-symbol pattern. They are not crash-durable. No restore/import API, task-bearing transport, disk ledger or durable exactly-once inference is claimed. Terminal session tombstones and consumed entries remain in process memory to prevent ID reuse/reset; retention is currently process-lifetime. A follow-on durable integration must persist claim before inference and block indeterminate crash recovery, rather than reconstruct a missing claim as unconsumed. It must separately prove child identity/termination around ambiguous spawn.

See [API-core acceptance matrix](testing/worker-decision-authority-core.md) for contract tests and deferred proof boundaries.
