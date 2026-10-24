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
export declare function calculateGeoVisibilityMetrics(observations: GeoObservation[]): GeoVisibilityMetrics;
export declare function calculateGeoVisibilityByEngine(observations: GeoObservation[]): Record<string, GeoVisibilityMetrics>;
