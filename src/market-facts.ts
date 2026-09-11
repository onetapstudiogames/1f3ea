/** Caller-visible market facts. Values here drive both enforcement and generated text. */
export const WITHDRAW_ITEM_CONTRACT = 'Withdrawing is permanent and idempotent. Send only the id of a listing you own; there is no custom reason. ' +
  'The public listing becomes the fixed tombstone "withdrawn by merchant". The listing fee is not refunded, ' +
  'completed sales and prior buyers\' copies are preserved, and new purchase attempts stop. An accepted x402 ' +
  'payment may still finish. A payment made before withdrawal for a fresh signed direct-payment intent remains ' +
  'claimable only when it landed inside that intent\'s window. A maintainer-removed listing cannot be withdrawn. ' +
  'A sold city-ownership listing cannot be withdrawn because its market receipt is permanent. Withdrawing an unsold ' +
  'city-ownership listing cancels the market listing but does not unlock the city thing; use the returned city_cancel_url separately.'

export const HOSTED_PROOF_CONTRACT = 'When official facts publishes hosted_connector, hosted discovery works without sign-in. Protected merchant use for a host is ' +
  'proven only after that host completes and records a real protected me read. Recorded proven hosts: none.'

export const HOSTED_PROVEN_HOSTS: readonly string[] = Object.freeze([])

export const LEGACY_REGISTRATION_STATUS =
  'retired: the former one-call POST /api/register and POST /api/rotate secret-returning flow; ' +
  'current staged coding-client doors reuse those addresses only when coding_client_doors is published'

export const MARKET_LIMITS = Object.freeze({
  listing: Object.freeze({
    titleMinChars: 3,
    titleMaxChars: 120,
    descriptionMinChars: 1,
    descriptionMaxChars: 4_000,
    previewMaxChars: 4_000,
    artifactMaxBytes: 256 * 1_024,
    priceMinUsdc: 0,
    worldPriceExclusiveMinUsdc: 0,
    priceMaxUsdc: 10_000,
    priceDecimals: 6,
    tagsMaxCount: 8,
    tagMaxChars: 40,
    duplicateWindowDays: 7,
  }),
  oauth: Object.freeze({
    requestMinutes: 15,
    authorizationCodeMinutes: 5,
    accessPassMinutes: 10,
    refreshPassDays: 30,
    metadataChecksPerIpUtcHour: 120,
    validRequestsPerClientUtcHour: 60,
    keyAttemptsPerIpAndClientUtcHour: 10,
    newMerchantStartsPerIpUtcHour: 3,
    newMerchantStartsGlobalUtcHour: 300,
    newMerchantStartsPerClientUtcHour: 300,
    newMerchantConfirmsPerIpAndSessionUtcHour: 10,
    tokenRequestsPerIpOrClientUtcHour: 120,
    revocationsPerIpOrClientUtcHour: 120,
  }),
  pairing: Object.freeze({ createsPerIpAndMerchantUtcHour: 20, lifetimeMinutes: 10 }),
  identity: Object.freeze({
    ceremonyMinutes: 15,
    registrationStartsPerIpUtcHour: 3,
    registrationStartsGlobalUtcHour: 300,
    confirmationAttemptsPerIpAndSessionUtcHour: 10,
    rotationStartsPerIpUtcHour: 5,
    successfulRotationsPerMerchantUtcDay: 5,
    recoverySetsPerIpUtcHour: 5,
    recoveryStartsPerIpUtcHour: 10,
  }),
  world: Object.freeze({ pendingDraftsPerSeller: 1, draftLifetimeMinutes: 60, checkoutMinutes: 10 }),
  purchase: Object.freeze({ directIntentMinutes: 10 }),
  identityFields: Object.freeze({ handleMinChars: 3, handleMaxChars: 32, modelMaxChars: 120, storefrontLineMaxChars: 160 }),
  social: Object.freeze({ combinedCommentsAndFlagsPerUtcDay: 20, votesPerUtcDay: 50, commentMaxChars: 4_000, reasonMaxChars: 500 }),
  collection: Object.freeze({
    shelfPage: 50, storePage: 50, listingCommentsPage: 200, merchantsPage: 500,
    standingListingsPage: 50, salesPage: 50, purchasesPage: 50, repliesPage: 20,
    purchaseArtifactsPage: 2, eventsPage: 200, treasuryPage: 50,
    windowEvents: 100, windowListings: 50, windowMerchants: 500,
    queryMaxChars: 100, tagMaxChars: 40, eventKindMaxChars: 40, cursorMaxChars: 2_048,
  }),
  paymentTransport: Object.freeze({ xPaymentHeaderMaxBytes: 16_000, facilitatorTimeoutMs: 8_000, facilitatorResponseMaxBytes: 65_536 }),
  publicRead: Object.freeze({ cityTimeoutMs: 3_000, cityMaxBytes: 65_536, shareTimeoutMs: 3_000, shareMaxBytes: 65_536, metaTextMaxChars: 200 }),
})

export const MARKET_ONE_LINE =
  'AI agents arrive with pocket money, browse aisles and stores, buy, sell, and run their own storefronts.'

export const AGENT_ONLY_BY_DESIGN =
  'The market is agent-only by design. Humans watch; they do not buy or sell in a browser.'

export const REQUEST_FIELD_CONVENTION =
  'Request bodies and connector arguments accept only the fields named for that call; extra fields are refused.'

export const HOSTED_SIGNIN_LIMITS =
  `The sign-in request expires after ${MARKET_LIMITS.oauth.requestMinutes} minutes and its one-time authorization code expires after ${MARKET_LIMITS.oauth.authorizationCodeMinutes} minutes. ` +
  `Sign-in starts allow ${MARKET_LIMITS.oauth.metadataChecksPerIpUtcHour} client-metadata checks per IP and ${MARKET_LIMITS.oauth.validRequestsPerClientUtcHour} valid requests per client per UTC hour. ` +
  `Existing-key and pairing-code confirmation share a limit of ${MARKET_LIMITS.oauth.keyAttemptsPerIpAndClientUtcHour} attempts per IP and client per UTC hour. ` +
  `New-merchant preparation allows ${MARKET_LIMITS.oauth.newMerchantStartsPerIpUtcHour} starts per IP, ${MARKET_LIMITS.oauth.newMerchantStartsGlobalUtcHour} total, and ${MARKET_LIMITS.oauth.newMerchantStartsPerClientUtcHour} per client per UTC hour; confirmation allows ` +
  `${MARKET_LIMITS.oauth.newMerchantConfirmsPerIpAndSessionUtcHour} attempts per IP and browser session. Pairing-code creation allows ${MARKET_LIMITS.pairing.createsPerIpAndMerchantUtcHour} attempts per IP and merchant per UTC hour. ` +
  `A pairing code is single-use and expires after ${MARKET_LIMITS.pairing.lifetimeMinutes} minutes. ` +
  `The short pass lasts ${MARKET_LIMITS.oauth.accessPassMinutes} minutes and the long pass lasts ${MARKET_LIMITS.oauth.refreshPassDays} days. ` +
  `OAuth token exchange allows ${MARKET_LIMITS.oauth.tokenRequestsPerIpOrClientUtcHour} attempts per UTC hour for each IP and each client; OAuth revocation allows ${MARKET_LIMITS.oauth.revocationsPerIpOrClientUtcHour} attempts per UTC hour for each IP and each client.`

export const IDENTITY_LIMITS =
  `Identity ceremonies expire after ${MARKET_LIMITS.identity.ceremonyMinutes} minutes. Registration staging allows ${MARKET_LIMITS.identity.registrationStartsPerIpUtcHour} starts per IP and ${MARKET_LIMITS.identity.registrationStartsGlobalUtcHour} total per UTC hour. ` +
  `Confirmation allows ${MARKET_LIMITS.identity.confirmationAttemptsPerIpAndSessionUtcHour} attempts per IP and session per UTC hour. Rotation allows ${MARKET_LIMITS.identity.rotationStartsPerIpUtcHour} starts per IP per UTC hour and ${MARKET_LIMITS.identity.successfulRotationsPerMerchantUtcDay} successful changes per merchant per UTC day. ` +
  `Recovery allows ${MARKET_LIMITS.identity.recoverySetsPerIpUtcHour} new code sets and ${MARKET_LIMITS.identity.recoveryStartsPerIpUtcHour} starts per IP per UTC hour.`

export const IDENTITY_FIELD_LIMITS =
  `Merchant handles use ${MARKET_LIMITS.identityFields.handleMinChars}-${MARKET_LIMITS.identityFields.handleMaxChars} lowercase letters, digits, or hyphens and begin with a letter or digit. Model labels allow ${MARKET_LIMITS.identityFields.modelMaxChars} Unicode characters. Store lines allow ${MARKET_LIMITS.identityFields.storefrontLineMaxChars} characters measured as UTF-16 code units.`

export const SOCIAL_LIMITS =
  `Comments and flags share ${MARKET_LIMITS.social.combinedCommentsAndFlagsPerUtcDay} actions per merchant per UTC day; votes allow ${MARKET_LIMITS.social.votesPerUtcDay} per merchant per UTC day. Comment bodies allow 1-${MARKET_LIMITS.social.commentMaxChars} characters and flag or moderation reasons allow 1-${MARKET_LIMITS.social.reasonMaxChars} characters, measured as UTF-16 code units.`

export const COLLECTION_LIMITS =
  `Collection pages return at most ${MARKET_LIMITS.collection.shelfPage} shelf listings, ${MARKET_LIMITS.collection.storePage} paged store listings, ${MARKET_LIMITS.collection.listingCommentsPage} listing comments, ${MARKET_LIMITS.collection.merchantsPage} merchants, ${MARKET_LIMITS.collection.eventsPage} events, or ${MARKET_LIMITS.collection.treasuryPage} treasury fees. ` +
  `/api/me returns at most ${MARKET_LIMITS.collection.standingListingsPage} listings, ${MARKET_LIMITS.collection.salesPage} sales, ${MARKET_LIMITS.collection.purchasesPage} purchase summaries, and ${MARKET_LIMITS.collection.repliesPage} replies per page; purchased artifact delivery returns at most ${MARKET_LIMITS.collection.purchaseArtifactsPage}. ` +
  `Shelf q allows ${MARKET_LIMITS.collection.queryMaxChars} characters, tag and event kind allow ${MARKET_LIMITS.collection.tagMaxChars} and ${MARKET_LIMITS.collection.eventKindMaxChars}, measured as UTF-16 code units; an opaque shelf cursor allows ${MARKET_LIMITS.collection.cursorMaxChars} characters. ` +
  `The machine window previews ${MARKET_LIMITS.collection.windowEvents} events, ${MARKET_LIMITS.collection.windowListings} listings, and ${MARKET_LIMITS.collection.windowMerchants} merchants.`

export const PAYMENT_TRANSPORT_LIMITS =
  `X-PAYMENT headers allow ${MARKET_LIMITS.paymentTransport.xPaymentHeaderMaxBytes} bytes. Facilitator calls time out after ${MARKET_LIMITS.paymentTransport.facilitatorTimeoutMs / 1000} seconds and stream at most ${MARKET_LIMITS.paymentTransport.facilitatorResponseMaxBytes} response bytes.`

export const PUBLIC_READ_LIMITS =
  `City bridge reads allow ${MARKET_LIMITS.publicRead.cityMaxBytes} bytes and ${MARKET_LIMITS.publicRead.cityTimeoutMs / 1000} seconds. Share-card public reads allow ${MARKET_LIMITS.publicRead.shareMaxBytes} bytes and ${MARKET_LIMITS.publicRead.shareTimeoutMs / 1000} seconds, and trim public metadata to ${MARKET_LIMITS.publicRead.metaTextMaxChars} characters.`

export const ORDINARY_LISTING_CONTRACT =
  `Ordinary listing fields are title (${MARKET_LIMITS.listing.titleMinChars}-${MARKET_LIMITS.listing.titleMaxChars} characters), description (${MARKET_LIMITS.listing.descriptionMinChars}-${MARKET_LIMITS.listing.descriptionMaxChars}), preview (0-${MARKET_LIMITS.listing.previewMaxChars}), artifact ` +
  `(${MARKET_LIMITS.listing.descriptionMinChars} byte to ${MARKET_LIMITS.listing.artifactMaxBytes / 1024} KB of text), price_usdc (${MARKET_LIMITS.listing.priceMinUsdc}-${MARKET_LIMITS.listing.priceMaxUsdc}, rounded to ${MARKET_LIMITS.listing.priceDecimals} decimals), seller_wallet (0x plus 40 hex ` +
  `characters), tags (at most ${MARKET_LIMITS.listing.tagsMaxCount}, each at most ${MARKET_LIMITS.listing.tagMaxChars} characters), optional aisle, and optional fee_tx_hash. ` +
  'Ordinary listings may be priced at zero; world listings must cost more than zero.'

export const LISTING_SUBMISSION_RULES =
  'Choose one listing-fee method: X-PAYMENT or fee_tx_hash, never both. A near-identical title and artifact from ' +
  `the previous ${MARKET_LIMITS.listing.duplicateWindowDays} days is refused even when the earlier listing was withdrawn. If a fee was already paid, a ` +
  'duplicate refusal may keep it for review instead of refunding it.'

export const WORLD_PENDING_DRAFT_RULE =
  `A seller may hold ${MARKET_LIMITS.world.pendingDraftsPerSeller === 1 ? 'one' : MARKET_LIMITS.world.pendingDraftsPerSeller} pending world draft. Before creating another, activate it, cancel it, or wait for expiry.`

export const MACHINE_WINDOW_RULE =
  'The machine shop window takes no parameters and refuses credentials.'

export const WORLD_DRAFT_FIELDS =
  'Exactly these fields, nothing else: title, description, preview, price_usdc, seller_wallet, tags, thing_id.'

export const WORLD_ACTIVATION_FIELDS =
  'Exactly these fields, nothing else: draft_id, city_offer_id, and optional fee_tx_hash.'

export const ORDINARY_PAYMENT_TERMINALS =
  'Ordinary payment needs_review means no delivery was recorded; do not pay again. A transaction already used by ' +
  'another market payment or a changed purchase intent also ends the purchase; do not pay again.'

export const FINE_PRINT_ROUTES =
  'Fine print: /terms states who may participate and payment finality; /privacy states what is stored; /support ' +
  'states what belongs in a safe bug report; /robots.txt and /humans.txt state crawler and human access.'
