/**
 * Every await in the lab goes through a `Pause`. In production code that is a plain
 * microtask; in tests fast-check's scheduler controls it, so it can reorder concurrent
 * requests and bank responses and search for the interleaving that breaks an invariant.
 */
export type Pause = () => Promise<void>;

export const noPause: Pause = () => Promise.resolve();

/** Deterministic ids, so a failing scenario replays exactly. */
export function idGenerator(prefix: string) {
  let n = 0;
  return () => `${prefix}_${++n}`;
}
