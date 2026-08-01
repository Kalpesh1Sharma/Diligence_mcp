# AI Worklog

## Tools and models used

- **Claude (Anthropic)**, used through a single ongoing chat conversation, for
  everything: planning, product/schema decisions with the client, code
  generation, running and debugging the code in a sandboxed environment,
  and README/worklog drafting.
- I didn't split work across multiple AI tools (no separate Copilot/ChatGPT
  usage) — kept everything in one place so context carried through the whole
  build instead of getting fragmented across tools.

## How the work was actually split

AI generated the initial implementation for essentially all of the code (schema, investigation logic, MCP server, tests, and seed data). I treated that output as a starting point rather than a finished product, verifying every stage locally, incorporating client feedback, and iterating on the design and implementation until it matched the agreed workflow.

- **Every product decision.** What incident to scope to, what to explicitly
  cut (inventory, fulfillment) and why, what to push back on when Deepak's
  feedback came in, when a draft was actually ready to send versus needed
  another pass. This went through four rounds of client review before the
  schema was approved — I decided what to send each round, not the AI.
- **All independent verification.** I ran install/migrate/seed/test/deploy
  myself, on my own machine, against my own Neon database — not just
  trusting that a sandbox run elsewhere meant it would work for me too.
- **Questioning things that looked off**, even when they turned out to be
  fine — e.g. asking whether the pooled Neon connection string mattered,
  whether Render needed a manual `PORT` variable, why a raw `GET /mcp`
  returned an error. Not every question surfaced a bug, but the habit of
  checking rather than assuming is what caught the one that did matter
  (below).

## How AI was used to plan and break the work down

Work was broken into a sequence that mirrored how the client actually
wanted to be engaged: propose scope → get feedback → narrow the trigger and
outcome → propose a schema → get feedback → revise the schema (multiple
rounds) → get approval → implement → test → deploy → verify. AI helped turn
each round of the client's feedback into concrete technical changes (e.g.
"define the correlation key" turned into the `checkout_reference` design;
"enforce deduplication atomically" turned into the partial unique index).
Implementation itself was scaffolded end-to-end in one pass — schema,
core logic, MCP server, seed data, tests — then verified step by step
rather than trusting it blind.

## Important context supplied

The full text of the assignment brief, and every round of the client's
email feedback, was given directly rather than summarized, so decisions
were made against Deepak's actual wording rather than a paraphrase.

## An AI suggestion I substantially changed

The AI-generated implementation of the `wasDuplicate` check needed correction after verification. It compared two PostgreSQL timestamps using `!==` in TypeScript. Because the PostgreSQL driver returns `timestamptz` columns as JavaScript `Date` objects, `!==` compares object references rather than time values, so the check incorrectly evaluated to `true` even for newly created rows.

This was caught by a test asserting the expected behavior (`false` on first creation). The implementation was updated to compare `.getTime()` values instead.

## A bug I found myself, that the AI's own testing hadn't caught

Separately from that, I ran into a real test failure independently: after
seeding my Neon database, running the server locally, and testing the
health check by hand, `npm test` failed on the "within buffer window"
scenario — the code said `incident_confirmed` where the test expected
`not_eligible`. This didn't happen in the AI's own sandbox testing, only in
mine, because it depended on how much real time had passed between seeding
and testing. I reported the exact failing output, and we diagnosed
together that the test's fixture data (`captured_at = now() - interval '1
minute'`, set once at seed time) had aged past the 5-minute buffer window
by the time I got around to running the tests — meaning the *code* was
behaving correctly and the *test's assumption about elapsed time* was
wrong. The fix was to have the test suite seed that specific scenario
fresh, immediately before asserting on it, instead of depending on
`npm run seed` having been run recently.

## How AI-generated work was verified

- Every migration, seed script, and test was actually run against a real
  Postgres database (locally in development, then against the same Neon
  instance used in production) — not just read and trusted.
- The MCP server was tested at the protocol level, not just via unit tests:
  a real `initialize` → `tools/call` handshake, first locally, then again
  against the live Render deployment, confirming the whole stack (Render →
  Neon) actually works end to end, not just in isolation.
- The concurrency guarantee (no duplicate escalations under simultaneous
  investigations) was verified with an actual test that fires 10 parallel
  requests at the same incident and checks the row count afterward, rather
  than trusting the SQL looked correct on paper.
- I can now personally explain, in detail, why each of the two bugs above
  happened and why their fixes work — the `Date` reference-equality issue
  and the buffer-window timing issue — rather than treating the fixes as
  a black box.

## Remaining risks / unfinished work

- MCP session state is held in memory in `server.ts`. Fine for a single
  Render instance; would need a shared session store for a multi-instance
  deployment.
- Only one incident type is modeled. `incident_type` exists as a column
  specifically so more types can be added without a schema migration, but
  none are implemented yet.
- No authentication on the MCP endpoint — intentional per the assignment's
  explicit scope guidance, but not how this would ship in a real
  deployment.
