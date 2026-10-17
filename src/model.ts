/**
 * The model-based check: generate payment intents, client retries, duplicate concurrent
 * requests and bank misbehaviour; let fast-check's scheduler pick the interleaving;
 * then check two invariants.
 *
 *   I1 at-most-once:  money leaves each account at most once per payment intent.
 *   I2 agreement:     once the bank has recovered and reconciliation has run, the service's
 *                     answer matches the bank's books (it says "succeeded" exactly when the
 *                     bank booked the transfer, and nothing is left pending).
 */
import fc from 'fast-check';
import { FakePartnerBank, type BankBehaviour } from './bank.js';
import type { Pause } from './runtime.js';
import type { PayResult, PaymentService } from './types.js';

export interface Intent {
  amount: number;
  /** How many times the client retries after a "failed" answer. */
  retries: number;
  /** Send a second request with the same key at the same time (double click, LB retry). */
  duplicate: boolean;
}

export interface Scenario {
  intents: Intent[];
  /** Bank behaviour for successive transfer calls; "ok" once the list runs out. */
  bank: BankBehaviour[];
}

export const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  intents: fc.array(
    fc.record({
      amount: fc.integer({ min: 1, max: 1000 }),
      retries: fc.integer({ min: 0, max: 2 }),
      duplicate: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  bank: fc.array(
    fc.constantFrom<BankBehaviour>('ok', 'ok', 'reject', 'lose-response', 'lose-request'),
    { maxLength: 8 },
  ),
});

export type ServiceFactory = (bank: FakePartnerBank, pause: Pause) => PaymentService;

async function client(service: PaymentService, key: string, account: string, intent: Intent): Promise<PayResult> {
  let result = await service.pay({ key, account, amount: intent.amount });
  for (let attempt = 0; attempt < intent.retries && result.status === 'failed'; attempt++) {
    result = await service.pay({ key, account, amount: intent.amount });
  }
  return result;
}

export interface Violation {
  invariant: 'I1 at-most-once' | 'I2 agreement';
  account: string;
  detail: string;
}

/** Run one scenario under the given scheduler and return the violations found. */
export async function runScenario(
  makeService: ServiceFactory,
  scenario: Scenario,
  scheduler: fc.Scheduler,
): Promise<Violation[]> {
  const behaviours = [...scenario.bank];
  const pause: Pause = () => scheduler.schedule(Promise.resolve());
  const bank = new FakePartnerBank(() => behaviours.shift() ?? 'ok', pause);
  const service = makeService(bank, pause);

  const runs = scenario.intents.map((intent, i) => {
    const key = `key_${i}`;
    const account = `acct_${i}`;
    const calls = [client(service, key, account, intent)];
    if (intent.duplicate) calls.push(client(service, key, account, intent));
    return Promise.all(calls).then((results) => ({ key, account, results }));
  });
  const observed = await scheduler.waitFor(Promise.all(runs));

  // Background reconciliation until the bank has recovered. The scenario's bank misbehaviour
  // is finite (then it answers "ok"), so one round per remaining scripted behaviour, plus one,
  // is enough. With a bank that stays down, a payment stays pending for as long as it is down:
  // that is correct behaviour, and in production it needs an alert and a manual queue.
  if (service.reconcile) {
    for (let round = 0; round <= scenario.bank.length; round++) {
      await scheduler.waitFor(service.reconcile());
      if (observed.every(({ key }) => service.outcome?.(key) !== 'pending')) break;
    }
  }

  const violations: Violation[] = [];
  for (const { key, account, results } of observed) {
    const moved = bank.transfersTo(account);
    if (moved > 1) {
      violations.push({ invariant: 'I1 at-most-once', account, detail: `money left the account ${moved} times` });
    }
    // What does the service claim? Prefer its own record; v1 has none, so use the client's last answer.
    const claim = service.outcome
      ? service.outcome(key)
      : results.some((r) => r.status === 'succeeded')
        ? 'succeeded'
        : 'none';
    const charged = moved > 0;
    if (claim === 'pending') {
      violations.push({ invariant: 'I2 agreement', account, detail: 'still pending after reconciliation' });
    } else if ((claim === 'succeeded') !== charged) {
      violations.push({
        invariant: 'I2 agreement',
        account,
        detail: charged ? 'bank booked the transfer, service says it did not' : 'service says succeeded, bank has nothing',
      });
    }
  }
  return violations;
}

/**
 * fast-check property: no violations for any scenario and any interleaving.
 * Pass `only` to check a single invariant (fast-check shrinks to the simplest failure,
 * so without it a weaker service is usually reported for I2 first).
 */
export function noViolationsProperty(makeService: ServiceFactory, only?: Violation['invariant']) {
  return fc.asyncProperty(fc.scheduler(), scenarioArb, async (scheduler, scenario) => {
    const violations = (await runScenario(makeService, scenario, scheduler)).filter(
      (v) => !only || v.invariant === only,
    );
    if (violations.length > 0) {
      throw new Error(violations.map((v) => `${v.invariant} (${v.account}): ${v.detail}`).join('; '));
    }
  });
}
