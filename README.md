# payment-idempotency-lab

An idempotency key is necessary for safe payment retries. It is not sufficient.
This repository shows why, with code you can run.

It contains a fake partner bank that loses requests and responses, three versions
of a payment service, hand-written failure scenarios, and a model-based test with
[fast-check](https://fast-check.dev/) that searches for scenarios and interleavings
that break two invariants:

- **I1 at-most-once** — money leaves an account at most once per payment intent.
- **I2 agreement** — once the bank has recovered and reconciliation has run, the
  service says "succeeded" exactly when the bank booked the transfer.

```bash
npm install
npm test        # 13 tests: hand-written scenarios + model-based check
npm run demo    # prints the smallest failing scenario for each version
```

## The three versions

| Version | What it does | What breaks |
| --- | --- | --- |
| v1 `NaivePaymentService` | No key. Every call is a new payment. | A retry after a lost response pays twice. A double click pays twice. |
| v2 `KeyOnlyPaymentService` | Caches the response by idempotency key. | Two concurrent requests with the same key both miss the cache (check-then-act). A timeout is reported as "failed", the client retries, and the retry reaches the bank with a **new** reference. A lost response leaves the customer charged while the service says no. A different body under the same key returns the old response. |
| v3 `SafePaymentService` | Key **plus** the four things below. | Nothing found in 100,000 random scenarios per invariant (5 seeds × 20,000). |

What v3 adds on top of the key:

1. **Claim the key atomically before any side effect** — insert-if-absent, like a
   unique index or `SET NX`, not "read, then write later".
2. **Bind the key to the request body** — the same key with a different amount is a conflict.
3. **Keep an explicit state per payment, including `unknown`** — a timeout is not a failure.
   The client gets `pending`, not `failed`, and must not create a new payment.
4. **Send the bank a stable reference per payment, and reconcile before resending** —
   ask the bank for the status of that reference; resend only if it has no record,
   and always with the same reference so the bank can deduplicate.

## What fast-check finds

`npm run demo` with the default seed (`20261026`):

```text
== v1 no key
  I1 at-most-once: BROKEN — a duplicate request, bank working normally: charged twice
  I2 agreement:    BROKEN — one lost response: bank booked it, service says it did not
== v2 key only
  I1 at-most-once: BROKEN — two concurrent requests with the same key: charged twice
  I2 agreement:    BROKEN — one lost response: bank booked it, service says it did not
== v3
  I1 at-most-once: held in 2000 scenarios
  I2 agreement:    held in 2000 scenarios
```

`scripts/mutants.sh` breaks v3 in four places, one at a time, and checks that the
model-based test catches each mutation:

```text
killed    new bank reference on every attempt
killed    await between key lookup and insert (check-then-act)
killed    treat timeout as failure
killed    resend without asking the bank first
```

## What this does not prove

- fast-check **samples** scenarios and interleavings; it is not exhaustive model
  checking. "Not found in 100,000 runs" is evidence, not a proof.
- The fake bank books a transfer synchronously, so "not found" on a status query
  means the request never arrived. A real bank may report "not found" for a transfer
  that is still in flight. Before resending, you need the bank's own guarantee:
  deduplication by your reference, and a point after which "not found" is final.
- The key store is in memory in one process. The atomic claim stands in for a unique
  constraint in a shared database.
- If the bank stays down, a payment stays `pending` for as long as it is down. That
  is correct; in production it needs an alert and a manual review queue.

## Layout

```text
src/bank.ts       fake partner bank: dedup by reference, status query, lost requests/responses
src/services.ts   v1, v2, v3
src/model.ts      scenario generator, invariants, fast-check property
test/             hand-written scenarios and the model-based check
scripts/          demo and mutation check
```

## License

MIT
