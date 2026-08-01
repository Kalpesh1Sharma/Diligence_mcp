-- Commerce Incident Investigator: core schema

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  checkout_reference TEXT NOT NULL UNIQUE,
  payment_reference TEXT NOT NULL UNIQUE,
  amount NUMERIC(12, 2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL CHECK (status IN ('pending', 'captured', 'failed', 'refunded')),
  provider TEXT NOT NULL,
  captured_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  checkout_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('created', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incident_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_reference TEXT NOT NULL,
  payment_id UUID NOT NULL REFERENCES payments(id),
  order_id UUID REFERENCES orders(id),
  incident_type TEXT NOT NULL DEFAULT 'payment_without_order',
  classification TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  recommended_action TEXT NOT NULL,
  evidence JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


CREATE UNIQUE INDEX IF NOT EXISTS one_active_escalation_per_checkout
  ON incident_escalations (checkout_reference)
  WHERE status IN ('open', 'acknowledged');

CREATE INDEX IF NOT EXISTS idx_payments_checkout_reference ON payments (checkout_reference);
CREATE INDEX IF NOT EXISTS idx_orders_checkout_reference ON orders (checkout_reference);
CREATE INDEX IF NOT EXISTS idx_escalations_status ON incident_escalations (status);
