import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("request body exceeds 64 KiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validOrder(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.sku === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.sku) &&
    Number.isSafeInteger(value.quantity) &&
    value.quantity > 0
  );
}

export function createOrderService({ inventoryBaseUrl, fetchImpl = fetch } = {}) {
  if (typeof inventoryBaseUrl !== "string" || !inventoryBaseUrl.startsWith("http")) {
    throw new TypeError("inventoryBaseUrl must be an HTTP URL");
  }
  const orders = new Map();
  let sequence = 0;

  return {
    orders,
    async handler(request, response) {
      const url = new URL(request.url ?? "/", "http://orders.invalid");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "orders" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/orders") {
        try {
          const body = await readJson(request);
          if (!validOrder(body)) {
            sendJson(response, 400, { code: "INVALID_ORDER" });
            return;
          }
          const idempotencyKey = request.headers["idempotency-key"];
          if (
            idempotencyKey !== undefined &&
            (typeof idempotencyKey !== "string" ||
              !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(idempotencyKey))
          ) {
            sendJson(response, 400, { code: "INVALID_IDEMPOTENCY_KEY" });
            return;
          }
          const orderId = idempotencyKey ?? `order-${++sequence}`;
          const existing = orders.get(orderId);
          if (existing) {
            const same = existing.sku === body.sku && existing.quantity === body.quantity;
            sendJson(response, same ? 200 : 409, same ? existing : { code: "IDEMPOTENCY_CONFLICT" });
            return;
          }
          const inventoryResponse = await fetchImpl(`${inventoryBaseUrl}/v1/reservations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orderId, sku: body.sku, quantity: body.quantity })
          });
          const inventory = await inventoryResponse.json();
          if (inventoryResponse.status === 409) {
            sendJson(response, 409, {
              orderId,
              status: "rejected",
              reason: inventory.code ?? "INVENTORY_CONFLICT"
            });
            return;
          }
          if (!inventoryResponse.ok) {
            sendJson(response, 502, { code: "INVENTORY_UNAVAILABLE" });
            return;
          }
          const order = {
            orderId,
            sku: body.sku,
            quantity: body.quantity,
            reservationId: inventory.reservationId,
            status: "confirmed"
          };
          orders.set(orderId, order);
          sendJson(response, 201, order);
        } catch (error) {
          if (error instanceof SyntaxError) {
            sendJson(response, 400, { code: "INVALID_JSON" });
          } else if (error instanceof RangeError) {
            sendJson(response, 413, { code: "PAYLOAD_TOO_LARGE" });
          } else {
            sendJson(response, 502, { code: "INVENTORY_UNAVAILABLE" });
          }
        }
        return;
      }
      sendJson(response, 404, { code: "NOT_FOUND" });
    }
  };
}

export function startOrderServer(options) {
  const service = createOrderService(options);
  const server = createServer(service.handler);
  return { service, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "4100", 10);
  const inventoryBaseUrl = process.env.INVENTORY_BASE_URL ?? "http://127.0.0.1:4101";
  const { server } = startOrderServer({ inventoryBaseUrl });
  server.listen(port, "0.0.0.0", () => {
    console.log(`orders listening on ${port}`);
  });
}

