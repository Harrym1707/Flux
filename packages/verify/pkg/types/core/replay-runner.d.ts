import type { ReplayAdapter, ReplayInputCase, ReplayRecord, ReplayTarget } from "./types.js";
export type ReplayRunFailure = {
    id: string;
    side: "baseline" | "candidate";
    message: string;
};
export type ReplayRunResult = {
    records: ReplayRecord[];
    failures: ReplayRunFailure[];
};
export declare function runReplayCases(cases: ReplayInputCase[], baseline: ReplayTarget, candidate: ReplayTarget, adapter: ReplayAdapter): Promise<ReplayRunResult>;
