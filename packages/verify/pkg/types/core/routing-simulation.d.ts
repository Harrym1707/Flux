import type { ModelTarget } from "./types.js";
export type RoutingSimulationInput = {
    requestIds: string[];
    baseline: ModelTarget;
    candidate: ModelTarget;
    stages: Array<{
        rolloutPercentage: number;
        /** Synthetic failure rate for demonstrating the rollback gate. */
        candidateErrorRate: number;
    }>;
    maximumErrorRate: number;
    minimumSamples: number;
};
export type RoutingSimulationStage = {
    rolloutPercentage: number;
    assigned: number;
    candidateErrors: number;
    observedErrorRate: number | null;
    status: "advanced" | "rolled_back" | "insufficient_sample";
};
/** Stable FNV-1a assignment: the same request key always lands in the same cohort. */
export declare function rolloutBucket(requestId: string): number;
/** Offline only: simulates canary assignment and rollback using synthetic outcomes. */
export declare function simulateRouting(input: RoutingSimulationInput): RoutingSimulationStage[];
