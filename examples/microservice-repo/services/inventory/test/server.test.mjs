import assert from "node:assert/strict";
import test from "node:test";
import { startInventoryServer } from "../src/server.mjs";

async function listening(t, options) {
  const { service, server } = startInventoryServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { service, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("reserves stock idempotently and decrements it once", async (t) => {
  const { baseUrl } = await listening(t, { initialStock: { "sku-demo": 5 } });
  const body = { orderId: "order-1", sku: "sku-demo", quantity: 2 };
  const first = await fetch(`${baseUrl}/v1/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(first.status, 201);
  const retry = await fetch(`${baseUrl}/v1/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(retry.status, 200);
  const stock = await fetch(`${baseUrl}/v1/stock/sku-demo`).then((response) => response.json());
  assert.equal(stock.available, 3);
});

test("rejects a reservation when stock is insufficient", async (t) => {
  const { baseUrl } = await listening(t, { initialStock: { "sku-demo": 1 } });
  const response = await fetch(`${baseUrl}/v1/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orderId: "order-2", sku: "sku-demo", quantity: 2 })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "INSUFFICIENT_STOCK");
});

