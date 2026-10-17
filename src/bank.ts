import { noPause, type Pause } from './runtime.js';

/**
 * What the partner bank does with one transfer request that carries a NEW reference.
 * - ok: books the transfer and answers.
 * - reject: refuses before booking anything, and says so. No money moved.
 * - lose-response: books the transfer, then the answer never arrives (timeout,
 *   dropped connection, crashed caller). The money moved; the caller does not know it.
 * - lose-request: the request never reaches the bank. Nothing is booked, and the caller
 *   sees exactly the same timeout as with lose-response.
 */
export type BankBehaviour = 'ok' | 'reject' | 'lose-response' | 'lose-request';

export class BankRejected extends Error {
  constructor() {
    super('bank rejected the transfer');
  }
}

export class BankTimeout extends Error {
  constructor() {
    super('no response from the bank');
  }
}

/**
 * The reference was already used. Like many real APIs, the bank does not say what
 * happened to the original request (booked? rejected?), only that it has seen it.
 */
export class DuplicateReference extends Error {
  constructor() {
    super('duplicate reference');
  }
}

export interface BookedTransfer {
  bankTxId: string;
  reference: string;
  account: string;
  amount: number;
}

export type ReferenceStatus = 'booked' | 'rejected' | 'not-found';

/**
 * A partner bank with the properties the safe service relies on:
 * 1. It never processes the same reference twice. A repeat gets a DuplicateReference
 *    error, not the original result.
 * 2. It answers status queries by reference: booked, rejected, or not found.
 * It also loses requests and responses on demand.
 */
export class FakePartnerBank {
  readonly booked: BookedTransfer[] = [];
  private readonly seen = new Map<string, ReferenceStatus>();
  private nextTx = 0;

  constructor(
    private readonly nextBehaviour: () => BankBehaviour = () => 'ok',
    private readonly pause: Pause = noPause,
  ) {}

  async transfer(reference: string, account: string, amount: number): Promise<{ bankTxId: string }> {
    await this.pause(); // request travels to the bank
    const behaviour = this.nextBehaviour();
    if (behaviour === 'lose-request') throw new BankTimeout();
    if (this.seen.has(reference)) throw new DuplicateReference();

    if (behaviour === 'reject') {
      this.seen.set(reference, 'rejected');
      throw new BankRejected();
    }
    const tx: BookedTransfer = { bankTxId: `bank_tx_${++this.nextTx}`, reference, account, amount };
    this.booked.push(tx);
    this.seen.set(reference, 'booked');

    await this.pause(); // response travels back
    if (behaviour === 'lose-response') throw new BankTimeout();
    return { bankTxId: tx.bankTxId };
  }

  async status(reference: string): Promise<ReferenceStatus> {
    await this.pause();
    return this.seen.get(reference) ?? 'not-found';
  }

  /** How many times money actually left this account. */
  transfersTo(account: string): number {
    return this.booked.filter((t) => t.account === account).length;
  }
}
