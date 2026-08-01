# Commerce Incident Investigator (MCP Server)

An AI-native operations tool for a single, well-bounded commerce incident:
**a payment was captured, but no corresponding order was created.**

Built for the DiligenceAI take-home assignment. The MCP server is the
product — an AI agent uses it to investigate the incident, gather evidence,
and produce a durable, human-reviewable escalation. It never takes
corrective action on its own.

## The workflow

1. A customer reports "I paid but never got an order confirmation."
2. An AI agent (e.g. an ops-facing chat assistant) calls
   `investigate_payment_incident` with the `checkout_reference` from the
   customer's payment.
3. The MCP server checks, read-only: is the payment captured? has the
   documented buffer window elapsed? does a matching order exist?
4. If it's a confirmed incident, the server creates (or updates) a durable
   `incident_escalations` record with evidence, a confidence level, and a
   recommended manual action — for a human on the ops team to act on.
5. The agent can also list all open escalations (`list_open_escalations`)
   or check on one specific incident (`get_escalation_status`).

The MCP never recreates orders, retries/voids/captures/refunds payments,
or otherwise mutates payment or processor state. Every confirmed incident
becomes a review item for a person, not an automated action.

## Domain model

See `migrations/001_init.sql`. Key points:

- `payments` and `orders` both carry a `checkout_reference` — a stable
  identifier generated at checkout time and propagated to both the payment
  provider and order-creation step. This is what lets the investigation
  deterministically match (or fail to match) a payment to an order,
  instead of inferring it from customer identity.
- `incident_escalations.status` has a **partial unique index** on
  `checkout_reference` scoped to `status IN ('open', 'acknowledged')`. This
  is what makes re-investigation and concurrent investigations safe:
  Postgres itself guarantees at most one *active* escalation per
  checkout_reference, via `INSERT ... ON CONFLICT ... DO UPDATE`, rather
  than relying on application-level check-then-write logic.
- A 5-minute buffer window between payment capture and "no order = incident"
  is a **documented synthetic-demo assumption**, not a business policy —
  it exists to avoid false positives from normal asynchronous order
  creation. See `BUFFER_MINUTES` in `src/investigate.ts`.

## What's in scope / out of scope

**In scope:** one incident type (captured payment, no order), read-only
investigation, durable human-review escalation, re-investigation /
concurrency safety, auto-resolution when a delayed order later appears.

**Explicitly out of scope** (per assignment guidance and review
discussion with the client):
- Inventory and fulfillment data — not needed for this specific trigger;
  including them without a concrete evidentiary use would add complexity
  without a clear payoff.
- Authentication, a frontend, or a full commerce backend.
- Any automated corrective action (order recreation, refunds, retries).

## Project structure

```
migrations/001_init.sql   -- schema (tables + partial unique index)
src/db.ts                 -- Postgres pool
src/migrate.ts             -- migration runner
src/seed.ts                -- synthetic data: 4 scenarios
src/investigate.ts         -- core investigation logic (framework-agnostic)
src/server.ts               -- MCP server (3 tools) over Streamable HTTP
tests/investigate.test.ts   -- integration tests against a real Postgres DB
```

## Local setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL
npm run migrate
npm run seed
npm run dev             # starts the MCP server on :3000
```

Health check: `GET /healthz`. MCP endpoint: `POST /mcp` (Streamable HTTP,
session-based — clients must call `initialize` before `tools/call`).

## Tests

```bash
npm test
```

Covers all four seed scenarios (confirmed incident, healthy, within-buffer,
non-captured payment), re-investigation updating rather than duplicating an
escalation, auto-resolution once a delayed order appears, and — most
importantly — **10 concurrent investigations of the same incident
resulting in exactly one escalation row**, verifying the atomic dedup
guarantee actually holds under real concurrent access rather than just
looking correct on paper.

## Deployment (Render + Neon)

1. **Database:** create a free Neon Postgres project. Copy its connection
   string into `DATABASE_URL`.
2. Run migration + seed once, locally, against the Neon connection string:
   ```bash
   DATABASE_URL="<neon-connection-string>" npm run migrate
   DATABASE_URL="<neon-connection-string>" npm run seed
   ```
3. **Server:** create a new Render Web Service from this repo.
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
   - Environment variable: `DATABASE_URL` = the same Neon connection string
4. Once deployed, the MCP endpoint is `https://<your-render-app>.onrender.com/mcp`.

## Seed data (for the demo)

| checkout_reference   | Scenario                                   |
|-----------------------|---------------------------------------------|
| `chk_incident_001`    | Confirmed incident (captured, no order, buffer elapsed) |
| `chk_healthy_002`     | Healthy — order exists                      |
| `chk_buffer_003`      | Not yet eligible — within buffer window     |
| `chk_failed_004`      | Not eligible — payment never captured       |

## Known limitations / next steps

- Sessions are held in-memory in `server.ts`; a multi-instance deployment
  would need a shared session store. Fine for this single-instance demo.
- Only one incident type is modeled. The `incident_type` column exists to
  make adding more incident types later straightforward without a schema
  change.
- No authentication on the MCP endpoint, per the assignment's explicit
  scope guidance.
