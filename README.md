# payment-idempotency-lab

An idempotency key is necessary for safe payment retries. It is not sufficient.
This repository shows why, with code you can run.

It contains a fake partner bank that loses requests and responses, three versions
of a payment service, hand-written failure scenarios, and a model-based test with
[fast-check](https://fast-check.dev/) that searches for scenarios and interleavings
that break two invariants:

- **I1 at-most-once** — money leaves an account at most once per payment intent.
- **I2 agreement** — once the bank has recovered and reconciliation has run, nothing
  is left pending, and the service says "succeeded" exactly when the bank booked the transfer.

```bash
npm install
npm test        # 14 tests: hand-written scenarios + model-based check
npm run demo    # prints the smallest failing scenario fast-check finds for each version
```

## The fake bank

`FakePartnerBank` behaves the way the safe service needs a real partner to behave,
and fails the way real integrations fail:

- It never processes the same reference twice. A repeated reference gets a
  `DuplicateReference` error — which says the bank has seen it, not whether it was booked.
- It answers status queries by reference: `booked`, `rejected`, or `not-found`.
- On demand it rejects a transfer, loses the request (nothing booked, caller times out),
  or loses the response (transfer booked, caller times out). The caller cannot tell the
  last two apart.

## The three versions

| Version | What it does | What breaks |
| --- | --- | --- |
| v1 `NaivePaymentService` | No key. Every call is a new payment. | A duplicate request pays twice. A lost response leaves the customer charged while the service says no; a retry then pays twice. |
| v2 `KeyOnlyPaymentService` | Caches the response by idempotency key. | Two concurrent requests with the same key both miss the cache (check-then-act). A timeout is reported as "failed"; the retry reaches the bank with a **new** reference. A different body under the same key returns the old response. |
| v3 `SafePaymentService` | Key **plus** the four rules below. | Nothing found in 100,000 random scenarios per invariant (5 seeds × 20,000). |

What v3 adds on top of the key:

1. **Claim the key atomically before any side effect** — insert-if-absent, like a
   unique index or `SET NX`, not "read, then write later".
2. **Bind the key to the request body** — the same key with a different amount is a
   conflict. (The lab fingerprints account and amount; in production, hash the whole body.)
3. **Keep an explicit state per payment, including `unknown`** — a timeout is not a
   failure, and neither is "duplicate reference". The client gets `pending`, not
   `failed`, and must not create a new payment.
4. **Send the bank a stable reference per payment, and ask for its status before
   resending** — `booked` and `rejected` settle the payment; only `not-found` leads to a
   resend, always with the same reference.

## What fast-check finds

`npm run demo` with the default seed (`20261026`) prints, for v2:

```text
== v2 key only
  I1 at-most-once: BROKEN after 3 scenario(s), shrunk 6 times
    scenario: {"intents":[{"amount":1,"retries":0,"duplicate":true},{"amount":1,"retries":0,"duplicate":false}],"bank":[]}
    I1 at-most-once (acct_0): money left the account 2 times
    interleaving: 12 scheduled steps
  I2 agreement: BROKEN after 2 scenario(s), shrunk 5 times
    scenario: {"intents":[{"amount":1,"retries":0,"duplicate":false}],"bank":["lose-response"]}
    I2 agreement (acct_0): bank booked the transfer, service says it did not
    interleaving: 3 scheduled steps
```

The first scenario has a duplicate concurrent request and a bank that never fails
(`"bank":[]`). The second has one payment, no retry, and one lost response.
For v3 it prints `held in 2000 scenarios` for both invariants.

`scripts/mutants.sh` breaks v3 in four places, one at a time, and checks that the
model-based test catches each mutation:

```text
killed    new bank reference on every attempt                    (I1: charged twice)
killed    await between key lookup and insert (check-then-act)   (I1: charged twice)
killed    treat timeout as failure                               (I2: bank booked, service says no)
killed    resend without asking the bank first                   (I2: still pending — every resend gets "duplicate")
```

## What this does not prove

- fast-check **samples** scenarios and interleavings; it is not exhaustive model
  checking. "Not found in 100,000 runs" is evidence, not a proof.
- The safe design depends on the bank: it must never process one reference twice, and
  "not found" on a status query must mean the request never arrived. A real bank may
  report "not found" for a transfer still in flight, or forget references after some
  time. Confirm both properties, and the point after which "not found" is final, with
  your partner before relying on rule 4.
- Process crashes are not modelled. If the service dies after the bank books a transfer
  but before the state is saved, the payment stays `processing`. In production,
  reconciliation must also pick up payments stuck in `processing` for too long.
- The key store is in memory in one process. The atomic claim stands in for a unique
  constraint in a shared database.
- If the bank stays down, a payment stays `pending` for as long as it is down. That is
  correct; in production it needs an alert and a manual review queue.

## Layout

```text
src/bank.ts       fake partner bank
src/services.ts   v1, v2, v3
src/model.ts      scenario generator, invariants, fast-check property
test/             hand-written scenarios and the model-based check
scripts/          demo and mutation check
```

CI runs the type check, the tests and the mutation check on every push to `main`
and on every pull request.

## License

MIT
