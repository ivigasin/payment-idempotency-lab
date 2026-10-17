// Prints the smallest failing scenario fast-check finds for each service version.
//   npm run demo            fixed seed, reproducible
//   SEED=random npm run demo
import fc from 'fast-check';
import { noViolationsProperty, type ServiceFactory, type Violation } from '../src/model.js';
import { KeyOnlyPaymentService, NaivePaymentService, SafePaymentService } from '../src/services.js';

const seed = process.env.SEED === 'random' ? Date.now() : Number(process.env.SEED ?? 20261026);
const runs = Number(process.env.RUNS ?? 2000);

const versions: [string, ServiceFactory][] = [
  ['v1 no key', (bank) => new NaivePaymentService(bank)],
  ['v2 key only', (bank, pause) => new KeyOnlyPaymentService(bank, pause)],
  ['v3 key + state + stable reference + reconciliation', (bank, pause) => new SafePaymentService(bank, pause)],
];
const invariants: Violation['invariant'][] = ['I1 at-most-once', 'I2 agreement'];

console.log(`seed=${seed} runs=${runs}\n`);
for (const [name, make] of versions) {
  console.log(`== ${name}`);
  for (const invariant of invariants) {
    const out = await fc.check(noViolationsProperty(make, invariant), { seed, numRuns: runs });
    if (!out.failed) {
      console.log(`  ${invariant}: held in ${out.numRuns} scenarios`);
      continue;
    }
    const [scheduler, scenario] = out.counterexample!;
    console.log(`  ${invariant}: BROKEN after ${out.numRuns} scenario(s), shrunk ${out.numShrinks} times`);
    console.log(`    scenario: ${JSON.stringify(scenario)}`);
    console.log(`    ${String((out.errorInstance as Error).message)}`);
    console.log(`    interleaving: ${String(scheduler).split('\n').length - 1} scheduled steps`);
  }
  console.log();
}
