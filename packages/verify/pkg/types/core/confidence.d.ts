/**
 * Confidence bounds for savings claims.
 *
 * Homed in core because every part of FLUX that asserts "quality held" needs the
 * same bound: the offline benchmark, and the replay gate that decides whether a
 * lossy reduction may be switched on for real traffic. One implementation, so
 * the statistics behind an invoice cannot drift from the statistics behind a
 * benchmark.
 */
export declare function mean(values: number[]): number;
/** Deterministic PRNG, so a bound is reproducible from its seed. */
export declare function seededRandom(seed: string): () => number;
/**
 * Lower confidence bound on a mean, resampling whole groups.
 *
 * Groups matter: several records can come from one prompt or one task, and
 * treating them as independent understates the spread and overstates the bound.
 */
export declare function groupBootstrapLowerBound(deltas: number[], groups: string[], samples: number, seed: string, alpha?: number): number;
/**
 * Simultaneous lower bounds across every candidate configuration.
 *
 * Scoring many candidates on one sample and keeping the best biases that winner
 * upward: a per-candidate bound holds for a configuration chosen in advance, not
 * for the maximum over a search. Measured on MMLU-Pro, the uncorrected bound let
 * configurations through that then lost up to 3.26 pp on held-out data while
 * reporting a safe bound.
 *
 * Groups are resampled once per draw and every candidate scored on that same
 * resample, so candidates stay correlated as they are in truth. Each deviation
 * is then divided by that candidate's own bootstrap standard error before the
 * maximum is taken. Studentising is not optional: an unscaled maximum lets
 * whichever candidate is noisiest set the band for the most precise one, which
 * was tried first and was wrong.
 */
export declare function simultaneousGroupBootstrapLowerBounds(deltasByConfiguration: number[][], groups: string[], samples: number, seed: string, alpha?: number): number[];
