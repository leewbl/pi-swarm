# Pi Swarm

Pi Swarm is a file-native multi-agent coordination runtime for
[oh-my-pi](https://oh-my-pi.dev): multiple independent Pi sessions in one
workspace collaborate as specialized agents through a shared pull-based task
pool, atomic filesystem task claims, append-only JSONL event streams, and a
Markdown blackboard. There is no supervisor LLM and no direct
agent-to-agent invocation — coordination happens entirely through files under
`.pi/swarm/`.

## Install

Clone the repo, then load it as an oh-my-pi extension — either add it to
`~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/pi-swarm
```

or start Pi with it once:

```sh
omp -e /path/to/pi-swarm
```

The extension entrypoint is `src/extension/index.ts` (see `package.json` →
`omp.extensions`); no build step is required.

## Quickstart

1. **Initialize the workspace** (creates `.pi/swarm/`, the default config, and
   the six built-in role manifests — never overwriting existing files):

   ```
   /swarm init
   ```

2. **Bind a session to a role** in your first Pi window:

   ```
   /swarm role coordinator
   ```

   The coordinator asks you for goals and creates open tasks for the other
   roles (`swarm_task_create`). It never claims tasks itself and never invokes
   another agent process directly.

3. **Bind other roles** in additional Pi windows opened in the same workspace:

   ```
   /swarm role backend
   ```

4. **Discover and claim work.** Each agent lists tasks it may claim and
   claims atomically — contention (`already_claimed`) is normal flow:

   ```
   swarm_task_list
   swarm_task_claim  { taskId: "TASK-0001" }
   swarm_task_start  { taskId: "TASK-0001", claimId: "CLM-..." }
   swarm_task_complete { taskId: "TASK-0001", claimId: "CLM-...", summary: "..." }
   ```

   Agents coordinate with `swarm_event_emit` (direct `toRole` or broadcast
   `topic`), share knowledge on the blackboard (`swarm_blackboard_read` /
   `swarm_blackboard_write`, permission-checked per manifest), and publish
   large outputs with `swarm_artifact_publish`. Run `/swarm agents` to see the
   available roles; add custom roles by dropping a new
   `agents/<role>.yaml` manifest — no code changes needed.

## Commands

| Command | Purpose |
| --- | --- |
| `/swarm init` | create or repair the workspace and install default manifests |
| `/swarm role <role>` | bind this session to a role (duplicate live instances are blocked) |
| `/swarm status` | bound role/instance, runtime state, task counts, presence table |
| `/swarm tasks` | all tasks with status, priority, title, and claimant |
| `/swarm agents` | role manifests and live instances |
| `/swarm recover [taskId]` | scan, reconcile claim/task drift, recover orphans |
| `/swarm doctor` | read-only diagnostics (layout, manifests, JSONL, cursors, fs capability) |

## Troubleshooting

- **"Role X already has an active instance"** — another live Pi session holds
  that role (fresh heartbeat + alive pid). Bind this session to a different
  role, or stop the other session. Restarting a crashed session re-binds
  automatically from session history.
- **`/swarm doctor` reports errors** — run it for categorized findings with
  remediation hints: missing layout (`/swarm init` repairs), invalid
  manifests/tasks, duplicate active instances, claim/task drift and orphan
  claims (`/swarm recover`), malformed or truncated event JSONL, stale
  cursors, and filesystem atomic-create capability.
- **A task never appeared / an event was missed** — events are notifications,
  never the source of work. The task pool is durable: agents always rescan
  tasks; a missed event cannot make a task undiscoverable.
- **Recovery** — a task whose claimant crashed (stale heartbeat AND confirmed
  dead pid) can be abandoned and reopened via `/swarm recover`; live-but-suspect
  claimants are surfaced but never auto-recovered.

## Design docs

See `pi-swarm-1.0/pi-swarm-1.0-architecture.md` (architecture, protocol,
invariants) and `pi-swarm-1.0/pi-swarm-1.0-prd.md` (requirements and test
plan) for the full specification.
