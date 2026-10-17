import { noPause, type Pause } from './runtime.js';

/**
 * What the partner bank does with one transfer request.
 * - ok: books the transfer and answers.
 * - reject: refuses before booking anything. The outcome is known: no money moved.
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

export interface BookedTransfer {
  bankTxId: string;
  reference: string;
  account: string;
  amount: number;
}

/**
 * A partner bank with the two properties real ones usually have:
 * 1. It deduplicates by the caller's reference (an end-to-end id): the same reference
 *    is booked at most once.
 * 2. It answers status queries by that reference.
 * It also loses responses on demand.
 */
export class FakePartnerBank {
  readonly booked: BookedTransfer[] = [];
  private readonly byReference = new Map<string, BookedTransfer>();
  private nextTx = 0;

  constructor(
    private readonly nextBehaviour: () => BankBehaviour = () => 'ok',
    private readonly pause: Pause = noPause,
  ) {}

  async transfer(reference: string, account: string, amount: number): Promise<{ bankTxId: string }> {
    await this.pause(); // request travels to the bank
    const behaviour = this.nextBehaviour();
    if (behaviour === 'reject') throw new BankRejected();
    if (behaviour === 'lose-request') throw new BankTimeout();

    let tx = this.byReference.get(reference);
    if (!tx) {
      tx = { bankTxId: `bank_tx_${++this.nextTx}`, reference, account, amount };
      this.booked.push(tx);
      this.byReference.set(reference, tx);
    }

    await this.pause(); // response travels back
    if (behaviour === 'lose-response') throw new BankTimeout();
    return { bankTxId: tx.bankTxId };
  }

  async status(reference: string): Promise<'booked' | 'not-found'> {
    await this.pause();
    return this.byReference.has(reference) ? 'booked' : 'not-found';
  }

  /** How many times money actually left this account. */
  transfersTo(account: string): number {
    return this.booked.filter((t) => t.account === account).length;
  }
}
