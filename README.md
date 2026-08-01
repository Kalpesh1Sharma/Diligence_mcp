# Commerce Incident Investigator

MCP server for the DiligenceAI take-home assignment. It handles one specific
commerce incident: **a customer's payment was captured, but no order was
ever created for it.**

The MCP server is the actual product here, not a wrapper around one. An AI
agent calls it to investigate the incident, pull together evidence, and
raise a human-review escalation. It doesn't take any corrective action
itself — no recreating orders, no touching payments. That part stays with
a person on the ops team.

## Why this incident, specifically

Payment-order mismatches are one of the more common things an ops team
gets pulled into: a webhook fails, a race condition hits between capture
and order creation, a retry gets mishandled somewhere upstream. It's also
narrow enough to build and verify properly in the time given, rather than
sprawling into a general-purpose "investigate anything" tool that ends up
shallow everywhere.

## How it works

1. Customer says "I paid but never got a confirmation."
2. An agent calls `investigate_payment_incident` with the `checkout_reference`
   from their payment.
3. The server looks up the payment and the order — read-only. Is the
   payment actually captured? Has enough time passed that this isn't just
   normal async delay? Does a matching order exist at all?
4. If all three point to a real incident, it writes an `incident_escalations`
   row: evidence, a confidence level, a recommended next step. That's the
   review item a human picks up.
5. `list_open_escalations` gives the ops team a queue. `get_escalation_status`
   checks in on one specific case.

## The schema decisions that mattered

Full schema is in `migrations/001_init.sql`, but two things are worth
calling out because they went through a few rounds of revision before
landing:

**The correlation key.** Early on I was matching payments to orders through
customer identity, which doesn't actually work — a customer can have
several payments and orders, so there's no way to say *this* payment should
map to *that* order. Fixed it with a `checkout_reference`: generated once
at checkout, stamped on both the payment and the order it produces. Now the
investigation has something deterministic to match against instead of
guessing.

**Duplicate escalations under concurrent investigations.** If the same
incident gets investigated twice — a retry job overlapping with a manual
recheck, say — naive "check if it exists, then insert" logic can still
race and create two escalations for one incident. I added a partial unique
index on `incident_escalations (checkout_reference) WHERE status IN
('open', 'acknowledged')`, paired with `INSERT ... ON CONFLICT ... DO
UPDATE`. That pushes the guarantee down into Postgres itself instead of
trusting application code to get the timing right. Verified this isn't
just theoretical — there's a test that fires 10 concurrent investigations
at the same incident and checks exactly one row exists afterward.

The 5-minute buffer between "payment captured" and "treat missing order as
an incident" is a documented assumption for this demo, not a real business
policy — it exists so normal async order-creation delay doesn't get
flagged as a false incident. It's the `BUFFER_MINUTES` constant in
`src/investigate.ts` if it needs tuning.

## What I left out, and why

- **Inventory and fulfillment data.** I went back and forth on this with
  the client during scoping. For this specific trigger (payment captured,
  order missing) there wasn't a concrete piece of inventory evidence that
  would change the classification without modeling a separate reservation
  step this workflow doesn't have. Rather than bolt it on for the sake of
  looking thorough, I cut it.
- **Auth, a frontend, a real commerce backend.** Explicitly out of scope
  per the assignment.
- **Any automated fix.** The server investigates and escalates. It never
  recreates an order or touches a payment. That's a deliberate line, not
  a missing feature.

## Project layout

```
migrations/001_init.sql     schema — tables + the partial unique index
src/db.ts                   Postgres pool
src/migrate.ts               migration runner
src/seed.ts                  synthetic data covering 4 scenarios
src/investigate.ts           the actual investigation logic, kept separate
                              from the MCP/transport layer so it's testable
                              on its own
src/server.ts                MCP server, 3 tools, Streamable HTTP
src/smoke-test.ts            reproducible hosted-protocol check — see below
tests/investigate.test.ts    integration tests against a real Postgres DB
```

## Running it locally

```bash
npm install
cp .env.example .env    # add your DATABASE_URL
npm run migrate
npm run seed
npm run dev              # server on :3000
```

`GET /healthz` for a basic check. The actual MCP endpoint is `POST /mcp`
(Streamable HTTP — it's session-based, so a client needs to call
`initialize` before it can call any tool).

## Tests

```bash
npm test
```

Nine tests, all against a real database rather than mocks: the four seed
scenarios, re-investigating an incident updates the existing escalation
instead of duplicating it, an escalation auto-resolves once a delayed order
shows up, and the concurrency test mentioned above.

One thing I caught while running these against Neon: the "within buffer
window" scenario is inherently time-relative (it depends on how long ago
the payment was seeded), so if you run `seed` and then run the tests
several minutes later, that scenario can quietly become stale and the test
fails — correctly, because the underlying behavior is actually right, the
test data just aged out of the window it was meant to represent. Fixed by
having the test suite seed that specific case fresh, immediately before
asserting on it, instead of depending on `npm run seed` having been run
recently.

## Hosted-protocol smoke check

The test suite above runs the investigation logic directly against Postgres.
It doesn't prove the *deployed* MCP endpoint itself actually speaks the
protocol correctly over the network. This script does — it initializes a
real MCP session against a live URL, lists the tools, calls
`investigate_payment_incident`, and writes the raw request/response pairs
to `smoke-test-output.json` so the result is inspectable and reproducible,
not just something I ran once and pasted into a chat.

```bash
MCP_URL="https://<your-app>.onrender.com/mcp" npm run smoke:hosted
```

Defaults to `http://localhost:3000/mcp` if `MCP_URL` isn't set. Exits
non-zero if the deployed server doesn't respond as expected, so it can
also be used as a basic post-deploy health check.

## Deploying (Render + Neon)

1. Spin up a free Neon Postgres project, grab the connection string.
2. Run migrate + seed against it once, locally:
   ```bash
   DATABASE_URL="<neon-connection-string>" npm run migrate
   DATABASE_URL="<neon-connection-string>" npm run seed
   ```
3. New Render Web Service, pointed at this repo:
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Env var: `DATABASE_URL` (same Neon string — don't set `PORT`, Render
     assigns its own and the server already reads `process.env.PORT`)
4. MCP endpoint ends up at `https://<your-app>.onrender.com/mcp`.

## Seed data

| checkout_reference  | What it represents                             |
|----------------------|-------------------------------------------------|
| `chk_incident_001`   | Confirmed incident — captured, no order, buffer elapsed |
| `chk_healthy_002`    | Healthy — order exists                          |
| `chk_buffer_003`     | Too soon to tell — still inside the buffer window |
| `chk_failed_004`     | Not eligible — payment was never captured       |

## What's not done / what I'd do next

- Session state in `server.ts` is in-memory, which is fine for one
  instance but wouldn't survive a multi-instance deployment — would need
  a shared store (Redis, or similar) for that.
- Only one incident type exists right now. `incident_type` is already a
  column on `incident_escalations` specifically so more types can be added
  later without a schema migration.
- No auth on the MCP endpoint — intentional, per the assignment's scope
  guidance, but obviously not how this would ship in a real deployment.
