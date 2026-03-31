# Sanity Flow Model & Planner

This folder contains the core building blocks for **Step 3 – Flow Model** and **Step 4 – Replay Planner** of the QA Sanity system.

## Flow Model (`flow_model.js`)
- Defines enums: priority, criticality, fallback strategies, step types.
- Validators: `validateFlow`, `validateFlowStep` to guard API inputs.
- `flowFromNormalized(normalized, opts)` promotes `normalized.json` (output of the normalization pipeline) into a first‑class Flow record plus FlowSteps ready for persistence.
- Selector enrichment: builds priority‑ordered selector list (CSS → text → coordinates) and default fallback per step type.
- Expected outcome: derives from hard assertions discovered during normalization.

### Flow schema (persisted)
- `flow_id`, `flow_name`, `module`, `feature`, `priority`, `criticality`, `tags`, `owner`, `version`, `description`, `source_session_id`, timestamps.

### Step schema (persisted)
- `step_id`, `flow_id`, `step_index`, `step_name`, `intent`, `step_type`, `selectors[]`, `expected_outcome`, `assertions[]`, `fallback_strategy`, `wait_strategy (optional)`, `meta`.

## Replay Planner (`engine/planner.js`)
- `createPlan(flow, steps)` converts a stored Flow into an **ExecutionPlan** that the replay engine can consume deterministically.
- Adds per‑step:
  - `selector_chain` (priority‑sorted selectors)
  - `wait_strategy` defaults (network_idle / network_settle / element_visible / dom_change / none)
  - `retry_config` tuned by step type
  - implicit assertions (no network failures, no JS errors where relevant)
  - `fallback` strategy
- Outputs: `{ plan_id, flow_id, flow_version, created_at, total_steps, steps: [...] }`.

## How to wire into APIs (next actions)
1. **Persist flows**: add `flows` and `flow_steps` tables to `db.js` plus small DAO helpers (createFlow, listFlows, getFlowWithSteps, updateFlowVersion).
2. **API surface** (Express):
   - `POST /flows/from-session/:sessionId` → run normalization (if needed), call `flowFromNormalized`, persist flow + steps.
   - `GET /flows` / `GET /flows/:id` → list + fetch with steps.
   - `POST /flows/:id/plan` → fetch flow+steps, call `createPlan`, return JSON.
3. **Replay path**: extend `ReplayEngine` to accept `ExecutionPlan` (selector_chain, wait_strategy, retry_config) and map plan steps to Playwright actions. Keep legacy raw‑event replay for backward compatibility.
4. **Release workflow hook**: allow passing `flow_id` list into CI job that generates plans and executes them headlessly, returning per‑flow pass/fail + failure metadata.

## Usage snippet
```js
const { flowFromNormalized } = require('./flow_model');
const { createPlan } = require('../engine/planner');

const { flow, steps } = flowFromNormalized(normalized, { flow_name: 'Checkout – happy path' });
const plan = createPlan(flow, steps);
// persist {flow, steps} and schedule plan for replay
```

This doc is intentionally concise so engineering can hook the model + planner into storage and APIs without digging through code.
