import { type TokenPrice } from "./cost.js";
import { type LeverRisk, type WorkloadProfile } from "./savings-model.js";
export type LeverCoverage = {
    leverId: string;
    description: string;
    risk: LeverRisk;
    /** The lever targets at least one segment this workload actually has. */
    applicable: boolean;
    /** Theo applies it to this workload today (it is in leversFor). */
    applied: boolean;
    /**
     * Projected saving from this lever alone on this workload, in USD and as a
     * share of the baseline. For an applied lever this is its marginal saving in
     * Theo's real stack; for an unapplied one it is the standalone projection. Both
     * are hypotheses from the lever's published evidence — never a realised saving.
     */
    projectedSavingUsd: number;
    projectedSavingPercent: number;
    /** Why an applicable lever is not applied. Absent when applied, or not applicable. */
    reason?: string;
};
export type CoverageReport = {
    workload: string;
    baselineCostUsd: number;
    /** Theo's actual stacked projection on this workload (what leversFor delivers). */
    realizedSavingUsd: number;
    realizedSavingPercent: number;
    /** The part of the realized saving that cannot change an answer — live immediately. */
    realizedDeterministicPercent: number;
    /** The part that needs a replay proof within the quality ceiling before it is enabled. */
    realizedNeedsVerificationPercent: number;
    /** Catalogue levers that can touch this workload (N). */
    applicableLevers: number;
    /** Of those, how many Theo applies (M). */
    appliedLevers: number;
    /** M / N as a percentage — the headline coverage figure. */
    leverCoveragePercent: number;
    /** Every catalogue lever, applied or not, sorted by projected headroom descending. */
    levers: LeverCoverage[];
    /** Applicable levers Theo does not apply, each with a reason. Sorted by headroom. */
    gaps: LeverCoverage[];
};
/**
 * Measure how much of the lever catalogue Theo reaches on one workload profile.
 *
 * Deterministic: the same profile, price and catalogue always produce the same
 * report, so it is safe to diff across builds and to assert on in tests.
 */
export declare function coverageForProfile(profile: WorkloadProfile, price: TokenPrice): CoverageReport;
