/** A seeded random source: returns numbers in [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast and good enough for game randomness. */
export function createRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform number in [lo, hi). */
export const uniform = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

/** Normal distribution with mean 0 and the given standard deviation (Box-Muller). */
export function gauss(rng: Rng, sd = 1): number {
  const u = Math.max(rng(), 1e-12);
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** True with probability p. */
export const chance = (rng: Rng, p: number) => rng() < p;
