# Pi Swarm 1.0 — Development PRD

## 1. Product Summary

Pi Swarm 1.0 is an `oh-my-pi` extension for coordinating multiple independent Pi sessions in the same local workspace.

Each session binds to a user-defined role manifest. Agents collaborate through:

- a shared pull-based task pool
- atomic filesystem task claims
- direct and broadcast JSONL events
- a Markdown blackboard
- normal filesystem artifacts

There is no supervisor LLM and no direct process-to-process agent invocation.

---

## 2. Goals

Pi Swarm 1.0 must provide:

1. deterministic role binding through YAML manifests
2. a shared task pool visible to all Pi sessions
3. autonomous task discovery and pull-based claiming
4. atomic single-owner task claims on a local filesystem
5. robust task lifecycle management
6. direct and broadcast event delivery through per-instance JSONL streams
7. replayable cursor-based event consumption
8. shared Markdown knowledge and artifact storage
9. Pi wakeup/inbox behavior using native OMP extension APIs
10. safe restart, crash recovery, and orphan-task recovery
11. six built-in role templates with support for custom roles
12. user-facing status, diagnosis, and recovery commands

---

## 3. Non-Goals

The 1.0 release will not implement:

- an LLM supervisor
- agent-to-agent process calls
- event compete/consumer-group delivery
- distributed hosts
- broker-backed transports
- dynamic role spawning
- full lease/fencing semantics
- duplicate active instances of the same role by default
- exactly-once delivery

---

## 4. Primary User Story

As a developer using multiple Pi sessions in one codebase, I want each Pi window to operate as a specialized autonomous agent that can discover and claim shared work, so that several roles can collaborate without a central orchestrating LLM.

Example:

```text
Window 1 -> coordinator
Window 2 -> architect
Window 3 -> researcher
Window 4 -> frontend
Window 5 -> backend
Window 6 -> tester
```

The coordinator may create tasks, but execution ownership is determined by the task pool and atomic claim protocol, not by coordinator push.

---

## 5. User Experience

### 5.1 Initialization

User installs the extension and runs:

```text
/swarm init
```

Expected result:

- `.pi/swarm/` is created
- default configuration is generated
- six built-in manifests are created
- filesystem capability checks pass
- no agent role is implicitly selected unless configured

### 5.2 Bind a session to a role

```text
/swarm role backend
```

Expected result:

- current session becomes a `backend` swarm instance
- duplicate active role detection runs
- presence record is created
- polling loops start
- role contract is injected before future agent runs

### 5.3 Discover and claim work

The backend agent sees eligible `open` tasks and may call:

```text
swarm_task_list
swarm_task_claim
```

A successful claim is atomic.

If another eligible agent has already claimed the task, the tool returns `already_claimed` and the agent continues to another task.

### 5.4 Complete work

The claimant:

- starts the task
- publishes artifacts/blackboard updates
- completes or fails the task
- emits canonical lifecycle events

### 5.5 Receive coordination updates

Relevant direct or broadcast events are batched into a swarm inbox and delivered to Pi using native `sendMessage` behavior.

---

## 6. Built-in Role Templates

The release must ship these manifests:

### `coordinator`

Capabilities:

- planning
- task decomposition
- project coordination
- progress synthesis

Default write authority:

- project-level context
- task creation

Restrictions:

- cannot directly invoke another agent
- does not automatically own created tasks

### `architect`

Capabilities:

- architecture
- API/interface design
- technical decision making
- design review

Default write authority:

- `blackboard/architecture.md`
- architecture decisions

### `researcher`

Capabilities:

- technical research
- evidence collection
- comparison
- experimentation

Default write authority:

- findings
- research artifacts

### `frontend`

Capabilities:

- frontend implementation
- UI/client integration
- frontend testing

### `backend`

Capabilities:

- backend implementation
- API/data/service work
- backend testing

### `tester`

Capabilities:

- verification
- regression testing
- acceptance testing
- evaluation
- quality review

Custom role manifests must be loadable without source-code changes.

---

## 7. Functional Requirements

## FR-1 Workspace Initialization

`/swarm init` must create:

```text
.pi/swarm/
  swarm.yaml
  agents/
  tasks/
  claims/
  events/
  blackboard/
  artifacts/
  runtime/instances/
  runtime/cursors/
```

It must be idempotent and must not overwrite user-modified manifests without explicit confirmation.

### Acceptance criteria

- running init twice does not corrupt state
- missing subdirectories are repaired
- default manifests validate against schema
- unsupported filesystem behavior produces actionable diagnostics

---

## FR-2 Role Manifest Loading

The extension must load `agents/*.yaml` and validate them with Zod.

Manifest schema must include:

- role identity
- name/description
- capabilities
- task claim policy
- direct/broadcast subscriptions
- blackboard read/write permissions
- wake policy

### Acceptance criteria

- invalid YAML is reported with filename and parse location where available
- schema errors list exact fields
- duplicate role IDs are rejected
- user-defined roles work without code changes

---

## FR-3 Role Binding and Presence

A Pi session can bind to one role.

The runtime creates a unique `instanceId` and publishes a presence record under:

```text
runtime/instances/<instance-id>.yaml
```

Presence fields:

- role
- instance ID
- session ID
- PID
- state: idle/busy/suspect/stopped
- heartbeat timestamp
- start timestamp

### Acceptance criteria

- one session cannot bind to two active roles simultaneously
- duplicate active instance for the same role is blocked by default
- clean shutdown marks presence stopped
- abnormal process death becomes detectable through heartbeat/PID checks

---

## FR-4 Task Creation

Expose `swarm_task_create`.

Required fields:

- title
- Markdown body/goal
- eligible roles and/or required capabilities
- priority
- optional dependencies
- optional parent task
- optional input references
- optional acceptance criteria

Task IDs must be generated safely and uniquely.

### Acceptance criteria

- new task is persisted as Markdown + YAML front matter
- new task begins in `open` unless dependencies are unresolved by policy
- creation emits `task.opened` or equivalent canonical event
- created task is discoverable even if the event is never consumed

---

## FR-5 Task Discovery

Expose `swarm_task_list` and `swarm_task_get`.

The runtime must filter tasks by:

- status
- eligible role
- required capabilities
- dependency completion
- existing claim

### Acceptance criteria

- an agent only sees tasks it is allowed to claim by default
- explicitly requested diagnostics may show all tasks
- malformed task files are isolated and surfaced via doctor/status instead of crashing the loop

---

## FR-6 Atomic Task Claim

Expose `swarm_task_claim`.

The canonical claim must be created using an exclusive atomic filesystem operation.

Claim result must be one of:

```text
claimed
already_claimed
not_eligible
not_open
invalid_task
```

### Acceptance criteria

- two concurrent claim attempts cannot both succeed
- a losing claimant treats contention as normal flow
- claim file contains task ID, claim ID, role, instance ID, session ID, PID, and timestamp
- claim record is canonical if task Markdown update is interrupted
- successful claim emits `task.claimed`

---

## FR-7 Task Lifecycle

Expose:

```text
swarm_task_start
swarm_task_complete
swarm_task_fail
swarm_task_abandon
swarm_task_reopen
```

Valid transitions:

```text
open -> claimed
claimed -> in_progress
in_progress -> done
in_progress -> failed
claimed/in_progress -> abandoned
abandoned -> open
```

### Acceptance criteria

- invalid transitions are rejected
- claimed-task mutations require matching current `claimId`
- completion persists output refs and summary
- each successful transition emits a canonical event
- done/failed tasks no longer appear as claim candidates

---

## FR-8 Event Writer

Each runtime instance owns exactly one JSONL stream.

Writes must:

- be append-only
- serialize one event per line
- validate event schema before writing
- flush sufficiently for crash-safe local use

### Acceptance criteria

- separate instances never write the same JSONL stream
- invalid events are rejected before persistence
- a truncated final line does not make previous events unreadable

---

## FR-9 Direct Event Routing

Direct route format:

```json
{
  "mode": "direct",
  "role": "backend"
}
```

### Acceptance criteria

- only matching active role consumes the event
- direct events are not interpreted as task assignment
- missing target role does not corrupt event processing

---

## FR-10 Broadcast Event Routing

Broadcast route format:

```json
{
  "mode": "broadcast",
  "topic": "architecture"
}
```

Consumers subscribe through their manifest.

### Acceptance criteria

- every subscribed role independently receives the event
- unsubscribed roles ignore it
- consumption state is per consumer
- late replay works from the consumer cursor where applicable

---

## FR-11 Cursor-Based Event Reader

The runtime polls all relevant producer streams and stores byte offsets in:

```text
runtime/cursors/<instance-id>.json
```

### Acceptance criteria

- restart resumes from persisted offsets
- incomplete trailing lines do not advance the cursor
- cursor corruption is detected by `/swarm doctor`
- event processing is at-least-once
- duplicate handling does not produce repeated irreversible task mutations

---

## FR-12 Inbox Aggregation

Task candidates and relevant events must be batched before waking the model.

Inbox content should distinguish:

```text
Actionable tasks
Relevant events
Current claimed task
Warnings/recovery notices
```

### Acceptance criteria

- event bursts do not cause one model turn per event
- repeated polling does not repeatedly surface unchanged task candidates during the same logical idle period
- claimed tasks are no longer surfaced as open candidates

---

## FR-13 Pi Wake Scheduler

Use native OMP APIs:

- `ctx.setInterval()` for managed polling
- `ctx.isIdle()` for idle detection
- `pi.sendMessage()` for runtime messages

Delivery policy:

- idle + actionable inbox -> trigger a turn
- active + informational update -> prefer `aside`
- active + deferred work -> prefer `followUp`
- default coordination must not use `steer`

### Acceptance criteria

- no unmanaged timers remain after shutdown
- runtime can wake an idle session
- active tool execution is not unnecessarily interrupted by routine swarm events

---

## FR-14 Agent Contract Injection

Use `before_agent_start` to inject:

- current role
- capabilities
- task-claim rules
- blackboard permissions
- current claimed task
- collaboration invariants

### Acceptance criteria

- contract is injected on every relevant agent run
- contract never states that an event grants ownership
- coordinator contract explicitly prohibits supervisor-style direct invocation

---

## FR-15 Context Hygiene

Use the `context` hook to compact/filter stale swarm runtime messages before model calls.

### Acceptance criteria

- session history remains intact where OMP preserves it
- model context does not grow unbounded from repeated inbox notifications
- current claimed-task context is retained
- current actionable inbox is retained

---

## FR-16 Blackboard Access

Expose:

```text
swarm_blackboard_read
swarm_blackboard_write
```

Writes must enforce manifest path permissions.

### Acceptance criteria

- path traversal outside `.pi/swarm/` is blocked
- unauthorized blackboard writes are rejected
- semantic document directories can be extended by custom roles
- project and architecture hotspot files honor writer policy

---

## FR-17 Artifact Publishing

Expose `swarm_artifact_publish`.

Artifacts are stored under:

```text
artifacts/<TASK-ID>/
```

### Acceptance criteria

- artifact paths remain workspace-scoped
- artifact metadata may include media type, size, and digest
- task output references are updated safely
- events reference artifacts rather than embedding large payloads

---

## FR-18 Orphan Detection and Recovery

The runtime detects stale presence records.

Automatic recovery is allowed only when:

```text
heartbeat stale
AND
local claimant PID confirmed dead
```

### Acceptance criteria

- stale heartbeat + live PID does not reopen the task
- dead claimant can cause task transition to abandoned then open
- recovery events are appended
- `/swarm recover` allows manual inspection and controlled recovery

---

## FR-19 Status Command

`/swarm status` must show:

- current role/instance
- active/suspect/stopped instances
- open task count
- claimed/in-progress tasks
- cursor health
- recent event processing status

The output should remain concise enough for routine use.

---

## FR-20 Doctor Command

`/swarm doctor` validates:

- workspace structure
- manifest schemas
- duplicate active role instances
- task schemas
- claim/task consistency
- stale/orphan claims
- event JSONL integrity
- cursor validity
- blackboard permission configuration
- filesystem atomic-create capability

### Acceptance criteria

- problems are categorized as error/warning/info
- output includes remediation guidance
- doctor does not mutate state unless an explicit repair flag/action is selected

---

## 8. Data Schemas

Schemas must be implemented in a dedicated protocol package/module using Zod.

Required schemas:

```text
SwarmConfig
AgentManifest
AgentIdentity
PresenceRecord
TaskDocumentMetadata
ClaimRecord
SwarmEvent
DirectRoute
BroadcastRoute
CursorState
ArtifactRef
```

Schema versioning must be explicit from 1.0 onward.

Unknown additive fields should be handled conservatively where forward compatibility is safe.

---

## 9. Recommended Source Layout

```text
pi-swarm/
  src/
    extension/
      index.ts
      hooks.ts
      commands.ts
      tools.ts
      renderer.ts

    protocol/
      schemas.ts
      agent.ts
      task.ts
      claim.ts
      event.ts
      artifact.ts

    runtime/
      runtime.ts
      identity.ts
      presence.ts
      task-poller.ts
      event-poller.ts
      inbox.ts
      wake-scheduler.ts
      reconciler.ts

    storage/
      filesystem.ts
      atomic-claim.ts
      task-store.ts
      event-store.ts
      cursor-store.ts
      blackboard-store.ts
      artifact-store.ts

    domain/
      task-service.ts
      event-service.ts
      recovery-service.ts
      policy-service.ts

    templates/
      agents/
        coordinator.yaml
        architect.yaml
        researcher.yaml
        frontend.yaml
        backend.yaml
        tester.yaml

  tests/
    unit/
    integration/
    multiprocess/
```

Dependency direction:

```text
extension
   ↓
runtime / domain
   ↓
storage + protocol
```

Domain/storage modules should not depend on OMP APIs directly.

---

## 10. Implementation Workstreams

The project is one 1.0 release, but development should be organized into independently testable workstreams.

### Workstream A — Protocol and Filesystem Core

Deliver:

- Zod schemas
- workspace path resolver
- task parser/writer
- claim store
- event writer/reader
- cursor store
- presence store

Exit criteria:

- all core state operations can be exercised without launching Pi
- concurrent claim test passes across separate Node processes

### Workstream B — Task Domain

Deliver:

- task creation
- eligibility logic
- dependency logic
- claim
- lifecycle transitions
- reconciliation
- orphan recovery service

Exit criteria:

- full state machine covered by tests
- interrupted-claim reconciliation test passes

### Workstream C — Event and Inbox Runtime

Deliver:

- direct routing
- broadcast topics/subscriptions
- polling
- cursor replay
- inbox batching
- deduplication safeguards

Exit criteria:

- process restart replays correctly
- late consumers receive expected unread broadcast events

### Workstream D — OMP Integration

Deliver:

- extension entrypoint
- managed intervals
- role binding
- before-agent contract injection
- context cleanup
- native wake behavior

Exit criteria:

- two real Pi sessions can exchange direct/broadcast swarm events through the filesystem

### Workstream E — User Commands and Tools

Deliver:

- domain tools
- `/swarm init`
- `/swarm role`
- `/swarm status`
- `/swarm tasks`
- `/swarm agents`
- `/swarm recover`
- `/swarm doctor`

Exit criteria:

- all normal operations can be performed without manual file editing

### Workstream F — Built-in Templates and Documentation

Deliver:

- six manifests
- default swarm config
- role contracts
- installation guide
- quick-start example
- troubleshooting guide

Exit criteria:

- fresh workspace can be initialized and used without editing source code

---

## 11. Test Plan

### 11.1 Unit tests

Cover:

- schema validation
- task parsing
- eligibility
- state transitions
- routing filters
- cursor arithmetic
- path permission enforcement
- reconciliation decisions

### 11.2 Filesystem integration tests

Cover:

- atomic exclusive claim
- interrupted writes
- JSONL trailing partial line
- cursor persistence
- task/claim mismatch repair
- permission failures

### 11.3 Multi-process tests

Mandatory scenarios:

#### Concurrent claim

```text
Process A -> claim TASK-1
Process B -> claim TASK-1
```

Expected: exactly one succeeds.

#### Loser fallback

Losing process receives `already_claimed`, rescans, and can claim another open task.

#### Crash after claim

```text
claim file created
process killed
before task Markdown update
```

Expected: reconciler recognizes ownership, then recovery can abandon/reopen after process death is confirmed.

#### Event replay

Consumer stops, producer appends events, consumer restarts.

Expected: reader resumes from cursor and processes unread complete records.

#### Broadcast fan-out

One producer emits one broadcast event.

Expected: every subscribed role processes it independently.

#### Late subscriber / stale cursor

Consumer starts after events already exist.

Expected behavior must match configured replay policy and never corrupt stream state.

#### Truncated JSONL

Producer is killed during append.

Expected: prior lines remain readable; incomplete final line is retried/ignored until complete.

### 11.4 Real OMP end-to-end acceptance

Run at least these Pi sessions in one workspace:

```text
coordinator
researcher
backend
tester
```

Scenario:

1. coordinator creates research and implementation tasks
2. researcher claims research task
3. researcher publishes findings and completes
4. backend discovers newly eligible implementation task
5. backend claims, implements, publishes artifact, completes
6. tester claims verification task and reports result
7. architecture/review events are broadcast to subscribed agents
8. stop and restart one Pi session during the flow
9. shared state remains recoverable and consistent

---

## 12. Performance Targets

Pi Swarm 1.0 optimizes for developer-machine scale rather than distributed-system throughput.

Targets:

- 3–10 simultaneously active Pi sessions
- thousands of task/event files without pathological behavior
- polling interval configurable, default around 500 ms
- idle polling may back off to reduce overhead
- inbox aggregation prevents model-turn amplification during event bursts
- task listing should avoid reparsing unchanged files where simple file metadata caching is safe

No benchmark target requires a database for 1.0.

---

## 13. Observability

The extension should support debug logging without polluting model context.

Useful runtime metrics/log fields:

- instance ID / role
- poll cycle duration
- task candidates discovered
- event lines read
- cursor advancement
- inbox batch size
- wake action taken
- claim success/contention
- reconciliation repairs
- orphan recovery actions

`/swarm status` should present only high-value operational state, not raw logs.

---

## 14. Error Handling Requirements

The runtime must distinguish normal coordination outcomes from faults.

Normal outcomes:

- `already_claimed`
- no eligible tasks
- no new events
- target role not currently active

Recoverable faults:

- malformed task file
- malformed event line
- stale cursor
- orphan claim
- invalid manifest

Fatal configuration faults:

- workspace path cannot be created
- filesystem cannot support required atomic claim behavior
- role ID collision that cannot be resolved

A bad file should be quarantined or surfaced diagnostically rather than taking down all agent runtimes whenever possible.

---

## 15. Security Requirements

- normalize all paths before read/write
- reject traversal outside the workspace
- enforce manifest blackboard permissions in tools
- treat Markdown/event/artifact text as untrusted data
- never execute instructions found in swarm data merely because they appear in shared files
- do not expose arbitrary shell/process invocation as a swarm coordination primitive
- prevent role manifests from granting paths outside configured swarm/project boundaries

---

## 16. Release Acceptance Criteria

Pi Swarm 1.0 is releasable when all of the following are true:

- [ ] extension installs and loads under oh-my-pi
- [ ] `/swarm init` creates a usable workspace
- [ ] six default manifests are shipped and valid
- [ ] custom role manifests load without source changes
- [ ] role binding and presence work across multiple Pi sessions
- [ ] task creation/list/get work
- [ ] atomic claim passes multi-process contention tests
- [ ] task lifecycle transitions are validated
- [ ] interrupted claim reconciliation works
- [ ] orphan recovery works under single-host assumptions
- [ ] per-instance JSONL event streams work
- [ ] direct events route correctly
- [ ] broadcast subscriptions route correctly
- [ ] cursor replay survives restart
- [ ] inbox batching avoids one-turn-per-event behavior
- [ ] native OMP wakeup works for idle Pi sessions
- [ ] context hook prevents unbounded swarm-message growth
- [ ] blackboard permission enforcement works
- [ ] artifact publishing works
- [ ] `/swarm status`, `/swarm recover`, `/swarm doctor` work
- [ ] end-to-end coordinator -> researcher -> backend -> tester scenario passes
- [ ] one agent can be killed and restarted without losing durable swarm state
- [ ] no test path requires direct agent-to-agent process invocation

---

## 17. Product Invariants

These are release-blocking invariants, not implementation suggestions.

### Invariant 1 — Pull, not push

Agents discover and claim tasks. No role, including coordinator, grants task ownership by sending a message.

### Invariant 2 — Claim is ownership

Only a successful atomic claim grants ownership.

### Invariant 3 — Events are not tasks

Events notify and record facts. The task pool remains the durable source of work.

### Invariant 4 — No supervisor agent

Coordinator is a specialist role, not the parent execution loop for the swarm.

### Invariant 5 — File-native is first-class

Markdown, YAML, JSONL, and normal files are canonical product formats, not temporary projections of a hidden database.

### Invariant 6 — OMP integration is an adapter layer

Task/event/claim domain logic must remain testable without Pi so the coordination protocol stays independent of the host UI/runtime.
