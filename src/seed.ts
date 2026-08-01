import { pool } from "./db.js";

async function main() {
  await pool.query(
    `TRUNCATE incident_escalations, orders, payments, customers RESTART IDENTITY CASCADE`
  );

  const { rows: customers } = await pool.query<{ id: string }>(
    `INSERT INTO customers (email, name) VALUES
      ('asha@example.com', 'Asha Verma'),
      ('rohit@example.com', 'Rohit Nair'),
      ('meera@example.com', 'Meera Iyer'),
      ('vikram@example.com', 'Vikram Shah')
     RETURNING id`
  );
  const [asha, rohit, meera, vikram] = customers.map((c) => c.id);

  // Scenario 1: confirmed incident — captured 30 min ago, no order.
  await pool.query(
    `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
     VALUES ($1, 'chk_incident_001', 'pay_ref_001', 1499.00, 'INR', 'captured', 'razorpay', now() - interval '30 minutes')`,
    [asha]
  );

  // Scenario 2: healthy — captured, order exists.
  await pool.query(
    `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
     VALUES ($1, 'chk_healthy_002', 'pay_ref_002', 2599.00, 'INR', 'captured', 'razorpay', now() - interval '1 hour')`,
    [rohit]
  );
  await pool.query(
    `INSERT INTO orders (customer_id, checkout_reference, status) VALUES ($1, 'chk_healthy_002', 'created')`,
    [rohit]
  );

  // Scenario 3: within buffer window — captured 1 minute ago, no order yet (not an incident yet).
  await pool.query(
    `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
     VALUES ($1, 'chk_buffer_003', 'pay_ref_003', 899.00, 'INR', 'captured', 'stripe', now() - interval '1 minute')`,
    [meera]
  );

  // Scenario 4: not eligible — payment failed, never investigated regardless of order state.
  await pool.query(
    `INSERT INTO payments (customer_id, checkout_reference, payment_reference, amount, currency, status, provider, captured_at)
     VALUES ($1, 'chk_failed_004', 'pay_ref_004', 3200.00, 'INR', 'failed', 'stripe', NULL)`,
    [vikram]
  );

  console.log("Seed complete. checkout_references:");
  console.log("  chk_incident_001  -> confirmed incident (captured, no order, buffer elapsed)");
  console.log("  chk_healthy_002   -> healthy (order exists)");
  console.log("  chk_buffer_003    -> not yet eligible (within buffer window)");
  console.log("  chk_failed_004    -> not eligible (payment not captured)");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
