import assert from "node:assert/strict";
import test from "node:test";
import { startOrderServer } from "../src/server.mjs";

async function listening(t, fetchImpl) {
  const { server } = startOrderServer({
    inventoryBaseUrl: "http://inventory.test",
    fetchImpl
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("confirms an order after inventory reservation", async (t) => {
  const inventoryCalls = [];
  const baseUrl = await listening(t, async (url, init) => {
    inventoryCalls.push({ url, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({ reservationId: "res-request-1", status: "reserved" }),
      { status: 201, headers: { "content-type": "application/json" } }
    );
  });
  const response = await fetch(`${baseUrl}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "request-1" },
    body: JSON.stringify({ sku: "sku-demo", quantity: 2 })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "confirmed");
  assert.equal(inventoryCalls.length, 1);
  assert.equal(inventoryCalls[0].body.orderId, "request-1");
});

test("maps an inventory conflict to a rejected order", async (t) => {
  const baseUrl = await listening(
    t,
    async () => new Response(JSON.stringify({ code: "INSUFFICIENT_STOCK" }), {
      status: 409,
      headers: { "content-type": "application/json" }
    })
  );
  const response = await fetch(`${baseUrl}/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "sku-demo", quantity: 99 })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "INSUFFICIENT_STOCK");
});

