// fast-check explores scenarios and interleavings that nobody writes by hand.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { noViolationsProperty, type ServiceFactory } from '../src/model.js';
import { KeyOnlyPaymentService, NaivePaymentService, SafePaymentService } from '../src/services.js';

// A fixed seed makes the run reproducible; change it (or remove it) to explore further.
const SEED = 20261026;

const v1: ServiceFactory = (bank) => new NaivePaymentService(bank);
const v2: ServiceFactory = (bank, pause) => new KeyOnlyPaymentService(bank, pause);
const v3: ServiceFactory = (bank, pause) => new SafePaymentService(bank, pause);

describe('I1 at-most-once: money leaves an account at most once per intent', () => {
  it.each([
    ['v1 (no key)', v1],
    ['v2 (key only)', v2],
  ])('is broken by %s', async (_name, make) => {
    const out = await fc.check(noViolationsProperty(make, 'I1 at-most-once'), { seed: SEED, numRuns: 1000 });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/I1 at-most-once/);
  });
});

describe('I2 agreement: after reconciliation the service agrees with the bank', () => {
  it.each([
    ['v1 (no key)', v1],
    ['v2 (key only)', v2],
  ])('is broken by %s', async (_name, make) => {
    const out = await fc.check(noViolationsProperty(make, 'I2 agreement'), { seed: SEED, numRuns: 1000 });
    expect(out.failed).toBe(true);
    expect(String(out.errorInstance)).toMatch(/I2 agreement/);
  });
});

describe('v3 (key + state + stable reference + reconciliation)', () => {
  it('holds both invariants', async () => {
    await fc.assert(noViolationsProperty(v3), { seed: SEED, numRuns: 2000 });
  });
});
