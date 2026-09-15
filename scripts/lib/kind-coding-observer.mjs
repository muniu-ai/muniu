// SPDX-License-Identifier: Apache-2.0
const transientConnectionCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "57P01", "57P02", "57P03", "53300"]);

export async function readPendingKindApproval(pool, tenantId, executionId) {
  try {
    const result = await pool.query(`select value_json from mn_v2.projections
      where tenant_id = $1 and namespace = 'approval'
        and value_json->>'executionId' = $2 and value_json->>'status' = 'pending'`, [tenantId, executionId]);
    return result.rows[0]?.value_json;
  } catch (error) {
    // The caller retains its fixed deadline; only this SELECT may be repeated.
    if (transientConnectionCodes.has(error.code)
      || error.message === "timeout exceeded when trying to connect") return undefined;
    throw error;
  }
}
