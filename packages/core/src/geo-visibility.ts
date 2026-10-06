export type GeoObservation = {
  engine: string;
  promptId: string;
  timestamp: string;
  mentioned: boolean;
  cited?: boolean;
  linked?: boolean;
  correctDescription?: boolean;
  categoryAssociated?: boolean;
  competitorMentions?: string[];
  citedDomains?: string[];
};

export type GeoVisibilityMetrics = {
  observations: number;
  mentions: number;
  mentionRate: number;
  citations: number;
  citationRate: number;
  links: number;
  linkRate: number;
  correctDescriptionRate: number | null;
  categoryAssociationRate: number | null;
};

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function calculateGeoVisibilityMetrics(
  observations: GeoObservation[],
): GeoVisibilityMetrics {
  const mentions = observations.filter((observation) => observation.mentioned).length;
  const citations = observations.filter((observation) => observation.cited === true).length;
  const links = observations.filter((observation) => observation.linked === true).length;
  const correctDescriptions = observations.filter(
    (observation) => observation.mentioned && observation.correctDescription === true,
  ).length;
  const categoryAssociations = observations.filter(
    (observation) => observation.mentioned && observation.categoryAssociated === true,
  ).length;

  return {
    observations: observations.length,
    mentions,
    mentionRate: rate(mentions, observations.length) ?? 0,
    citations,
    citationRate: rate(citations, observations.length) ?? 0,
    links,
    linkRate: rate(links, observations.length) ?? 0,
    correctDescriptionRate: rate(correctDescriptions, mentions),
    categoryAssociationRate: rate(categoryAssociations, mentions),
  };
}

export function calculateGeoVisibilityByEngine(
  observations: GeoObservation[],
): Record<string, GeoVisibilityMetrics> {
  const groups = new Map<string, GeoObservation[]>();
  for (const observation of observations) {
    const group = groups.get(observation.engine) ?? [];
    group.push(observation);
    groups.set(observation.engine, group);
  }
  return Object.fromEntries(
    [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([engine, group]) => [engine, calculateGeoVisibilityMetrics(group)]),
  );
}
