import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { setupTestDatabase, teardownTestDatabase } from "./testDb.js";
import { investigatePaymentIncident, getEscalationStatus, listOpenEscalations } from "../src/investigate.js";

// This suite is self-contained: setupTestDatabase() launches a real,
// ephemeral Postgres container (via Testcontainers) and applies the actual
// migration file, so no reviewer needs their own DATABASE_URL, Neon
// account, or manual Postgres setup — only a running Docker daemon.
//
// The "within buffer window" scenario is inherently time-relative —
// captured_at is set to "1 minute ago" relative to *now*, right before the
// assertion runs, so there's no gap for it to decay into a false "buffer
// elapsed" result if the test run is delayed.
let pool: Pool;
let customerId: string;

beforeAll(async () => {
  pool = await setupTestDatabase();

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO customers (email, name) VALUES ('test@example.com', 'Test Customer') RETURNING id`
  );
  customerId = rows[0].id;

  await pool.query(
    `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
     VALUES
       ($1, 'chk_incident_001', 'pay_ref_001', 1499.00, 'INR', 'captured', 'razorpay', now() - interval '30 minutes'),
       ($1, 'chk_healthy_002', 'pay_ref_002', 2599.00, 'INR', 'captured', 'razorpay', now() - interval '1 hour'),
       ($1, 'chk_failed_004', 'pay_ref_004', 3200.00, 'INR', 'failed', 'stripe', NULL)`,
    [customerId]
  );
  await pool.query(
    `INSERT INTO orders (customer_id, checkout_reference, status) VALUES ($1, 'chk_healthy_002', 'created')`,
    [customerId]
  );
}, 60_000); // container startup can take a while on first run (image pull)

describe("investigatePaymentIncident", () => {
  afterAll(async () => {
    await teardownTestDatabase();
  });

  it("confirms an incident when payment is captured, buffer elapsed, and no order exists", async () => {
    const result = await investigatePaymentIncident(pool, "chk_incident_001");
    expect(result.status).toBe("incident_confirmed");
    if (result.status === "incident_confirmed") {
      expect(result.classification).toBe("payment_captured_no_order");
      expect(result.confidence).toBe("high");
      expect(result.wasDuplicate).toBe(false);
    }
  });

  it("marks as resolved when an order exists for the checkout_reference", async () => {
    const result = await investigatePaymentIncident(pool, "chk_healthy_002");
    expect(result.status).toBe("resolved");
  });

  it("is not eligible when still within the buffer window", async () => {
    await pool.query(
      `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
       VALUES ($1, 'chk_buffer_003', 'pay_ref_003', 899.00, 'INR', 'captured', 'stripe', now() - interval '1 minute')`,
      [customerId]
    );
    const result = await investigatePaymentIncident(pool, "chk_buffer_003");
    expect(result.status).toBe("not_eligible");
    if (result.status === "not_eligible") {
      expect(result.reason).toMatch(/buffer window/i);
    }
  });

  it("is not eligible when the payment was never captured", async () => {
    const result = await investigatePaymentIncident(pool, "chk_failed_004");
    expect(result.status).toBe("not_eligible");
    if (result.status === "not_eligible") {
      expect(result.reason).toMatch(/not 'captured'/);
    }
  });

  it("returns not_found for an unknown checkout_reference", async () => {
    const result = await investigatePaymentIncident(pool, "chk_does_not_exist");
    expect(result.status).toBe("not_found");
  });

  it("re-investigating an existing open incident updates it rather than duplicating it", async () => {
    const first = await investigatePaymentIncident(pool, "chk_incident_001");
    expect(first.status).toBe("incident_confirmed");

    const second = await investigatePaymentIncident(pool, "chk_incident_001");
    expect(second.status).toBe("incident_confirmed");
    if (second.status === "incident_confirmed") {
      expect(second.wasDuplicate).toBe(true);
      if (first.status === "incident_confirmed") {
        expect(second.escalationId).toBe(first.escalationId);
      }
    }

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM incident_escalations WHERE checkout_reference = 'chk_incident_001'`
    );
    expect(rows[0].n).toBe(1);
  });

  it("enforces the dedup guarantee even under concurrent investigations", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => investigatePaymentIncident(pool, "chk_incident_001"))
    );
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM incident_escalations WHERE checkout_reference = 'chk_incident_001'`
    );
    expect(rows[0].n).toBe(1);
  });

  it("auto-resolves a previously open escalation once an order appears", async () => {
    await pool.query(
      `INSERT INTO customers (email, name) VALUES ('late@example.com', 'Late Order Customer') RETURNING id`
    );
    const { rows: cust } = await pool.query(`SELECT id FROM customers WHERE email = 'late@example.com'`);
    const customerId = cust[0].id;

    await pool.query(
      `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
       VALUES ($1, 'chk_late_order_005', 'pay_ref_005', 500, 'INR', 'captured', 'razorpay', now() - interval '30 minutes')`,
      [customerId]
    );

    const before = await investigatePaymentIncident(pool, "chk_late_order_005");
    expect(before.status).toBe("incident_confirmed");

    await pool.query(
      `INSERT INTO orders (customer_id, checkout_reference, status) VALUES ($1, 'chk_late_order_005', 'created')`,
      [customerId]
    );

    const after = await investigatePaymentIncident(pool, "chk_late_order_005");
    expect(after.status).toBe("resolved");

    const escalation = await getEscalationStatus(pool, "chk_late_order_005");
    expect(escalation?.status).toBe("resolved");
  });

  it("lists only open/acknowledged escalations", async () => {
    const open = await listOpenEscalations(pool, 50);
    const refs = open.map((r: any) => r.checkout_reference);
    expect(refs).toContain("chk_incident_001");
    expect(refs).not.toContain("chk_late_order_005");
  });
});