# Per-agent required child extensions

## Approved scope and design

Source: operator-approved dependency task, ticket 08. Existing optional agent extensions can be removed by `denyExtensions`; session-wide required extensions affect unrelated siblings. Add one extension-owned field to the existing public runtime agent definition, not a budget engine or executor.

```ts
import { registerAgent } from "pi-subagents/agents";

const registration = registerAgent({
  pi,
  name: "bounded-worker",
  definition: {
    description: "Worker with a mandatory local child helper",
    systemPrompt: "Complete the assigned task.",
    requiredExtensions: [{ id: "worker-bound", path: helperPath }],
  },
});
```

`requiredExtensions` accepts readonly `RequiredChildExtension` entries (`id`, `path`) using the existing required-child-extension validator. Registration canonicalizes existing files and freezes a private snapshot. Each entry becomes mandatory for every runner: unsupported external runners and remote machine placements reject instead of silently dropping it. This field is extension-owned, not caller/profile/settings-owned, and does not grant authority to bypass a capability ceiling.

At launch, compose the agent snapshot with current session, inherited and retained requirements. Identical identities compose idempotently; conflicting IDs or paths reject. Required helpers survive `extensions: []`, profile application, serialization and recovery. Existing launch machinery loads them before the first prompt and projects safe IDs into evidence. A denying effective ceiling rejects before child provider work. An agent without requirements retains existing behavior. Registration disposal affects future discovery, not snapshots already retained by a launch.

No dependency version change, publication, Jev integration, host-cache changes or new runner are included. This local source change is not a distributed release.

## Acceptance matrix (written before tests)

| Criterion | Tests | Expected-value source |
| --- | --- | --- |
| AC-1 Public registration accepts, canonicalizes and owns per-agent requirements; rejects malformed input; disposal and collisions retain existing semantics | `per-agent-required-extensions.test.ts`: registration snapshot, malformed definitions, disposal/collision | Task: public schema/registration/ownership; existing `RequiredChildExtension` shape |
| AC-2 Required sets compose with global/inherited/retained requirements without caller overrides dropping them; conflicts reject | same file: composition, conflict; existing required-child-extension suite | Task: existing global requirements composition; no lost mandatory requirements |
| AC-3 Resolved direct/async/workflow child plans retain requirements; ceiling denial rejects before child work; ordinary sibling unchanged | focused integration cases and real CLI smoke `per-agent-required-extensions.mjs` | Task: exactly zero junior provider requests on conflict, explicit error; sibling unaffected |
| AC-4 Retained serialization and recovery preserve requirements after disposal; effective denial still rejects | focused retained/recovery tests and real CLI smoke | Task: retained/recovery requirements cannot be lost |
| AC-5 Unsupported runner/machine admission rejects, never silently drops per-agent requirements | per-agent unit/async admission tests | Task: strict nonnative admission; existing only-local-native loading contract |
| AC-6 Native allowed child loads required helper before prompt, independently of optional extensions | real CLI smoke | Task: allowed required helper delivery |
| AC-7 Current effective policy intersects trusted Pi session UUID and legacy file identity plus inherited/retained restrictions, without unrelated/disposed-session leakage | `current-session-capability-ceiling.test.ts`; real CLI four-path denial | Supervisor-approved narrow prerequisite after real CLI UUID-only registration exposed async admission mismatch |

Each named test maps to the criterion named in its title or containing section. Focused suites, typecheck, build and native tool-activation smoke are bounded gates; the full cross-platform suite is not claimed. Exact commands, RED/GREEN results and any remaining gaps are reported in the implementation artifact.
