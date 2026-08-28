import type { Context } from 'hono'
import { err } from './core.ts'
import {
  challenge402,
  requirements,
  type X402CustodySettlement,
} from './pay.ts'

export function x402NoPayResponse(
  c: Context,
  status: 409 | 503,
  error: string,
  retry: string,
) {
  return c.json({ error, retry, do_not_pay_again: true as const }, status)
}

export function x402CustodyFailureResponse(
  c: Context,
  reqs: ReturnType<typeof requirements>,
  result: Exclude<X402CustodySettlement, { status: 'verified' }>,
) {
  if (result.status === 'invalid') return challenge402(c, reqs, result.reason)
  if (result.status === 'unclassified') return err(c, 502, result.reason)
  return c.json({
    error: result.reason,
    retry: result.retry,
    do_not_pay_again: result.do_not_pay_again,
  }, result.status === 'unavailable' ? 503 : 409)
}
