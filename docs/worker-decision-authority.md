# Worker decision authority API core

`pi-subagents/worker-decision-authority` exports a trusted, in-process session-owner registry and asynchronous leaf-decision preparation. Originating native foreground and direct async single launches call shared preparation before final model/thinking binding when that host session has owned authority. Deferred background chain/fanout and nested authority transport, durable recovery, Jev policy and actual native/provider proof remain separate work.

## Ownership and outcomes

`registerWorkerDecisionAuthority({ sessionId, lifetimeDeadline, assessmentTimeoutMs, authority })` registers one owner and returns `{ generation, dispose() }`. The required assessment timeout is finite and nonnegative (zero and fractional milliseconds are valid); no default is synthesized. Registration snapshots both lifetime and assessment budget. Duplicate registration throws `WorkerDecisionAuthorityError` with typed `owner-conflict`. Generation is immutable. Disposing aborts pending preparation; old disposal cannot remove a replacement. Replacing an owner requires disposal, never silent overwrite. Owner callbacks are snapshotted at registration.

`getWorkerDecisionAuthoritySnapshot(sessionId)` returns immutable fencing metadata only:

- `never-owned`: no retained session exists.
- `active`: registered owner metadata `{ generation, lifetimeDeadline, assessmentTimeoutMs }`, with no authority callback, task or secret. This reports registration, not proof its deadline is still live; preparation rechecks time and generation.
- `missing`: previously registered session has no current owner.
- `disposed`: terminal session tombstone.

Use the actual originating host session identity consistently for registration and lookup. The native executor's existing identity convention prefers the public session file over session UUID through `resolveCurrentSessionId`; registrants must use that same identity, not independently choose a UUID. Capture a generation once for a logical leaf, not again after awaits to adopt a replacement. Snapshot reads of absent sessions allocate no retained session records and do not consume admission slots.

Native compatibility reader preserves legacy never-owned behavior for an actual session-file key above the public 256 UTF-8-byte cap only when no expected generation/ownership carrier exists and the key is otherwise valid. Such an exact key cannot be publicly registered; no authority support is claimed for it. Explicit ownership, malformed IDs, and missing/disposed/stale owners remain fail-closed. Public validation stays strict; no UUID fallback, hashing, truncation or dual lookup is used.

`invalidateWorkerDecisionAuthority(sessionId, generation)` is nonterminal, generation-checked invalidation. It returns `true` only when it removes that matching owner and aborts its pending work; absent, missing, terminal or stale-generation cases return `false` without allocation. Same-session registration can then succeed with a new generation. Consumed identities and committed pairs remain intact; stale invalidation and old registration disposal cannot remove a replacement. It does not authorize another assessment of blocked or indeterminate work. Native lifecycle wiring captures session ID plus generation, never a stale extension context or cleanup-time lookup of the current owner.

`disposeWorkerDecisionSession(sessionId)` terminates that session identity and aborts outstanding work. Registration cannot revive it. Session IDs must identify distinct originating sessions; do not reuse them after termination.

`prepareWorkerDecision(input)` returns one of:

- `unowned`: this session has never registered an owner and the request did not name an expected generation. Native integration preserves existing launch behavior on this optional path and does not attribute a Jev selection.
- `blocked` with a safe typed `reason`: missing expected owner, stale generation, disposed session, cancellation/deadline, invalid reply, denied admission, capacity-exceeded admission or consumed-indeterminate assessment. A previously owned session does not silently become unowned after disposal.
- `committed` with immutable `receipt`: exact pair passed trusted validation and was logically committed. This is not a spawn, lease, provider execution or terminal receipt.

`getWorkerDecisionState(sessionId, logicalLaunchId)` reports `unconsumed`, consumed `pending`/`blocked`/`indeterminate`, or the committed receipt. No task content or raw exception is returned.

## Input boundary

Preparation accepts three separate records:

- `control`: stable logical launch ID, separate runtime attempt ID, owner generation, actual fresh/fork context and optional finite launch deadline.
- `facts`: complete authored/materialized task, optional factual role introduction and verified capability descriptions with provenance. Preparation copies only these named fields; unrelated configuration and caller routing fields are dropped.
- `policyContext`: definition/constraint revisions, fixed or selectable physical model contract, and original pair as verified with provenance/revisions or explicitly unresolved. This record is private orchestration context, **not classifier state**.

`facts.role.name?: string` is the exact resolved agent definition name, available only with `role.provenance="resolved-agent"`. Originating native foreground/direct-async preparation supplies `AgentConfig.name` from the actual resolved configured or runtime definition, not the caller's alias/local label, task wording or description. The role is emitted even without a description (`description=""`). Names are preserved verbatim; the core requires a nonempty string without NUL and rejects a name on `authored-task` provenance. Older nameless role facts remain valid; consumers must not infer an absent name. Provenance is a trusted-host assertion, not independent verification of caller-supplied facts.

The named facts projection includes `role.name` in logical identity: changed names conflict under the same logical launch ID; reordered fields or undeclared extras reuse the original commitment without another assessment. Native definition revisions already hash the resolved agent, including its name. This field introduces no routing algorithm and exposes no configured thinking, system prompt or steering prose.

An owner should pass only `request.facts` to its assessment adapter, never spread the whole request or `policyContext`. Configured/default/baseline thinking must not be added to task/role prose. Factual role descriptions are allowed; the core does not judge natural-language descriptions or remove routing instructions embedded in authored task text. This boundary is not prompt-injection immunity.

Every accepted owner reply is `kind: "apply"` with explicit physical `model`, enum `thinking` and typed `reason` (`assessed`, `verified-original-retained`, `verified-target-retained`). `requestedThinking` optionally records pre-support-adjustment effort. `off` is valid only when trusted final admission confirms target support; it is never synthesized. A model-only, null, unknown-effort or suffix-bearing model reply is invalid, even when configured role thinking is high.

The owner can instead explicitly reject with a typed reason. Classification and fallback selection live in that owner, not this core. No model rankings, classifier, policy thresholds, guessed defaults or SDK session creation are included.

## Trusted host seam

`input.host` must supply:

- `getCurrentRevisions()`: current definition and constraint revisions, checked before callback, after awaits and immediately before logical commitment.
- `resolveTarget(model, request, { signal, hardDeadline })`: side-effect-free authoritative final-target support/baseline/admission evidence. The callback context exposes this as `resolveTarget(model)`, fenced by the same owner, cancellation, revisions and deadline. A resolved target must match requested physical ID and revisions. An unavailable effective baseline stays unresolved; do not create a session to discover it.
- `validate(pair, request, { signal, hardDeadline })`: validate exact physical ID, supported effort, availability, fixed/selectable contract, scope, ceilings, required extensions and budgets against the same resolved host definition. Return `valid` or typed refusal; do not silently substitute/clamp around policy. The core never imports private host APIs or assumes model support.

Primitive owner/session/cancellation/time guards run after revision callbacks, after target serialization, and after receipt construction/hash immediately before ledger commitment. No host callback runs between that final guard and commitment. Revalidation/reuse is fenced the same way.

These callbacks are trusted code, not a sandbox. Integration must bind their request/definition/task snapshots correctly. The core does not claim to implement authoritative host baseline resolution.

## Deadlines and cancellation

Hard authority deadline is the minimum finite launch deadline and finite registered owner lifetime. Non-finite provided launch deadlines and invalid per-request classifier timeouts are rejected. The registered `assessmentTimeoutMs` is authoritative; preparation's required finite nonnegative `classifierTimeoutMs` is only an additional tightening cap. A caller cannot extend the owner's assessment budget. Later hosts can pass the active snapshot's timeout as this cap; there is no executor-selected assessment default. No automatic deadline extension exists.

Assessment cutoff is `min(admission + min(owner.assessmentTimeoutMs, input.classifierTimeoutMs), hardDeadline - 500)`. The 500 ms reserve separates classifier time from resolution/validation/commit budget. `assessmentAvailable` is false when no assessment time remains. The owner must enforce its classifier cutoff and may explicitly retain a verified original pair while authority is still live. The core does not abort authority at assessment cutoff or choose fallback. At hard deadline, cancellation, owner replacement or session disposal, preparation settles blocked even if callback ignores its abort signal. Late replies cannot commit. Host work should cooperate with cancellation; JavaScript cannot forcibly terminate an arbitrary callback.

An injectable `WorkerDecisionClock` (`now`, absolute-deadline `schedule`) permits deterministic fixtures. Production defaults use host time and timers. Resolution and validation consume remaining budget; neither resets it. No new positive minimum validation-time threshold is invented: completion must occur strictly before the hard deadline.

## Originating native launch integration

The executor captures the host session/generation at admission, then resolves the actual configured/runtime-only agent and prepares the complete authored task plus provenance-tagged exact role name and factual description. It does not rediscover a disk agent through preflight or send configured thinking as assessment facts. Previously owned missing/disposed/stale authority blocks instead of becoming unowned.

Owned launches require the existing resolved finite positive host timeout. An absolute launch deadline is anchored immediately before preparation and threaded unchanged into foreground execution and direct-async config/recovery descriptor. Preparation does not invent a host budget or borrow owner lifetime. Owner lifetime independently tightens the hard authority deadline; registration assessment budget and the 500 ms reserve remain separate. Never-owned launches keep the preexisting timeout origin and avoid asynchronous authority preparation.

The host adapter uses public available-model metadata and actual agent/constraint snapshots. Nonreasoning targets explicitly support `off`; otherwise only explicitly reported `thinkingLevelMap` entries count as verified support. Generic SDK support fallback is not evidence. A suffix/config value establishes requested effort, not necessarily effective support: original/final-target baselines are verified only when the exact effort is supported on that physical model. Unknown/default/unsupported effort stays `thinking-unresolved`; no implicit baseline clamp or guessed SDK default is supplied. A successful explicit supported owner choice may still apply with an unresolved original baseline; verified fallback may not use it.

Configured agent models remain selectable, not implicit fixed-role contracts. Current explicit scope, ceiling, availability, required-extension, tool/budget/capability and launch-rule admission are checked again on reuse. The committed pair is bound as an explicit model **and explicit thinking override**. A model suffix by itself is not this guarantee: explicit thinking override replaces a preexisting suffix and prevents role-configured `high` from winning over authority-selected `medium`. Foreground factory and direct-async spawn fences reject stale authority or a mismatched final pair. Owned watchdog admission evaluates the full committed `model:thinking` pair; the existing evaluator still matches bare physical-model patterns. Immediately before actual child creation or async spawn (after descriptor/config construction), synchronous admission reloads live launch rules, then rechecks revisions and primitive owner/generation/cancellation/deadline guards after external work. Tightening blocks without reassessment; never-owned launch checks remain unchanged. Authority receipt digest and native launch-contract digest project different data; compare their selected model/effort, not hash equality.

Lifecycle owns only generations observed at `session_start` or executor admission. Switch/reload/shutdown nonterminally invalidates those captured pairs, preserving consumed identities and permitting same-session registration. Old cleanup cannot remove an uncaptured replacement, including one registered by an abort listener. **Registrant owns its returned disposer**, including registration later in the same startup event without any launch; executor does not claim to clean every registration. Later Jev integration must retain that disposer for its own lifecycle.

Preparation happens outside foreground compaction-recovery attempts. Each separately permitted attempt revalidates the same logical commitment with a distinct runtime-attempt identity and no second assessment/notification. Existing termination, stop, timeout and lease rules still decide whether another attempt is permitted. Detached runner children receive the committed pair and deadline, not a serialized callback or new authority transport. A receipt proves logical commitment only, never spawn/provider execution or crash-durable exactly-once behavior. Existing management `resume`/`revive` branches execute before fresh single-launch preparation and remain unchanged; authority admission/consumption for those paths and detached recovery is pending follow-on review before integrated release. This slice is not universal authority or recovery coverage.

## Consumption, recovery and notification

Claim occurs synchronously before `decide`, including reentrant callbacks. One assessment is consumed per stable logical launch ID, not per runtime attempt. Pending duplicate deliveries join the first result; a duplicate's cancellation/deadline only stops its own wait. Original request cancellation blocks the shared decision. Changed task/context/policy revisions produce `identity-conflict`, never a new assessment under the same logical ID. Owner succession preserves consumption. Binding uses validated named-field projections for facts and nested policy records: record key insertion order and undeclared extra fields do not change identity, while actual declared values and meaningful array order do. Malformed declared fields are invalid-request, not silently coerced.

Committed duplicate delivery revalidates the same pair under current authority and returns the same receipt without reassessment or another notification. Native integration reuses selection for a separately authorized runtime attempt; **it does not authorize spawning or bypass termination/lease checks**. The committed receipt retains its original deciding generation.

Callback exceptions leave `consumed-indeterminate`, not an implicit retry or executor-selected baseline. Typed rejection/deadline/cancellation remains consumed. `onApplied` runs after validation and logical commitment, at most once. If it throws, commitment stays valid and result includes `notification: "failed"`; no raw error is returned. There is no observer retry/outbox guarantee.

Registry and ledger are process-local, shared across duplicate imports using the existing global-symbol pattern. They are not crash-durable. No restore/import API, task-bearing transport, disk ledger or durable exactly-once inference is claimed. Terminal session tombstones and consumed entries remain in process memory to prevent ID reuse/reset; retention is process-lifetime under finite admission bounds.

### Bounded process-lifetime retention

The public immutable `WORKER_DECISION_AUTHORITY_LIMITS` defines these engineering limits:

| Resource | Limit |
| --- | --- |
| Retained originating sessions, including disposed registrations and terminal tombstones | 256 |
| Consumed entries per session, including pending/blocked/indeterminate/committed entries | 256 |
| Consumed entries across all retained sessions | 4096 |
| Each session ID, logical launch ID, runtime attempt ID and supplied owner generation | 256 UTF-8 bytes |

IDs must be non-empty trimmed strings without NUL. Every public admission validates IDs before registry/ledger lookup or binding hashing. Registration, snapshot/state inspection, nonterminal invalidation and terminal disposal throw typed `WorkerDecisionAuthorityError("invalid-request")` for malformed IDs; preparation returns typed blocked invalid-request. Limits apply to `disposeWorkerDecisionSession` even for a previously unknown session: creating a terminal tombstone consumes one retained-session slot.

New session/tombstone admission at capacity throws typed `capacity-exceeded` before allocating retained state. New logical assessment at either entry cap returns blocked capacity-exceeded before claim or callback. Existing duplicates can still join or revalidate/reuse their original commitment at capacity, subject to all authority/deadline/revision guards. Existing session disposal remains available. Neither owner disposal, nonterminal invalidation nor terminal disposal frees an admission slot or clears consumed identities. Snapshot and invalidation misses never allocate retained sessions, even at capacity.

There is no LRU eviction, reset API or automatic retry that forgets consumed work. Saturation deliberately refuses new owned work for the remainder of this process lifetime; it does not justify restarting to retry an indeterminate logical launch. These bounds limit retained record counts and identity bytes, not arbitrary trusted host model/revision string sizes or callback-owned allocations.

A follow-on durable integration must persist claim before inference and block indeterminate crash recovery, rather than reconstruct a missing claim as unconsumed. It must separately prove child identity/termination around ambiguous spawn.

See [API-core acceptance matrix](testing/worker-decision-authority-core.md), [routing-delta acceptance matrix](testing/worker-decision-authority-routing.md) and [native wiring matrix](testing/worker-decision-authority-native.md) for scoped tests and deferred proof boundaries.
