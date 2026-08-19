// SPDX-License-Identifier: Apache-2.0

import { EnterprisePostgresRuntime } from "./enterprisePostgres.js";

const connectionString = process.env.MN_POSTGRES_URL;
if (!connectionString) throw new Error("MN_POSTGRES_URL is required for migration");

const runtime = new EnterprisePostgresRuntime({
  connectionString,
  applicationName: "mn-migrate",
  maxConnections: 1
});
try {
  await runtime.migrate();
  await runtime.checkReadWrite();
} finally {
  await runtime.close();
}
