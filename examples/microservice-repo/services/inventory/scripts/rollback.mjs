import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migration = resolve(serviceRoot, "migrations/001_create_inventory.down.sql");
await access(migration);
console.log(migration);

