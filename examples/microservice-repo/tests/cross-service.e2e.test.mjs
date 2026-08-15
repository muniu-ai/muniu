import assert from "node:assert/strict";
import test from "node:test";
import { startInventoryServer } from "../services/inventory/src/server.mjs";
import { startOrderServer } from "../services/orders/src/server.mjs";

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("approved increment reserves inventory across services without duplicate effects", async (t) => {
  const inventory = startInventoryServer({ initialStock: { "sku-demo": 5 } });
  const inventoryUrl = await listen(t, inventory.server);
  const orders = startOrderServer({ inventoryBaseUrl: inventoryUrl });
  const ordersUrl = await listen(t, orders.server);

  const request = {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "checkout-42" },
    body: JSON.stringify({ sku: "sku-demo", quantity: 2 })
  };
  const created = await fetch(`${ordersUrl}/v1/orders`, request);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).status, "confirmed");

  const retry = await fetch(`${ordersUrl}/v1/orders`, request);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).orderId, "checkout-42");

  const stock = await fetch(`${inventoryUrl}/v1/stock/sku-demo`).then((response) => response.json());
  assert.equal(stock.available, 3, "retry must not reserve stock twice");

  const rejected = await fetch(`${ordersUrl}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "checkout-43" },
    body: JSON.stringify({ sku: "sku-demo", quantity: 4 })
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).reason, "INSUFFICIENT_STOCK");
});

