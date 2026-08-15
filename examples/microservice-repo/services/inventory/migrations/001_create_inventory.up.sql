BEGIN;

CREATE TABLE inventory_stock (
  sku text PRIMARY KEY,
  available integer NOT NULL CHECK (available >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory_reservations (
  reservation_id text PRIMARY KEY,
  order_id text NOT NULL UNIQUE,
  sku text NOT NULL REFERENCES inventory_stock(sku),
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('reserved', 'released')),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

