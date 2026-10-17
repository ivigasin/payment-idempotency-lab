export interface PayRequest {
  /** Idempotency key chosen by the client for one payment intent. v1 ignores it. */
  key: string;
  account: string;
  amount: number;
}

export type PayResult =
  | { status: 'succeeded'; paymentId: string }
  | { status: 'failed'; reason: string }
  /** The service does not know the outcome yet. The client must not create a new payment. */
  | { status: 'pending'; paymentId: string }
  /** The key was already used for a different request. */
  | { status: 'conflict'; reason: string };

export interface PaymentService {
  pay(request: PayRequest): Promise<PayResult>;
  /** Background job that settles payments with an unknown outcome. Optional. */
  reconcile?(): Promise<void>;
  /** What the service believes about the payment behind this key, after all work is done. */
  outcome?(key: string): 'succeeded' | 'failed' | 'pending' | 'none';
}
