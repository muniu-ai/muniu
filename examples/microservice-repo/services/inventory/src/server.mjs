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
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validReservation(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.orderId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.orderId) &&
    typeof value.sku === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.sku) &&
    Number.isSafeInteger(value.quantity) &&
    value.quantity > 0
  );
}

export function createInventoryService(options = {}) {
  const stock = new Map(
    Object.entries(options.initialStock ?? { "sku-demo": 5 }).map(([sku, quantity]) => [
      sku,
      Number(quantity)
    ])
  );
  const reservations = new Map();

  return {
    stock,
    reservations,
    async handler(request, response) {
      const url = new URL(request.url ?? "/", "http://inventory.invalid");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "inventory" });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/stock/")) {
        const sku = decodeURIComponent(url.pathname.slice("/v1/stock/".length));
        sendJson(response, 200, { sku, available: stock.get(sku) ?? 0 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/reservations") {
        try {
          const body = await readJson(request);
          if (!validReservation(body)) {
            sendJson(response, 400, { code: "INVALID_RESERVATION" });
            return;
          }
          const existing = reservations.get(body.orderId);
          if (existing) {
            const same = existing.sku === body.sku && existing.quantity === body.quantity;
            sendJson(response, same ? 200 : 409, same ? existing : { code: "IDEMPOTENCY_CONFLICT" });
            return;
          }
          const available = stock.get(body.sku) ?? 0;
          if (available < body.quantity) {
            sendJson(response, 409, {
              code: "INSUFFICIENT_STOCK",
              sku: body.sku,
              available
            });
            return;
          }
          const reservation = {
            reservationId: `res-${body.orderId}`,
            orderId: body.orderId,
            sku: body.sku,
            quantity: body.quantity,
            status: "reserved"
          };
          stock.set(body.sku, available - body.quantity);
          reservations.set(body.orderId, reservation);
          sendJson(response, 201, reservation);
        } catch (error) {
          sendJson(response, error instanceof RangeError ? 413 : 400, {
            code: "INVALID_JSON"
          });
        }
        return;
      }
      sendJson(response, 404, { code: "NOT_FOUND" });
    }
  };
}

export function startInventoryServer(options = {}) {
  const service = createInventoryService(options);
  const server = createServer(service.handler);
  return { service, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "4101", 10);
  const { server } = startInventoryServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`inventory listening on ${port}`);
  });
}

