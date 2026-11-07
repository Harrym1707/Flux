import type { IncomingMessage, ServerResponse } from "node:http";
import type { Account } from "../../../packages/core/dist/src/index.js";
import type { ServerContext } from "./context.js";
import { bearerToken, sendJson } from "./http-util.js";

/**
 * Resolve the account for a request from its Bearer Mesh account key. The
 * account key is the credential for every account-scoped operation (metering,
 * payment setup, key rotation) — it is NOT the provider key, which never
 * reaches this server. On failure the 401 is written and undefined returned.
 */
export function authenticateAccount(req: IncomingMessage, res: ServerResponse, ctx: ServerContext): Account | undefined {
  const key = bearerToken(req);
  if (!key) {
    sendJson(res, 401, { error: "missing_account_key" });
    return undefined;
  }
  const account = ctx.accounts.findByAccountKey(key);
  if (!account) {
    sendJson(res, 401, { error: "invalid_account_key" });
    return undefined;
  }
  return account;
}
