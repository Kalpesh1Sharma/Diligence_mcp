import type { Pool } from "pg";


export const BUFFER_MINUTES = 5;

export type IncidentResult =
  | { status: "not_found" }
  | { status: "not_eligible"; reason: string }
  | { status: "resolved"; reason: string; checkoutReference: string }
  | {
      status: "incident_confirmed";
      checkoutReference: string;
      escalationId: string;
      classification: string;
      confidence: "low" | "medium" | "high";
      recommendedAction: string;
      evidence: Record<string, unknown>;
      wasDuplicate: boolean;
    };

interface PaymentRow {
  id: string;
  checkout_reference: string;
  payment_reference: string;
  status: string;
  amount: string;
  currency: string;
  provider: string;
  captured_at: string | null;
}

interface OrderRow {
  id: string;
  checkout_reference: string;
  status: string;
  created_at: string;
}


export async function investigatePaymentIncident(
  pool: Pool,
  checkoutReference: string
): Promise<IncidentResult> {
  const paymentRes = await pool.query<PaymentRow>(
    `SELECT id, checkout_reference, payment_reference, status, amount, currency, provider, captured_at
     FROM payments WHERE checkout_reference = $1`,
    [checkoutReference]
  );

  const payment = paymentRes.rows[0];
  if (!payment) {
    return { status: "not_found" };
  }

  if (payment.status !== "captured") {
    return {
      status: "not_eligible",
      reason: `Payment status is '${payment.status}', not 'captured'. Only captured payments are investigated.`,
    };
  }

  const capturedAt = new Date(payment.captured_at!);
  const bufferElapsedAt = new Date(capturedAt.getTime() + BUFFER_MINUTES * 60_000);
  const now = new Date();

  const orderRes = await pool.query<OrderRow>(
    `SELECT id, checkout_reference, status, created_at FROM orders WHERE checkout_reference = $1`,
    [checkoutReference]
  );
  const order = orderRes.rows[0];

  if (order) {
    
    await pool.query(
      `UPDATE incident_escalations
       SET status = 'resolved', updated_at = now()
       WHERE checkout_reference = $1 AND status IN ('open', 'acknowledged')`,
      [checkoutReference]
    );
    return {
      status: "resolved",
      reason: "A matching order now exists for this checkout_reference.",
      checkoutReference,
    };
  }

  if (now < bufferElapsedAt) {
    return {
      status: "not_eligible",
      reason: `Payment was captured at ${capturedAt.toISOString()}; the ${BUFFER_MINUTES}-minute buffer window has not yet elapsed. This may be normal asynchronous order creation, not an incident.`,
    };
  }

  
  const evidence = {
    checkout_reference: checkoutReference,
    payment: {
      id: payment.id,
      payment_reference: payment.payment_reference,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      provider: payment.provider,
      captured_at: payment.captured_at,
    },
    order_found: false,
    buffer_minutes: BUFFER_MINUTES,
    investigated_at: now.toISOString(),
  };

  const classification = "payment_captured_no_order";
  const confidence: "low" | "medium" | "high" = "high";
  const recommendedAction =
    "Manually verify with the payment provider that funds were captured. If confirmed, review whether manual order recreation is appropriate under current operational policy. If the customer no longer wants the order, follow the organization's refund process.";

  
  const upsertRes = await pool.query<{ id: string; created_at: string; updated_at: string }>(
    `INSERT INTO incident_escalations
       (checkout_reference, payment_id, order_id, incident_type, classification, confidence, recommended_action, evidence, status)
     VALUES ($1, $2, NULL, 'payment_without_order', $3, $4, $5, $6, 'open')
     ON CONFLICT (checkout_reference) WHERE status IN ('open', 'acknowledged')
     DO UPDATE SET
       evidence = EXCLUDED.evidence,
       confidence = EXCLUDED.confidence,
       recommended_action = EXCLUDED.recommended_action,
       updated_at = now()
     RETURNING id, created_at, updated_at`,
    [checkoutReference, payment.id, classification, confidence, recommendedAction, evidence]
  );

  const row = upsertRes.rows[0];
  
  const wasDuplicate = new Date(row.created_at).getTime() !== new Date(row.updated_at).getTime();

  return {
    status: "incident_confirmed",
    checkoutReference,
    escalationId: row.id,
    classification,
    confidence,
    recommendedAction,
    evidence,
    wasDuplicate,
  };
}

export async function getEscalationStatus(pool: Pool, checkoutReference: string) {
  const res = await pool.query(
    `SELECT id, checkout_reference, status, classification, confidence, recommended_action, evidence, created_at, updated_at
     FROM incident_escalations WHERE checkout_reference = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [checkoutReference]
  );
  return res.rows[0] ?? null;
}

export async function listOpenEscalations(pool: Pool, limit = 20) {
  const res = await pool.query(
    `SELECT id, checkout_reference, status, classification, confidence, recommended_action, created_at, updated_at
     FROM incident_escalations WHERE status IN ('open', 'acknowledged')
     ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  return res.rows;
}
