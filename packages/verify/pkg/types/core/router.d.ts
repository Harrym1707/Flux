import type { RoutingDecision, RoutingPolicy } from "./types.js";
export type RouterContext = {
    taskClass?: string;
    requestHash?: string;
    random?: () => number;
};
export declare class SafeRouter {
    decide(policy: RoutingPolicy | undefined, ctx: RouterContext): RoutingDecision;
}
