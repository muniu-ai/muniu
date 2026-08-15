BEGIN;

CREATE TABLE orders (
  order_id text PRIMARY KEY,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  reservation_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_outbox (
  event_id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(order_id),
  topic text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz
);

COMMIT;

