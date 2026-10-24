# Native worker authority — pre-test wiring matrix

Base: `dc8044c408c6d5b9ef0e55acb0ab2b1e47c44464`. Approved scope: originating executor foreground and direct async single native leaves, shared preparation/host adapter and session lifecycle invalidation. No deferred runner/chain/fanout/nested authority transport, durable recovery, Jev classifier/policy or UI. Fixtures never run model inference or native CLI children.

| AC | Tests | Independent expected result |
| --- | --- | --- |
| NAT-01 | N01-foreground | Actual executor calls owner with exact authored task/role/private baseline before scripted factory |
| NAT-02 | N02-async | Actual direct-async executor calls owner before intercepted spawn; descriptor/config exact target:medium |
| NAT-03 | N03-foreground-high, N03-async-high | Explicit medium defeats configured high on both native bindings |
| NAT-04 | N04-missing, N04-cancel, N04-stale, N04-denied | Missing effort/cancel/stale/denial creates no child/spawn |
| NAT-05 | N05-unowned | Never-owned role-high path unchanged, no owner receipt |
| NAT-06 | N06-runtime | Actual runtime-only resolved definition, not disk lookup |
| NAT-07 | N07-explicit, N07-configured, N07-unresolved | Suffix/config provenance or unresolved; unknown SDK defaults never guessed |
| NAT-08 | N08-scope, N08-ceiling, N08-support, N08-fixed, N08-admission | Exact pair checked against current explicit scope, ceilings, known registry support, optional trusted fixed contract and extension/budget/tool admission; generic support fallback not proof |
| NAT-09 | N09-binding | Receipt pair equals native model/thinking/config and independently projected contract; authority digest differs from native projection |
| NAT-10 | N10-recovery | Same logical preparation outside existing retry loop, same pair reused with distinct attempt IDs; existing recovery gates untouched |
| NAT-11 | N11-disposal, N11-deadline, N11-replacement, N11-reentrant, N11-late-registration, N11-reload | Captured session ID/generation invalidated nonterminally on lifecycle replacement/shutdown; real finite host duration anchored once before owned assessment; no reset; stale/reentrant cleanup cannot remove new generation |

Behavioral RED must exercise existing executor FG/direct async without authority interception, not missing helper imports. GREEN: scoped local Node mock tests, core/routing neighbors, source/focused fixture TypeScript checks and diff/lock gates. Native/provider proof remains later. Each new test ID maps only to its listed NAT criterion; additional variants keep that criterion.

Lifecycle ownership: executor invalidates only generations captured at session start or launch admission. Late registration without launch remains registrant-owned; registrant must retain disposer. Cleanup never snapshots and invalidates an uncaptured current generation.

NAT-07 expansion before fixtures: `N07-nonreasoning-high`, `N07-unknown-support`. A configured/suffixed requested value is verified as effective only with public registry support for that exact effort on the physical target; otherwise `thinking-unresolved`. No baseline clamping/default guess. An explicit supported owner pair can still apply; verified-pair fallback cannot use the unresolved baseline.

Final-fence fixtures planned before test additions: `N04-final-async` invalidates after descriptor/config construction but before actual spawn; `N11-replacement-runtime` exercises new extension runtime replacing old runtime on same public session manager; both require zero stale spawn and generation-checked cleanup. Existing NAT IDs unchanged.

Deadline carry fixture planned before test: `N11-deadline-foreground` consumes 100ms in owned assessment, observes actual foreground child creation, then advances fake host timers to original absolute cutoff. Expected child timeout at remaining 1900ms, not restarted 2000ms. Overlength host identity handling is limited by the later approved compatibility delta below; no namespace migration or dual lookup.

## Completed fixture evidence (not provider execution)

- Integration: `test/integration/native-worker-decision.test.ts` drives actual executor and FG scripted factory / intercepted direct-async spawn. It checks exact model/effort, separately projected contract hashes, unowned controls, invalid/rejected paths, live constraints, native compaction recovery, absolute FG/async deadlines and final spawn fencing.
- Lifecycle: `test/integration/native-worker-decision-lifecycle.test.ts` drives real extension handlers/public runtime registration. It covers file-first identity (UUID deliberately distinct), admission capture, pending-abort/no-commit/no-spawn, stale/reentrant replacement, no-launch registrant teardown, runtime replacement and same-session ledger reuse.
- Adapter: `test/unit/native-worker-decision.test.ts` covers trusted fixed contracts, explicit scopes/revisions, commitment reuse, finite-host-budget requirement, assessment reserve/owner lifetime, reentrant fence and unsupported/unknown effective baseline.
- Original RED is two actual executor tests failing callback count `0 !== 1`. Later fixture/import/type/projection failures are retained separately and are not substituted for that behavioral RED.

Never-owned checks prove bindings and unchanged deadline-origin code path, not a performance benchmark. Mock factories/intercepted spawn do not prove actual Pi/Pi-Bolt/provider behavior, detached recovery, nested/deferred transport or durable exactly-once assessment. Existing retry/lease/terminal gates remain in place; these fixtures grant no new retry permission.

Identity compatibility delta approved before tests: keep file-first `resolveCurrentSessionId`, never UUID-first/hash/truncate/dual lookup. `N05-file-owner` routes a valid file key whose UUID differs. `N05-long-file-foreground`, `N05-long-file-async`, `N11-long-file-start` preserve never-owned legacy paths only for an actual file key above the public 256 UTF-8-byte registration cap with no expected generation. `N11-long-file-owned` rejects an explicit expected generation; malformed IDs and missing/disposed/stale owners stay fail-closed. No authority support is claimed for overlength file identities; public validation is unchanged.

NAT-10 scope checkpoint: `N10-recovery-native` proves ordinary foreground internal compaction/abort recovery under existing gates, not management `resume`/`revive` or detached recovery. Those origin management branches execute before fresh single-launch authority preparation and remain unchanged/pending; no new block or universal authority/recovery coverage is claimed. Follow-on must audit their consumption/owner admission before integrated release.

## NAT-08 admission correction — matrix before regression tests

Review base: `824cbc00dfa6db09b777ab03be42f77293d086d2`; independent review found two P1 gaps. Correction only changes owned native watchdog admission; public APIs, watchdog glob/base-model semantics, never-owned behavior, management recovery and deferred scope remain unchanged.

| Test ID | Actual executor seam | Independent expected result |
| --- | --- | --- |
| N08-fg-pair-deny | Foreground selected `fixture/target:medium`; exact-pair block rule | One owner callback; zero child creation |
| N08-fg-pair-allow | Foreground selected pair; allow only exact pair | One owner callback; factory receives exact pair |
| N08-async-pair-deny | Direct async selected pair; exact-pair block rule | One owner callback; zero spawn |
| N08-async-pair-allow | Direct async selected pair; allow only exact pair | One owner callback; intercepted spawn config has exact pair |
| N08-late-watchdog | Inject bare-target deny after runner config write | One owner callback; live final synchronous rule recheck blocks spawn |
| N08-late-watchdog-fg | Tighten rules at foreground factory revalidation boundary | One owner callback; live final synchronous rule recheck blocks creation |
| N08-watchdog-final-owner / cancel / deadline | Invalidate authority while final watchdog rules load/evaluate | After external callback/load, primitive owner/generation/cancel/deadline guards block creation/spawn |

Tests use temporary fixture project settings only. No real user watchdog settings are edited. Original five regression cases must fail behaviorally before source changes; additional final-fence cases extend NAT-08 only. Initial rule hashing alone is insufficient: final actual create/spawn must observe live rules, then fence authority after external work without another host callback after the final primitive guard.

Final-guard expansion before fixtures: `N08-watchdog-final-fg-owner`, `N08-watchdog-final-fg-cancel`, `N08-watchdog-final-fg-deadline` invalidate control during the foreground final synchronous watchdog load after attempt revalidation. Same expected zero creation and one owner callback; shared final admission must guard both native boundaries, not only async.

Correction validation: original five actual-executor regressions fail 0/5 on review base (deny create/spawn `1 !== 0`, allow `0 !== 1`, late deny spawn `1 !== 0`). Final correction fixtures pass 12/12, covering exact pair, late FG/async tightening and owner/generation/cancel/deadline invalidation during final policy loading. Focused union passes 307/307 = prior parent 293 cases + 12 new correction cases + 2 unchanged watchdog-rule neighbors; overlapping earlier runs are not additive. No provider/native CLI evidence is claimed.

## Public SDK binding and opt-in local CLI proof

Binding acceptance (planned before RED):

| ID | Behavioral test/source | Expected contract |
| --- | --- | --- |
| SDK-BIND-01 | `pi-spawn-host-dependency.test.ts`, `child-session-host-sdk.test.ts` | Official JS/package hosts retain absolute public export identity, precedence, and selected-entry failure propagation |
| SDK-BIND-02/03 | `compiled public SDK binding` | Bun virtual entry AND canonical executable-owned Pi manifest required for public embedded SDK alias; unverified host never uses extension SDK fallback |
| SDK-BIND-04 | `binary-async-spawn.test.ts`, compiled foreground fixture | Valid and stale explicit npm SDK roots rejected before runner config/spawn; no selected-root retry |
| SDK-BIND-05 | Compiled spawn fixture and actual async CLI receipt | Existing public binary bootstrap/virtual peers retained; no npm SDK aliases or alternate SDK install |

The opt-in pair `test/fixtures/native-worker-authority-cli-{extension.ts,proof.mjs}` is outside normal test globs. Invocation requires owned artifact directory, one scenario, absolute host executable, expected SDK version, and expected binding kind:

```sh
node test/fixtures/native-worker-authority-cli-proof.mjs /tmp/owned-proof/foreground foreground /absolute/path/to/pi 1.3.0 compiled-public-sdk
```

Only deterministic loopback HTTP is used, never hosted inference or a classifier. Temporary HOME/agent directory, empty auth, explicit candidate extensions, offline startup and credential-free environment isolate user configuration. Role baseline `local/baseline:high`; callback commits literal `local/selected:medium`. Actual child HTTP must contain `model=selected`, `reasoning_effort=medium`; completed native receipt must contain `CHILD_RECEIPT_OK`; exactly one callback and commitment share launch identity. Async additionally requires public `processTerminal.state=observed` with runner exit 0 before server closure. Foreground exposes no such terminal field: proof is completed native tool result, session shutdown, and orderly parent close only.

Each invocation records source file hashes/base SHA/dirty status, host command/version/hash, executable-owned SDK manifest/hash, public SDK function identity, isolated config before/after hashes, request projections, audit, raw stdout/stderr and close receipt. Private audit/raw output stays in owned artifact directory. Failed lanes retain dependencies and artifacts, with no kill/retry-until-green.

Bounded local result: Pi-Bolt **0.9.7 / Pi 1.3.0, macOS arm64**, foreground and direct async each passed once on the corrected binding. Root `/Users/naicoi/.pi-bolt/npm/0.9.7/pi-bolt-darwin-arm64`; public alias identity verified, not worktree development SDK 1.2.0. Raw evidence `/tmp/bolt-sdk-binding-evidence/{foreground,async}`. Async run `6a9be597-9dff-44be-a117-6dde528ad9fb`, runner `ced54437-90dc-4fc3-b2fe-a48ec17e4337`, observed exit 0. Official JS Pi 1.4.0 foreground/async evidence already passed at `/tmp/jev-authority-parent-proof-j1iU1N`; unchanged JS selection validated by focused regression tests, not repeated provider executions.

These receipts do not expand the full standalone lifecycle support matrix, prove hosted providers/Jev policy, or cover deferred management resume/revive, chain, fanout, nested authority or crash durability. Source hashes in receipts, not a later documentation-only commit SHA, identify the exact executed candidate.

### Harness assertion correction — matrix before regression tests

Review P2 delta only; product binding unchanged. CLI-04 assertion must match `runnerProcessInstanceId` to a `kind=runner` terminal instance, require `exitCode=0` and `signal=null`, not merely observed state. CLI-01 must inspect foreground `details.results[].finalOutput`; CLI-02 must read native JSON at public status `Result:` path and require `success=true` plus actual `output`. Task/session labels never count as output. Deterministic negatives: observed nonzero runner, wrong runner identity, signaled runner, task marker with empty FG/async output, failed native result. Replay existing saved FG/async receipts read-only under new assertions; replay is not fresh E2E. No CLI/provider rerun or loader change.

Correction validation: six negative cases fail against extracted old assertions (RED), then all eight deterministic cases pass (GREEN). Read-only saved-receipt replay adds foreground/async positives: 10/10 pass using actual FG `finalOutput` and native JSON `success` / `results[0].success` / `results[0].output`. Replay command: `NATIVE_AUTHORITY_REPLAY_ROOT=/tmp/bolt-sdk-binding-evidence node --test test/fixtures/native-worker-authority-cli-assertions.test.mjs`. No new CLI/provider execution; original raw receipts unchanged. Exact commands, raw logs and exit codes retained under `/tmp/bolt-sdk-harness-correction`, including once-only production and opt-in extension type checks.

### Resolved role name facts — acceptance before tests

Public additive field: optional `facts.role.name`, allowed only with `role.provenance="resolved-agent"`. Native builder supplies exact resolved configured/runtime `AgentConfig.name`, including definitions without descriptions (`description=""`); no caller label, task/description inference or routing algorithm. Existing nameless role facts remain valid. NAT-NAME-configured/runtime tests check exact name, factual-only projection, private baseline thinking and one assessment across revalidation. CORE-NAME projection/canonical tests check name retention, reordered/extraneous fields reuse one commitment, changed name conflicts, invalid/non-resolved name rejected. No system prompt, configured thinking or steering prose enters facts. Focused native/core tests and source types only; no CLI/provider proof replay or rerun.

NAT-NAME executor expansion before tests: configured (`source="project"`) and runtime definitions launched through a different caller alias must expose their canonical resolved name, even with empty description and misleading task wording. Existing direct-async/N01/N06 fixtures also assert name. Core invalid-name variants include NUL; no name normalization or configured prose is added.

Resolved-name delta validation: original four new unit cases fail behaviorally before implementation (`/tmp/worker-role-name-evidence/red.log`); targeted native/core/executor GREEN 9/9, focused native/core/routing unit union 82/82, production typecheck exit0. Tests prove actual alias resolution for project/runtime definitions, exact factual-only name projection, private thinking baseline, unchanged single assessment/notification on reuse, and name-sensitive canonical identity conflict. Source commands and exit codes retained under `/tmp/worker-role-name-evidence`. No CLI/provider proof or accepted harness rerun.
