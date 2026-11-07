import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizeAction,
  roleGrants,
  ROLE_PERMISSIONS,
  type Subject,
} from "./rbac.js";

const owner: Subject = { id: "u-owner", tenantId: "t1", assignments: [{ role: "owner" }] };
const viewer: Subject = { id: "u-viewer", tenantId: "t1", assignments: [{ role: "viewer" }] };
const operator: Subject = { id: "u-op", tenantId: "t1", assignments: [{ role: "operator" }] };
const analyst: Subject = { id: "u-an", tenantId: "t1", assignments: [{ role: "analyst" }] };

describe("rbac — tenant scoping (§10)", () => {
  it("denies cross-tenant access for every role, owner included", () => {
    const foreign = { tenantId: "t2" };
    for (const subject of [owner, viewer, operator, analyst]) {
      expect(authorize(subject, "policy.read", foreign)).toEqual({ allowed: false, reason: "cross_tenant" });
    }
  });

  it("cross-tenant is checked before permissions — no permission can rescue it", () => {
    expect(authorize(owner, "policy.write", { tenantId: "t2" })).toEqual({
      allowed: false,
      reason: "cross_tenant",
    });
  });

  it("an application-scoped grant does not reach another application", () => {
    const appScoped: Subject = {
      id: "u", tenantId: "t1", assignments: [{ role: "operator", applicationId: "app-1" }],
    };
    expect(authorize(appScoped, "rollout.write", { tenantId: "t1", applicationId: "app-1" }).allowed).toBe(true);
    expect(authorize(appScoped, "rollout.write", { tenantId: "t1", applicationId: "app-2" })).toEqual({
      allowed: false,
      reason: "out_of_scope",
    });
  });

  it("a tenant-wide grant covers every application in the tenant", () => {
    expect(authorize(operator, "rollout.write", { tenantId: "t1", applicationId: "any" }).allowed).toBe(true);
  });
});

describe("rbac — permissions", () => {
  it("owner can do everything in-tenant", () => {
    const res = { tenantId: "t1" };
    for (const permission of ROLE_PERMISSIONS.owner) {
      expect(authorize(owner, permission, res)).toEqual({ allowed: true, via: "owner" });
    }
  });

  it("viewer is read-only: cannot write or sign policies", () => {
    const res = { tenantId: "t1" };
    expect(authorize(viewer, "policy.read", res).allowed).toBe(true);
    expect(authorize(viewer, "policy.write", res)).toEqual({ allowed: false, reason: "missing_permission" });
    expect(authorize(viewer, "policy.sign", res)).toEqual({ allowed: false, reason: "missing_permission" });
  });

  it("operator runs rollouts but cannot author or sign policies", () => {
    const res = { tenantId: "t1" };
    expect(authorize(operator, "rollout.write", res).allowed).toBe(true);
    expect(authorize(operator, "rollout.rollback", res).allowed).toBe(true);
    expect(authorize(operator, "policy.write", res)).toEqual({ allowed: false, reason: "missing_permission" });
    expect(authorize(operator, "member.manage", res)).toEqual({ allowed: false, reason: "missing_permission" });
  });

  it("analyst can read audit and billing but changes nothing", () => {
    const res = { tenantId: "t1" };
    expect(authorize(analyst, "audit.read", res).allowed).toBe(true);
    expect(authorize(analyst, "billing.read", res).allowed).toBe(true);
    expect(authorize(analyst, "rollout.write", res)).toEqual({ allowed: false, reason: "missing_permission" });
  });

  it("a subject with no assignments is out of scope (deny-by-default)", () => {
    const stranger: Subject = { id: "u", tenantId: "t1", assignments: [] };
    expect(authorize(stranger, "policy.read", { tenantId: "t1" })).toEqual({
      allowed: false,
      reason: "out_of_scope",
    });
  });

  it("the highest-matching role is reported as `via`", () => {
    const dual: Subject = {
      id: "u", tenantId: "t1", assignments: [{ role: "viewer" }, { role: "operator" }],
    };
    const decision = authorize(dual, "rollout.write", { tenantId: "t1" });
    expect(decision).toEqual({ allowed: true, via: "operator" });
  });
});

describe("rbac — authorizeAction", () => {
  it("maps action names to the required permission", () => {
    const res = { tenantId: "t1", policyId: "p1" };
    expect(authorizeAction(operator, "rollout.rollback", res).allowed).toBe(true);
    expect(authorizeAction(viewer, "policy.publish", res)).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
    expect(authorizeAction(owner, "access.grant", res).allowed).toBe(true);
  });

  it("denies an unknown action rather than allowing it", () => {
    expect(authorizeAction(owner, "totally.unknown", { tenantId: "t1" })).toEqual({
      allowed: false,
      reason: "missing_permission",
    });
  });
});

describe("rbac — roleGrants", () => {
  it("reflects the role table", () => {
    expect(roleGrants("admin", "policy.sign")).toBe(true);
    expect(roleGrants("viewer", "policy.sign")).toBe(false);
  });
});
