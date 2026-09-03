export const MERCHANT_REGISTRATION_CLIENT_CLASSES = [
  'hosted_browser',
  'coding_persistent',
  'coding_ephemeral',
  'oauth_refused',
] as const

export type MerchantRegistrationClientClass =
  typeof MERCHANT_REGISTRATION_CLIENT_CLASSES[number]
export type MerchantRegistrationResumeClientClass =
  MerchantRegistrationClientClass | 'legacy_unknown'

export const MARKET_IDENTITY_ATTEMPT_KINDS = [
  'join_stage',
  'join_confirm',
  'recovery_generate',
  'recovery_begin',
  'recovery_confirm',
  'rotation_begin',
  'rotation_confirm',
  'pair_create',
] as const
export type MarketIdentityAttemptKind = typeof MARKET_IDENTITY_ATTEMPT_KINDS[number]

export interface MerchantRegistrationStageInput {
  sessionHash: string
  csrfHash: string
  ipHash: string
  handle: string
  model: string
  clientClass: MerchantRegistrationClientClass
  merchantSecretHash: string
  recoveryCodeHashes: string[]
}

export interface IdentityMerchantResult {
  merchantId: number
  handle: string
}

export type MerchantRegistrationStageResult =
  | { status: 'staged'; handle: string }
  | { status: 'handle_taken' }
  | { status: 'request_unavailable' }

export type MerchantRegistrationProgressResult =
  | { status: 'new' }
  | { status: 'staged'; handle: string; clientClass: MerchantRegistrationResumeClientClass }
  | ({ status: 'confirmed' } & IdentityMerchantResult)
  | { status: 'canceled' }
  | { status: 'expired' }
  | { status: 'unavailable' }

export type MerchantRegistrationConfirmationResult =
  | ({ status: 'confirmed' } & IdentityMerchantResult)
  | { status: 'credential_rejected' }
  | { status: 'handle_taken' }
  | { status: 'request_unavailable' }

export interface MerchantRecoveryGenerationResult extends IdentityMerchantResult {
  generation: number
}

export type MerchantRecoveryStageResult =
  | { status: 'staged'; handle: string }
  | { status: 'credential_rejected' }

export type MerchantRecoveryProgressResult =
  | { status: 'new' }
  | ({ status: 'staged' | 'recovered' } & IdentityMerchantResult)
  | { status: 'canceled' | 'expired' | 'invalidated' | 'unavailable' }

export type MerchantRecoveryConfirmationResult =
  | ({ status: 'recovered' } & IdentityMerchantResult)
  | { status: 'credential_rejected' }
  | { status: 'request_unavailable' }

export type MerchantRotationStageResult =
  | ({ status: 'staged' } & IdentityMerchantResult)
  | { status: 'credential_rejected' }
  | { status: 'request_unavailable' }

export type MerchantRotationProgressResult =
  | { status: 'new' }
  | ({ status: 'staged' | 'rotated' } & IdentityMerchantResult)
  | { status: 'canceled' | 'expired' | 'invalidated' | 'unavailable' }

export type MerchantRotationConfirmationResult =
  | ({ status: 'rotated' } & IdentityMerchantResult)
  | { status: 'credential_rejected' }
  | { status: 'rate_limited' }
  | { status: 'request_unavailable' }
