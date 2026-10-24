// packages/core/src/savings-ledger.ts
import { createHash as createHash2 } from "node:crypto";

// packages/core/src/price-catalogue.ts
import { createHash } from "node:crypto";

// packages/core/src/cost.ts
function estimateTokenCost(inputTokens, outputTokens, price, cacheUsage = {}) {
  const cached = cacheUsage.cachedInputTokens ?? 0;
  const cacheWrite = cacheUsage.cacheWriteInputTokens ?? 0;
  const cacheWrite1h = cacheUsage.cacheWrite1hInputTokens ?? 0;
  if (!Number.isFinite(cached) || cached < 0 || !Number.isFinite(cacheWrite) || cacheWrite < 0 || !Number.isFinite(cacheWrite1h) || cacheWrite1h < 0 || cached + cacheWrite > inputTokens || cacheWrite1h > cacheWrite) {
    throw new Error("Cached input token counts must be non-negative and no greater than total input tokens.");
  }
  const cacheWrite5m = cacheWrite - cacheWrite1h;
  if (cached > 0 && price.cachedInputPerMillion === void 0 || cacheWrite5m > 0 && price.cacheWriteInputPerMillion === void 0 || cacheWrite1h > 0 && price.cacheWrite1hInputPerMillion === void 0) {
    throw new Error("Cached input pricing is required to calculate actual cost for cached tokens.");
  }
  const uncached = inputTokens - cached - cacheWrite;
  return uncached / 1e6 * price.inputPerMillion + cached / 1e6 * (price.cachedInputPerMillion ?? 0) + cacheWrite5m / 1e6 * (price.cacheWriteInputPerMillion ?? 0) + cacheWrite1h / 1e6 * (price.cacheWrite1hInputPerMillion ?? 0) + outputTokens / 1e6 * price.outputPerMillion;
}

// packages/core/src/price-catalogue.ts
var ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function assertIsoDate(value, label) {
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO calendar date (YYYY-MM-DD); received ${JSON.stringify(value)}.`);
  }
}
function applicable(items, at) {
  return items.find((item) => item.effectiveFrom <= at && (item.effectiveTo === void 0 || at < item.effectiveTo));
}
function tierFor(tiers, inputTokens) {
  const bounded = tiers.filter((tier) => tier.maxInputTokens !== void 0).sort((left, right) => left.maxInputTokens - right.maxInputTokens);
  const match = bounded.find((tier) => inputTokens <= tier.maxInputTokens);
  return match ?? tiers.find((tier) => tier.maxInputTokens === void 0);
}
function withoutBound(tier) {
  const { maxInputTokens: _bound, ...price } = tier;
  return price;
}
function discounted(tier, discountPercent) {
  const factor = 1 - discountPercent / 100;
  return {
    inputPerMillion: tier.inputPerMillion * factor,
    outputPerMillion: tier.outputPerMillion * factor,
    ...tier.cachedInputPerMillion === void 0 ? {} : { cachedInputPerMillion: tier.cachedInputPerMillion * factor },
    ...tier.cacheWriteInputPerMillion === void 0 ? {} : { cacheWriteInputPerMillion: tier.cacheWriteInputPerMillion * factor },
    ...tier.cacheWrite1hInputPerMillion === void 0 ? {} : { cacheWrite1hInputPerMillion: tier.cacheWrite1hInputPerMillion * factor }
  };
}
function lookupPrice(catalogue, query, inputTokens = 0) {
  assertIsoDate(query.at, "Price query `at`");
  const mode = query.mode ?? "standard";
  const candidates = catalogue.entries.filter((entry2) => entry2.provider === query.provider && entry2.model === query.model && entry2.mode === mode);
  if (candidates.length === 0) {
    return { status: "unpriced", reason: `No ${mode} rate is catalogued for ${query.provider}/${query.model}.` };
  }
  const entry = applicable(candidates, query.at);
  if (!entry) {
    const ranges = candidates.map((candidate) => `${candidate.effectiveFrom} to ${candidate.effectiveTo ?? "current"}`).join("; ");
    return {
      status: "unpriced",
      reason: `No ${mode} rate for ${query.provider}/${query.model} covers ${query.at}; catalogued ranges are ${ranges}.`
    };
  }
  const tier = tierFor(entry.tiers, inputTokens);
  const override = applicable(
    catalogue.negotiated.filter((rate) => rate.provider === query.provider && rate.model === query.model && (rate.mode ?? "standard") === mode),
    query.at
  );
  if (!override) return { status: "priced", price: withoutBound(tier), entry };
  const price = override.tiers ? withoutBound(tierFor(override.tiers, inputTokens)) : discounted(tier, override.discountPercent);
  return { status: "priced", price, entry, negotiated: override };
}
function priceUsage(catalogue, query, usage) {
  for (const [name, value] of Object.entries(usage)) {
    if (value === void 0) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Token usage ${name} must be a non-negative finite number.`);
    }
  }
  const lookup = lookupPrice(catalogue, query, usage.inputTokens);
  if (lookup.status === "unpriced") return lookup;
  const cached = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const cacheWrite1h = usage.cacheWrite1hInputTokens ?? 0;
  if (cacheWrite1h > cacheWrite) {
    return {
      status: "unpriced",
      reason: `${query.provider}/${query.model} reports more 1h cache writes (${cacheWrite1h}) than total cache writes (${cacheWrite}).`
    };
  }
  if (cached > 0 && lookup.price.cachedInputPerMillion === void 0 || cacheWrite - cacheWrite1h > 0 && lookup.price.cacheWriteInputPerMillion === void 0 || cacheWrite1h > 0 && lookup.price.cacheWrite1hInputPerMillion === void 0) {
    return {
      status: "unpriced",
      reason: `${query.provider}/${query.model} billed cached input tokens on ${query.at}, but the catalogue has no cached-input rate for it.`
    };
  }
  const costUsd = estimateTokenCost(usage.inputTokens, usage.outputTokens, lookup.price, {
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    cacheWrite1hInputTokens: usage.cacheWrite1hInputTokens
  });
  return { status: "priced", costUsd, price: lookup.price, entry: lookup.entry, negotiated: lookup.negotiated };
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).filter(([, member]) => member !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
  return `{${entries.join(",")}}`;
}
function catalogueVersion(catalogue) {
  return createHash("sha256").update(canonicalJson(catalogue)).digest("hex").slice(0, 16);
}
function canonicalSegments(value) {
  return value.toLowerCase().replace(/[-_]latest$/, "").replace(/[-_]20\d{2}[-_]\d{2}[-_]\d{2}$/, "").replace(/[-_]20\d{6}$/, "").split(/[^a-z0-9]+/).filter((segment) => segment !== "");
}
function containsSegments(id, key) {
  if (key.length === 0 || key.length > id.length) return false;
  for (let offset = 0; offset + key.length <= id.length; offset += 1) {
    if (key.every((segment, index) => id[offset + index] === segment)) return true;
  }
  return false;
}
function resolveModelId(catalogue, provider, rawModelId) {
  const known = [...new Set(catalogue.entries.filter((entry) => entry.provider === provider).map((entry) => entry.model))];
  if (known.length === 0) {
    return { status: "unresolved", reason: `No models are catalogued for provider ${provider}.`, candidates: [] };
  }
  if (known.includes(rawModelId)) return { status: "resolved", model: rawModelId, via: "exact" };
  for (const alias of catalogue.aliases ?? []) {
    if (alias.provider !== provider) continue;
    const matches = alias.id.endsWith("*") ? rawModelId.startsWith(alias.id.slice(0, -1)) : alias.id === rawModelId;
    if (!matches) continue;
    if (!known.includes(alias.model)) {
      return {
        status: "unresolved",
        reason: `Alias ${alias.id} points at ${alias.model}, which is not catalogued for ${provider}.`,
        candidates: known
      };
    }
    return { status: "resolved", model: alias.model, via: "alias" };
  }
  const target = canonicalSegments(rawModelId);
  const hits = known.map((model) => ({ model, key: canonicalSegments(model) })).filter(({ key }) => containsSegments(target, key)).sort((left, right) => right.key.length - left.key.length || right.key.join("").length - left.key.join("").length);
  if (hits.length === 0) {
    return {
      status: "unresolved",
      reason: `No catalogue key for ${provider} matches ${rawModelId}; add an alias.`,
      candidates: known
    };
  }
  const longest = hits[0].key.length;
  const tied = hits.filter(({ key }) => key.length === longest);
  if (tied.length > 1) {
    return {
      status: "unresolved",
      reason: `${rawModelId} matches ${tied.length} catalogue keys equally well; add an explicit alias.`,
      candidates: tied.map(({ model }) => model)
    };
  }
  return { status: "resolved", model: hits[0].model, via: "normalised" };
}

// packages/core/src/savings-ledger.ts
var LEDGER_GENESIS_HASH = "0".repeat(64);
function ledgerEventHash(seq, prevHash, event) {
  return createHash2("sha256").update(`${seq}
${prevHash}
${canonicalJson(event)}`).digest("hex");
}
function chainLedgerRecord(event, previous) {
  const seq = previous ? previous.seq + 1 : 0;
  const prevHash = previous ? previous.eventHash : LEDGER_GENESIS_HASH;
  return { seq, prevHash, eventHash: ledgerEventHash(seq, prevHash, event), event };
}
function verifyLedgerChain(records) {
  let prevHash = LEDGER_GENESIS_HASH;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.seq !== index) {
      return { ok: false, seq: record.seq, reason: `Expected seq ${index}, found ${record.seq}.` };
    }
    if (record.prevHash !== prevHash) {
      return { ok: false, seq: record.seq, reason: "prevHash does not match the preceding record." };
    }
    const expected = ledgerEventHash(record.seq, record.prevHash, record.event);
    if (record.eventHash !== expected) {
      return { ok: false, seq: record.seq, reason: "eventHash does not match the event content." };
    }
    prevHash = record.eventHash;
  }
  return { ok: true, length: records.length };
}
function priceLedgerUsage(catalogue, input) {
  const resolution = resolveModelId(catalogue, input.provider, input.model);
  if (resolution.status === "unresolved") {
    return { pricingStatus: "unpriced", reason: resolution.reason };
  }
  const split5m = input.usage.cacheWrite5mInputTokens;
  const split1h = input.usage.cacheWrite1hInputTokens;
  const splitReported = split5m !== void 0 || split1h !== void 0;
  if (splitReported && (split5m ?? 0) + (split1h ?? 0) !== input.usage.cacheWriteInputTokens) {
    return {
      pricingStatus: "unpriced",
      reason: `Cache-write TTL split (5m ${split5m ?? 0} + 1h ${split1h ?? 0}) does not sum to cacheWriteInputTokens ${input.usage.cacheWriteInputTokens}.`
    };
  }
  const write1hForPricing = splitReported ? split1h ?? 0 : input.fluxPlacedCacheControl && input.fluxPlacedTtl !== "5m" ? input.usage.cacheWriteInputTokens : 0;
  const pricingUsage = {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedInputTokens: input.usage.cachedInputTokens,
    cacheWriteInputTokens: input.usage.cacheWriteInputTokens,
    cacheWrite1hInputTokens: write1hForPricing
  };
  const query = { provider: input.provider, model: resolution.model, at: input.at };
  const actual = priceUsage(catalogue, { ...query, mode: input.executionMode }, pricingUsage);
  if (actual.status === "unpriced") return { pricingStatus: "unpriced", reason: actual.reason };
  const actualInputOnly = priceUsage(catalogue, { ...query, mode: input.executionMode }, {
    ...pricingUsage,
    outputTokens: 0
  });
  if (actualInputOnly.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: actualInputOnly.reason };
  }
  const standardWithCache = input.executionMode === "standard" ? actual : priceUsage(catalogue, { ...query, mode: "standard" }, pricingUsage);
  if (standardWithCache.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: standardWithCache.reason };
  }
  const fullRateStandard = priceUsage(catalogue, { ...query, mode: "standard" }, {
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens
  });
  if (fullRateStandard.status === "unpriced") {
    return { pricingStatus: "unpriced", reason: fullRateStandard.reason };
  }
  const cacheDeltaUsd = fullRateStandard.costUsd - standardWithCache.costUsd;
  const hasCacheTraffic = input.usage.cachedInputTokens > 0 || input.usage.cacheWriteInputTokens > 0;
  return {
    pricingStatus: "priced",
    actualUsd: actual.costUsd,
    inputUsd: actualInputOnly.costUsd,
    ...input.executionMode === "standard" ? {} : { tierSavedUsd: standardWithCache.costUsd - actual.costUsd },
    ...hasCacheTraffic ? input.fluxPlacedCacheControl ? { cacheAttributedUsd: cacheDeltaUsd } : { providerCacheAlreadyOwnedUsd: cacheDeltaUsd } : {}
  };
}
function auditEventPricing(event, catalogue) {
  const version = catalogueVersion(catalogue);
  if (event.catalogueVersion !== void 0 && event.catalogueVersion !== version) {
    return { status: "catalogue_version_mismatch", eventVersion: event.catalogueVersion, catalogueVersion: version };
  }
  if (!event.usage) {
    return event.actualUsd === void 0 ? { status: "verified" } : { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: Number.NaN };
  }
  const cacheLever = event.levers.find((lever) => lever.kind === "provider_cache");
  const fluxPlacedCacheControl = cacheLever !== void 0;
  const fluxPlacedTtl = cacheLever?.leverId === "cache-ttl-5m" ? "5m" : cacheLever?.leverId === "cache-ttl-1h" ? "1h" : void 0;
  const priced = priceLedgerUsage(catalogue, {
    provider: event.provider,
    model: event.model,
    at: event.timestamp.slice(0, 10),
    executionMode: event.executionMode,
    usage: event.usage,
    fluxPlacedCacheControl,
    ...fluxPlacedTtl === void 0 ? {} : { fluxPlacedTtl }
  });
  if (priced.pricingStatus === "unpriced") {
    return event.pricingStatus === "unpriced" ? { status: "verified" } : { status: "unpriced", reason: priced.reason };
  }
  if (priced.actualUsd !== event.actualUsd) {
    return { status: "mismatch", field: "actualUsd", storedUsd: event.actualUsd, recomputedUsd: priced.actualUsd };
  }
  return { status: "verified" };
}
function compareEvents(left, right) {
  if (left.timestamp !== right.timestamp) return left.timestamp < right.timestamp ? -1 : 1;
  if (left.requestId !== right.requestId) return left.requestId < right.requestId ? -1 : 1;
  return 0;
}
function leverUnbilledReason(lever, gateVerdictOverrides) {
  const verdict = gateVerdictOverrides?.[lever.leverId] ?? lever.gateVerdict?.verdict;
  if (lever.savedUsd === void 0 || !Number.isFinite(lever.savedUsd)) {
    return "no per-request verified measurement";
  }
  if (lever.kind === "lossy" && verdict !== "approved") {
    return verdict === "rejected" ? "replay gate verdict rejected" : "no approved replay gate verdict";
  }
  return void 0;
}
function selectBillableEvents(events, options = {}) {
  for (const event of events) {
    if (event.schemaVersion !== 1) {
      throw new Error(`Unsupported billable event schemaVersion ${JSON.stringify(event.schemaVersion)}.`);
    }
    if (typeof event.requestId !== "string" || event.requestId === "") {
      throw new Error("Billable events need a non-empty requestId idempotency key.");
    }
  }
  const sorted = [...events].sort(compareEvents);
  const seen = /* @__PURE__ */ new Set();
  let duplicatesIgnored = 0;
  const deduped = [];
  for (const event of sorted) {
    if (seen.has(event.requestId)) {
      duplicatesIgnored += 1;
      continue;
    }
    seen.add(event.requestId);
    deduped.push(event);
  }
  const consideredEvents = options.period === void 0 ? deduped : deduped.filter((event) => event.invoicePeriod === options.period);
  const failedTaskIds = new Set(options.failedTaskIds ?? []);
  for (const event of consideredEvents) {
    if (event.status === "failed" && event.taskId !== void 0) failedTaskIds.add(event.taskId);
  }
  let eventsExcludedForFailedTasks = 0;
  const billableEvents = [];
  for (const event of consideredEvents) {
    const taskFailed = event.taskId !== void 0 && failedTaskIds.has(event.taskId);
    if (taskFailed || event.status === "failed") {
      eventsExcludedForFailedTasks += 1;
      continue;
    }
    billableEvents.push(event);
  }
  return { consideredEvents, billableEvents, failedTaskIds, eventsExcludedForFailedTasks, duplicatesIgnored };
}
function recomputeInvoice(events, options = {}) {
  return recomputeInvoiceWithAudit(events, options).invoice;
}
function recomputeInvoiceWithAudit(events, options = {}) {
  if (options.feePercent !== void 0 && (!Number.isFinite(options.feePercent) || options.feePercent < 0 || options.feePercent > 100)) {
    throw new Error("feePercent must be between 0 and 100.");
  }
  const {
    consideredEvents: inPeriod,
    billableEvents,
    failedTaskIds,
    eventsExcludedForFailedTasks,
    duplicatesIgnored
  } = selectBillableEvents(events, options);
  const lineMap = /* @__PURE__ */ new Map();
  const unbilledMap = /* @__PURE__ */ new Map();
  const catalogueVersions = /* @__PURE__ */ new Set();
  let unpricedEvents = 0;
  let providerCacheOnAppendedHistoryUsd = 0;
  let gatewayCacheUsd = 0;
  let eventsBilled = 0;
  for (const event of billableEvents) {
    if (event.catalogueVersion !== void 0) catalogueVersions.add(event.catalogueVersion);
    if (event.pricingStatus === "unpriced") unpricedEvents += 1;
    providerCacheOnAppendedHistoryUsd += event.excluded?.providerCacheAlreadyOwnedUsd ?? 0;
    gatewayCacheUsd += event.excluded?.gatewayCacheUsd ?? 0;
    let billedAny = false;
    for (const lever of event.levers) {
      const unbilledReason = leverUnbilledReason(lever, options.gateVerdictOverrides);
      if (unbilledReason !== void 0) {
        const key2 = `${lever.kind}
${lever.leverId}
${unbilledReason}`;
        const existing = unbilledMap.get(key2);
        if (existing) existing.events += 1;
        else unbilledMap.set(key2, { leverId: lever.leverId, kind: lever.kind, events: 1, reason: unbilledReason });
        continue;
      }
      const key = `${lever.kind}
${lever.leverId}`;
      const line = lineMap.get(key) ?? { leverId: lever.leverId, kind: lever.kind, events: 0, savedUsd: 0, estimated: false, refs: /* @__PURE__ */ new Set() };
      line.events += 1;
      line.savedUsd += lever.savedUsd;
      if (lever.basis === "estimated-baseline") line.estimated = true;
      if (lever.gateVerdict?.ref) line.refs.add(lever.gateVerdict.ref);
      lineMap.set(key, line);
      billedAny = true;
    }
    if (billedAny) eventsBilled += 1;
  }
  const lineItems = [...lineMap.values()].sort((left, right) => left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0).map((line) => ({
    leverId: line.leverId,
    kind: line.kind,
    events: line.events,
    savedUsd: line.savedUsd,
    savedCents: Math.round(line.savedUsd * 100),
    ...line.estimated ? { basis: "estimated-baseline" } : {},
    gateVerdictRefs: [...line.refs].sort()
  }));
  const recordedUnbilled = [...unbilledMap.values()].sort((left, right) => left.leverId < right.leverId ? -1 : left.leverId > right.leverId ? 1 : 0);
  const netVerifiedSavingsUsd = lineItems.reduce((sum, line) => sum + line.savedUsd, 0);
  const netVerifiedSavingsCents = Math.round(netVerifiedSavingsUsd * 100);
  const verdict = netVerifiedSavingsCents > 0 ? "charge" : "do_not_charge";
  const amountDueUsd = options.feePercent === void 0 ? void 0 : verdict === "charge" ? netVerifiedSavingsUsd * options.feePercent / 100 : 0;
  const invoice = {
    schemaVersion: 1,
    period: options.period ?? null,
    catalogueVersions: [...catalogueVersions].sort(),
    eventsConsidered: inPeriod.length,
    eventsBilled,
    failedTaskIds: [...failedTaskIds].sort(),
    eventsExcludedForFailedTasks,
    unpricedEvents,
    lineItems,
    recordedUnbilled,
    excludedAlreadyOwned: {
      providerCacheOnAppendedHistoryUsd,
      gatewayCacheUsd
    },
    netVerifiedSavingsUsd,
    netVerifiedSavingsCents,
    verdict,
    ...options.feePercent === void 0 ? {} : {
      feePercent: options.feePercent,
      amountDueUsd,
      amountDueCents: Math.round((amountDueUsd ?? 0) * 100)
    }
  };
  return { invoice, audit: { duplicatesIgnored } };
}
export {
  LEDGER_GENESIS_HASH,
  auditEventPricing,
  canonicalJson,
  chainLedgerRecord,
  ledgerEventHash,
  recomputeInvoice,
  verifyLedgerChain
};
