/**
 * Scoring — turn one raw answer into the six visibility signals.
 *
 * Every function here is pure and deterministic: the same `AnswerSample` and
 * `BrandProfile` always produce the same `SignalMeasurement`. That is what
 * makes scoring testable with fixtures and what lets the aggregator treat
 * repeated runs as independent samples.
 */

import type {
  AnswerSample,
  BrandProfile,
  Citation,
  FactualDescriptionResult,
  SignalMeasurement,
  SourceOverlapResult,
} from "./schema.js";

/** Normalise text for case-insensitive, punctuation-tolerant matching. */
function normalise(text: string): string {
  return text.toLowerCase();
}

/**
 * Does `haystack` contain `needle` as a whole token (not as a substring of a
 * larger word)? Keeps "mesh" from matching "meshing" or "enmeshed".
 */
function containsTerm(haystack: string, needle: string): boolean {
  const term = needle.trim().toLowerCase();
  if (term === "") return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-ish boundaries: term must not be flanked by letters/digits. This lets
  // multi-word terms and terms with punctuation (e.g. "@harrym1707/sdk") match.
  const boundary = "(^|[^a-z0-9])";
  const trailing = "($|[^a-z0-9])";
  return new RegExp(`${boundary}${escaped}${trailing}`, "i").test(haystack);
}

/** All the names that count as naming the brand. */
function brandTerms(brand: BrandProfile): string[] {
  return [brand.name, ...(brand.aliases ?? [])].filter((t) => t.trim() !== "");
}

/** Extract a bare domain from a URL or a value that is already a domain. */
export function domainOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  let host = trimmed;
  const schemeMatch = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  if (schemeMatch) {
    try {
      host = new URL(trimmed).host;
    } catch {
      host = trimmed.slice(schemeMatch[0].length);
    }
  }
  // Drop any path/query that survived, strip a leading "www.", lowercase.
  host = host.split(/[/?#]/)[0] ?? host;
  host = host.replace(/^www\./i, "").toLowerCase();
  return host === "" ? undefined : host;
}

/** Normalise an owned-domain entry the same way citations are normalised. */
function ownedDomainSet(brand: BrandProfile): Set<string> {
  const owned = new Set<string>();
  for (const entry of brand.ownedDomains) {
    const d = domainOf(entry);
    if (d) owned.add(d);
  }
  return owned;
}

/** Resolve a citation's domain, preferring an explicit `domain` over the URL. */
function citationDomain(citation: Citation): string | undefined {
  return domainOf(citation.domain) ?? domainOf(citation.url);
}

/** Signal 1: brand named anywhere in the answer text. */
export function detectMention(sample: AnswerSample, brand: BrandProfile): boolean {
  const text = normalise(sample.text);
  return brandTerms(brand).some((term) => containsTerm(text, term));
}

/**
 * Signal 2: brand appears among the engine's cited sources — either a cited
 * domain is owned, or a citation's title/url names the brand.
 */
export function detectCitation(sample: AnswerSample, brand: BrandProfile): boolean {
  const owned = ownedDomainSet(brand);
  const terms = brandTerms(brand);
  return (sample.citations ?? []).some((citation) => {
    const d = citationDomain(citation);
    if (d && owned.has(d)) return true;
    const title = normalise(citation.title ?? "");
    const url = normalise(citation.url ?? "");
    return terms.some((term) => containsTerm(title, term) || containsTerm(url, term));
  });
}

/** Signal 3: a resolvable link (http/https URL) to an owned domain. */
export function detectLink(sample: AnswerSample, brand: BrandProfile): boolean {
  const owned = ownedDomainSet(brand);
  return (sample.citations ?? []).some((citation) => {
    if (!citation.url || !/^https?:\/\//i.test(citation.url.trim())) return false;
    const d = domainOf(citation.url);
    return d !== undefined && owned.has(d);
  });
}

/**
 * Signal 4: categories the answer associated the brand with. A category counts
 * when the brand is mentioned AND at least one of the category's keywords is
 * present in the answer.
 */
export function detectCategoryAssociations(
  sample: AnswerSample,
  brand: BrandProfile,
  mentioned: boolean,
): string[] {
  if (!mentioned) return [];
  const text = normalise(sample.text);
  return brand.categories
    .filter((category) => category.keywords.some((keyword) => containsTerm(text, keyword)))
    .map((category) => category.id);
}

/**
 * Signal 5: how the answer describes the brand, checked against canonical
 * claims. A claim is supported if any of its `supportedBy` phrases is present
 * and none of its `contradictedBy` phrases is; it is contradicted if any
 * `contradictedBy` phrase is present. Only evaluated when the brand is named.
 */
export function scoreFactualDescription(
  sample: AnswerSample,
  brand: BrandProfile,
  mentioned: boolean,
): FactualDescriptionResult {
  const empty: FactualDescriptionResult = {
    present: false,
    correct: false,
    supportedClaims: [],
    contradictedClaims: [],
  };
  if (!mentioned) return empty;

  const text = normalise(sample.text);
  const supportedClaims: string[] = [];
  const contradictedClaims: string[] = [];

  for (const claim of brand.canonicalClaims) {
    const contradicted = (claim.contradictedBy ?? []).some((phrase) => containsTerm(text, phrase));
    const supported = claim.supportedBy.some((phrase) => containsTerm(text, phrase));
    if (contradicted) {
      contradictedClaims.push(claim.id);
    } else if (supported) {
      supportedClaims.push(claim.id);
    }
  }

  const present = supportedClaims.length > 0 || contradictedClaims.length > 0;
  const correct = present && supportedClaims.length > 0 && contradictedClaims.length === 0;
  return { present, correct, supportedClaims, contradictedClaims };
}

/** Signal 6: overlap between cited sources and the brand's owned domains. */
export function scoreSourceOverlap(
  sample: AnswerSample,
  brand: BrandProfile,
): SourceOverlapResult {
  const owned = ownedDomainSet(brand);
  const citedDomains: string[] = [];
  const seen = new Set<string>();
  for (const citation of sample.citations ?? []) {
    const d = citationDomain(citation);
    if (d && !seen.has(d)) {
      seen.add(d);
      citedDomains.push(d);
    }
  }
  const ownedDomainsCited = citedDomains.filter((d) => owned.has(d));
  const overlapRatio = citedDomains.length === 0 ? null : ownedDomainsCited.length / citedDomains.length;
  return { citedDomains, ownedDomainsCited, overlapRatio };
}

/** Competing brands that appear in the answer text. */
export function detectCompetitors(sample: AnswerSample, brand: BrandProfile): string[] {
  const text = normalise(sample.text);
  return (brand.competitors ?? []).filter((name) => containsTerm(text, name));
}

/**
 * Score one raw answer into a full `SignalMeasurement`. Pure: no clock, no I/O.
 * The runner supplies `runId` and a timestamp; a failed sample (one carrying an
 * `error`) scores as all-negative so a flaky engine lowers rates rather than
 * crashing the batch.
 */
export function scoreAnswer(
  sample: AnswerSample,
  brand: BrandProfile,
  context: { runId: string; timestamp: string },
): SignalMeasurement {
  const queryId = sample.queryId ?? sample.query;
  const categoriesProbed = sample.categories ?? [];

  if (sample.error !== undefined) {
    return {
      engine: sample.engine,
      query: sample.query,
      queryId,
      runId: context.runId,
      timestamp: sample.timestamp ?? context.timestamp,
      mentioned: false,
      cited: false,
      linked: false,
      categoriesAssociated: [],
      factualDescription: { present: false, correct: false, supportedClaims: [], contradictedClaims: [] },
      sourceOverlap: { citedDomains: [], ownedDomainsCited: [], overlapRatio: null },
      categoriesProbed,
      competitorMentions: [],
      error: sample.error,
    };
  }

  const mentioned = detectMention(sample, brand);
  return {
    engine: sample.engine,
    query: sample.query,
    queryId,
    runId: context.runId,
    timestamp: sample.timestamp ?? context.timestamp,
    mentioned,
    cited: detectCitation(sample, brand),
    linked: detectLink(sample, brand),
    categoriesAssociated: detectCategoryAssociations(sample, brand, mentioned),
    factualDescription: scoreFactualDescription(sample, brand, mentioned),
    sourceOverlap: scoreSourceOverlap(sample, brand),
    categoriesProbed,
    competitorMentions: detectCompetitors(sample, brand),
  };
}
