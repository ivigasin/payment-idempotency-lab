// Hand-written scenarios, one per failure mode. Read these first.
import { describe, expect, it } from 'vitest';
import { FakePartnerBank, type BankBehaviour } from '../src/bank.js';
import { KeyOnlyPaymentService, NaivePaymentService, SafePaymentService } from '../src/services.js';

const bankWith = (...behaviours: BankBehaviour[]) => new FakePartnerBank(() => behaviours.shift() ?? 'ok');
const req = { key: 'order-42', account: 'acct_1', amount: 100 };

describe('lost response, then the client retries', () => {
  it('v1 (no key) pays twice', async () => {
    const bank = bankWith('lose-response');
    const service = new NaivePaymentService(bank);
    expect((await service.pay(req)).status).toBe('failed'); // timeout, but the bank booked it
    expect((await service.pay(req)).status).toBe('succeeded'); // retry = second payment
    expect(bank.transfersTo('acct_1')).toBe(2);
  });

  it('v2 (key only) still pays twice: the retry goes to the bank with a new reference', async () => {
    const bank = bankWith('lose-response');
    const service = new KeyOnlyPaymentService(bank);
    expect((await service.pay(req)).status).toBe('failed');
    expect((await service.pay(req)).status).toBe('succeeded');
    expect(bank.transfersTo('acct_1')).toBe(2);
  });

  it('v3 answers "pending", does not resend, and reconciliation finds the booked transfer', async () => {
    const bank = bankWith('lose-response');
    const service = new SafePaymentService(bank);
    expect((await service.pay(req)).status).toBe('pending');
    expect((await service.pay(req)).status).toBe('pending'); // retry with the same key: no new transfer
    expect(bank.transfersTo('acct_1')).toBe(1);
    await service.reconcile();
    expect((await service.pay(req)).status).toBe('succeeded');
    expect(bank.transfersTo('acct_1')).toBe(1);
  });
});

describe('two requests with the same key at the same time', () => {
  it('v2 pays twice: both requests miss the cache before either writes it', async () => {
    const bank = bankWith();
    const service = new KeyOnlyPaymentService(bank);
    const [a, b] = await Promise.all([service.pay(req), service.pay(req)]);
    expect([a.status, b.status]).toEqual(['succeeded', 'succeeded']);
    expect(bank.transfersTo('acct_1')).toBe(2);
  });

  it('v3 pays once: the key is claimed atomically before the bank call', async () => {
    const bank = bankWith();
    const service = new SafePaymentService(bank);
    const results = await Promise.all([service.pay(req), service.pay(req)]);
    expect(results.map((r) => r.status).sort()).toEqual(['pending', 'succeeded']);
    expect(bank.transfersTo('acct_1')).toBe(1);
  });
});

describe('same key, different request', () => {
  it('v2 silently returns the first response for a different amount', async () => {
    const service = new KeyOnlyPaymentService(bankWith());
    await service.pay(req);
    expect((await service.pay({ ...req, amount: 999 })).status).toBe('succeeded');
  });

  it('v3 rejects it as a conflict', async () => {
    const service = new SafePaymentService(bankWith());
    await service.pay(req);
    expect((await service.pay({ ...req, amount: 999 })).status).toBe('conflict');
  });
});

describe('the request never reached the bank', () => {
  it('v3 sees the same timeout, asks the bank, and resends once with the same reference', async () => {
    const bank = bankWith('lose-request');
    const service = new SafePaymentService(bank);
    expect((await service.pay(req)).status).toBe('pending');
    expect(bank.transfersTo('acct_1')).toBe(0); // nothing booked
    await service.reconcile(); // status: not-found -> resend with the same reference
    await service.reconcile(); // running it again changes nothing
    expect(bank.transfersTo('acct_1')).toBe(1);
    expect(service.outcome(req.key)).toBe('succeeded');
  });
});
