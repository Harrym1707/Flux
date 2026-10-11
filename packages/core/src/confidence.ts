import { createHash } from "node:crypto";

/**
 * Confidence bounds for savings claims.
 *
 * Homed in core because every part of FLUX that asserts "quality held" needs the
 * same bound: the offline benchmark, and the replay gate that decides whether a
 * lossy reduction may be switched on for real traffic. One implementation, so
 * the statistics behind an invoice cannot drift from the statistics behind a
 * benchmark.
 */

export function mean(values: number[]): number {
  if (values.length === 0) throw new Error("Cannot take the mean of an empty set.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Deterministic PRNG, so a bound is reproducible from its seed. */
export function seededRandom(seed: string): () => number {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * Lower confidence bound on a mean, resampling whole groups.
 *
 * Groups matter: several records can come from one prompt or one task, and
 * treating them as independent understates the spread and overstates the bound.
 */
export function groupBootstrapLowerBound(
  deltas: number[],
  groups: string[],
  samples: number,
  seed: string,
  alpha = 0.05,
): number {
  if (deltas.length !== groups.length) {
    throw new Error("Each delta needs exactly one group label.");
  }
  if (deltas.length === 0) throw new Error("A bound needs at least one observation.");
  const grouped = new Map<string, number[]>();
  deltas.forEach((delta, index) => {
    const key = groups[index]!;
    const values = grouped.get(key) ?? [];
    values.push(delta);
    grouped.set(key, values);
  });
  const groupValues = [...grouped.values()];
  const random = seededRandom(seed);
  const distribution = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    let count = 0;
    for (let draw = 0; draw < groupValues.length; draw += 1) {
      const selected = groupValues[Math.floor(random() * groupValues.length)]!;
      for (const value of selected) {
        total += value;
        count += 1;
      }
    }
    distribution[sample] = total / count;
  }
  distribution.sort((left, right) => left - right);
  return distribution[Math.floor((samples - 1) * alpha)]!;
}

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
export function simultaneousGroupBootstrapLowerBounds(
  deltasByConfiguration: number[][],
  groups: string[],
  samples: number,
  seed: string,
  alpha = 0.05,
): number[] {
  const configurations = deltasByConfiguration.length;
  if (configurations === 0) return [];
  if (deltasByConfiguration.some((deltas) => deltas.length !== groups.length)) {
    throw new Error("Every configuration needs one delta per validation record.");
  }
  const indicesByGroup = new Map<string, number[]>();
  groups.forEach((group, index) => {
    const list = indicesByGroup.get(group) ?? [];
    list.push(index);
    indicesByGroup.set(group, list);
  });
  const groupIndices = [...indicesByGroup.values()];
  const pointEstimates = deltasByConfiguration.map((deltas) => mean(deltas));
  const random = seededRandom(seed);

  const resampleMeans: number[][] = new Array(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    const totals = new Array<number>(configurations).fill(0);
    let count = 0;
    for (let draw = 0; draw < groupIndices.length; draw += 1) {
      const selected = groupIndices[Math.floor(random() * groupIndices.length)]!;
      for (const index of selected) {
        for (let configuration = 0; configuration < configurations; configuration += 1) {
          totals[configuration] += deltasByConfiguration[configuration]![index]!;
        }
        count += 1;
      }
    }
    for (let configuration = 0; configuration < configurations; configuration += 1) {
      totals[configuration] /= count;
    }
    resampleMeans[sample] = totals;
  }

  const standardErrors = new Array<number>(configurations);
  for (let configuration = 0; configuration < configurations; configuration += 1) {
    let sumSquares = 0;
    for (let sample = 0; sample < samples; sample += 1) {
      const deviation = resampleMeans[sample]![configuration]! - pointEstimates[configuration]!;
      sumSquares += deviation * deviation;
    }
    standardErrors[configuration] = Math.sqrt(sumSquares / Math.max(1, samples - 1)) || Number.EPSILON;
  }

  const errors = new Array<number>(samples);
  for (let sample = 0; sample < samples; sample += 1) {
    let worst = Number.NEGATIVE_INFINITY;
    for (let configuration = 0; configuration < configurations; configuration += 1) {
      const studentised =
        (pointEstimates[configuration]! - resampleMeans[sample]![configuration]!) / standardErrors[configuration]!;
      if (studentised > worst) worst = studentised;
    }
    errors[sample] = worst;
  }
  errors.sort((left, right) => left - right);
  const critical = errors[Math.min(samples - 1, Math.ceil((samples - 1) * (1 - alpha)))]!;
  return pointEstimates.map((estimate, configuration) => estimate - critical * standardErrors[configuration]!);
}
