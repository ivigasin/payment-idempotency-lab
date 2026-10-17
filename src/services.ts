import { BankRejected, type FakePartnerBank } from './bank.js';
import { idGenerator, noPause, type Pause } from './runtime.js';
import type { PayRequest, PayResult, PaymentService } from './types.js';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * v1: no idempotency at all. Every call is a new payment with a new bank reference.
 * A client retry after a lost response pays twice.
 */
export class NaivePaymentService implements PaymentService {
  private readonly newId = idGenerator('pay');

  constructor(private readonly bank: FakePartnerBank) {}

  async pay({ account, amount }: PayRequest): Promise<PayResult> {
    const paymentId = this.newId();
    try {
      await this.bank.transfer(`ref_${paymentId}`, account, amount);
      return { status: 'succeeded', paymentId };
    } catch (e) {
      return { status: 'failed', reason: message(e) };
    }
  }
}

/**
 * v2: the textbook idempotency key. The service caches the response by key and returns
 * it on a repeat. What is missing:
 * - check-then-act: two concurrent requests with the same key both miss the cache;
 * - only success is cached, and a timeout is reported as a failure, so the client
 *   retries, and the retry goes to the bank with a NEW reference;
 * - the key is not bound to the request body.
 */
export class KeyOnlyPaymentService implements PaymentService {
  private readonly newId = idGenerator('pay');
  private readonly responses = new Map<string, PayResult>();

  constructor(
    private readonly bank: FakePartnerBank,
    private readonly pause: Pause = noPause,
  ) {}

  async pay({ key, account, amount }: PayRequest): Promise<PayResult> {
    await this.pause(); // read from the key store
    const cached = this.responses.get(key);
    if (cached) return cached;

    const paymentId = this.newId();
    try {
      await this.bank.transfer(`ref_${paymentId}`, account, amount);
      const result: PayResult = { status: 'succeeded', paymentId };
      await this.pause(); // write to the key store
      this.responses.set(key, result);
      return result;
    } catch (e) {
      // Not cached, so the client can try again.
      return { status: 'failed', reason: message(e) };
    }
  }

  outcome(key: string) {
    return this.responses.get(key)?.status === 'succeeded' ? ('succeeded' as const) : ('none' as const);
  }
}

type PaymentState = 'processing' | 'succeeded' | 'failed' | 'unknown';

interface Payment {
  id: string;
  key: string;
  fingerprint: string;
  account: string;
  amount: number;
  /** Stable reference sent to the bank on every attempt for this payment. */
  reference: string;
  state: PaymentState;
}

/**
 * v3: the key is necessary but not sufficient. On top of it:
 * 1. Claim the key atomically (insert-if-absent, like a unique index), before any side effect.
 * 2. Bind the key to the request body; a different body under the same key is a conflict.
 * 3. Keep an explicit state per payment, including "unknown" after a timeout.
 * 4. Send the bank a stable reference per payment, never per attempt.
 * 5. Never blindly resend an unknown payment: ask the bank for its status first
 *    (reconciliation), and only resend with the same reference.
 */
export class SafePaymentService implements PaymentService {
  private readonly newId = idGenerator('pay');
  private readonly byKey = new Map<string, Payment>();

  constructor(
    private readonly bank: FakePartnerBank,
    private readonly pause: Pause = noPause,
  ) {}

  async pay(request: PayRequest): Promise<PayResult> {
    const fingerprint = `${request.account}:${request.amount}`;
    await this.pause(); // round trip to the key store

    // Atomic claim: lookup and insert happen without an await in between,
    // which is what a unique constraint or SETNX gives you in a real store.
    const existing = this.byKey.get(request.key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { status: 'conflict', reason: 'idempotency key reused with a different request' };
      }
      return this.view(existing);
    }
    const id = this.newId();
    const payment: Payment = {
      id,
      key: request.key,
      fingerprint,
      account: request.account,
      amount: request.amount,
      reference: `ref_${id}`,
      state: 'processing',
    };
    this.byKey.set(request.key, payment);

    await this.send(payment);
    return this.view(payment);
  }

  /** Settle every payment whose outcome is unknown. Safe to run repeatedly and concurrently with pay(). */
  async reconcile(): Promise<void> {
    for (const payment of this.byKey.values()) {
      if (payment.state !== 'unknown') continue;
      const status = await this.bank.status(payment.reference);
      if (status === 'booked') {
        payment.state = 'succeeded';
      } else if (status === 'rejected') {
        payment.state = 'failed';
      } else {
        // The bank has no record of this reference. Resending with the SAME reference
        // is safe: the bank never processes one reference twice.
        await this.send(payment);
      }
    }
  }

  outcome(key: string) {
    const payment = this.byKey.get(key);
    if (!payment) return 'none' as const;
    if (payment.state === 'succeeded' || payment.state === 'failed') return payment.state;
    return 'pending' as const;
  }

  private async send(payment: Payment): Promise<void> {
    try {
      await this.bank.transfer(payment.reference, payment.account, payment.amount);
      payment.state = 'succeeded';
    } catch (e) {
      // A rejection is a known outcome. A timeout is not: the money may have moved.
      // Neither is "duplicate reference": the bank has seen it, but did it book it?
      payment.state = e instanceof BankRejected ? 'failed' : 'unknown';
    }
  }

  private view(payment: Payment): PayResult {
    switch (payment.state) {
      case 'succeeded':
        return { status: 'succeeded', paymentId: payment.id };
      case 'failed':
        return { status: 'failed', reason: 'bank rejected the transfer' };
      default:
        return { status: 'pending', paymentId: payment.id };
    }
  }
}
