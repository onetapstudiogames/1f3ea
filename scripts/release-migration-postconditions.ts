import type { Postcondition } from './release-migration-types.ts'

type IndexExpectation = Readonly<{
  unique?: boolean
  definitionIncludes?: readonly string[]
  definitionSha256?: string
}>
type ColumnExpectation = Readonly<{
  dataType?: string
  notNull?: boolean
  defaultExpression?: string | null
}>
type ConstraintExpectation = Readonly<{
  validated?: boolean
  deferrable?: boolean
  initiallyDeferred?: boolean
  definitionIncludes?: readonly string[]
  definitionSha256?: string
}>

const EXACT_DEFINITION_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "index:world_checkouts.world_checkouts_listing_merchant_id_unique": "6155eb51f20570c741fb3c75d48fa29832cdba19fc7d72a33fe7a54477540ca0",
  "index:direct_purchase_intents.direct_purchase_intents_payment_tx_unique": "02f3c09aa12d8855c8847006c6eab1d1f65658475fe5f1cf53af89b3b2d2f0cc",
  "index:world_payment_attempts.world_payment_attempts_tx_owner_unique": "c66e13c6c1ae3ecade49152c2a42f218828abac1d62bde9ef3ca002731eb853a",
  "index:world_payment_attempts.world_payment_attempts_listing_owner_unique": "9b216fc8f96328cbff1938d977193e845e372dd96737a05082f94c55de1a70f3",
  "index:purchases.purchases_world_payment_attempt_unique": "51eedfc056446ed3f2764f901ce64abe65535224f94cbafa6b5eb21a91df0016",
  "index:payment_uses.payment_uses_world_payment_attempt_unique": "e344a71cfa14bb6627676c204e49f81419e3999f53119e7cd011ece45a76e5d0",
  "index:payment_uses.payment_uses_direct_intent_unique": "a8d3cb5365e4232ca45280b88850ed0c4c14a5c020d60a00fe3185a922bf14d2",
  "index:listing_fee_attempts.listing_fee_attempts_listing_unique": "665fa0118eb24eb16e880c26178e5dc79748e6a6b93a4086692e177d745b889a",
  "index:listing_fee_attempts.listing_fee_attempts_listing_id_id_unique": "0ca8fb2e5cba08280aff583bdafbf39241e8b1897f45ea1ff31321ef47f2c098",
  "index:payment_uses.payment_uses_listing_fee_attempt_unique": "fbd64072efe07fc7ddf8915c5d491c8c0a009adb2cf20d65d4cce9313c10eb8a",
  "index:fees.fees_listing_fee_attempt_unique": "8420d91b29bfceeabcd6d4fb9006a6c6af8a0ea1f412af18be27a8c4b5e893a6",
  "constraint:direct_purchase_intents.direct_purchase_intents_payment_tx": "a5eff73e8bf67f472e5456a6813caacc6908f8eb971c1cb74493599046491d53",
  "constraint:direct_purchase_intents.direct_purchase_intents_payment_state": "52b1017800901021f99174c530216718085676083d1586772d7a0149d30cf79b",
  "constraint:direct_purchase_intents.direct_purchase_intents_finality_complete": "07d30bfa73bf7df2d1004aaae2991459ca27a7a7eed5aa9367e8aff32f10bc4a",
  "constraint:world_payment_attempts.world_payment_attempts_pkey": "e0683e0e56e949e8e2681519e322a945ab130f9b6293c3a9b7dd359e14492a6c",
  "constraint:world_payment_attempts.world_payment_attempts_merchant_id_fkey": "024da88b658c56171c8bc7b4cd8a12a535c17a40c51b9e7ba6c40fe9837dffcd",
  "constraint:world_payment_attempts.world_payment_attempts_tx_hash_check": "db9666a8ed6e3aa6c826e95c78b0266d1aa07b62bdef5f19db698e0855694f35",
  "constraint:world_payment_attempts.world_payment_attempts_payer_wallet_check": "f11ca84ccde65068fbfb97bdbeb8519c19d2ff68ab94d1a5add76c30700180b5",
  "constraint:world_payment_attempts.world_payment_attempts_payee_wallet_check": "d21ed4692666c3526af9cbc02c7cd4df02f1e538ef32b65957065a12b07289b5",
  "constraint:world_payment_attempts.world_payment_attempts_amount_units_check": "618474b43ad2980a4a96046ae2943d522e161e6a6a55eabe0411cc2b62f618e3",
  "constraint:world_payment_attempts.world_payment_attempts_verified_via_check": "8fa7cdb0a8abee917d5420ac6edfe4be7e3f662ee07a5df6b1f0f3dca08f18ac",
  "constraint:world_payment_attempts.world_payment_attempts_status_check": "bef3392edd4fe70dc8d7dbbe59426311a353e4a18b4493a147197e089a3354cc",
  "constraint:world_payment_attempts.world_payment_attempts_finalized_block_number_check": "973be741e647d12fc50ead7c837a3bb463fc28b27ed90c71fd287d34f47b9522",
  "constraint:world_payment_attempts.world_payment_attempts_finalized_block_hash_check": "9580b875a85219118abd0532a926fb862f022b62b957f1e0110975e347727c37",
  "constraint:world_payment_attempts.world_payment_attempts_review_reason_check": "d96bc99ec098735f3a23341dc50b1b0391af86a617a1d87586ca8897bb9d5226",
  "constraint:world_payment_attempts.world_payment_attempt_checkout_fk": "15be6eed4ec88d8f96e02947f399ad28110c91bf24f82ae4a768eea17a3a122b",
  "constraint:world_payment_attempts.world_payment_attempt_window": "c891e2ff16ab8973acdb5e36d573635cef8d7e2d6128bf82552e36aa3c7396de",
  "constraint:world_payment_attempts.world_payment_attempt_finality_complete": "d4a071a07ffe10580dee896434f32d0046ebdd90567f16bb8c90d94dbad2cbf3",
  "constraint:world_payment_attempts.world_payment_attempt_state_facts": "834d3bc5c3dbbd1e6b0f30ce2fd366c5d878c07b238b36b48977079106239744",
  "constraint:world_payment_attempts.world_payment_attempt_timestamps": "bad38c545fecf1ccbbce66b3a03fb01f2f0af554faad86e504ecca54d2b57ab3",
  "constraint:purchases.purchases_world_payment_attempt_fk": "82ed28f0c1b5af0f0128763379eeef0e5bd50c9ccf716de3143d0b845c093158",
  "constraint:purchases.purchases_world_requires_payment_attempt": "fd4554052f4ff9484f844bb1c505240e463b26d417cc0fdda386bbbfbfadb3c8",
  "constraint:purchases.purchases_claim_requires_direct_payment_intent": "2a888805492d8610ed4df259c30eb87c6f10c0cdd78c791a3944183394449f22",
  "constraint:payment_uses.payment_uses_world_payment_attempt_fk": "82ed28f0c1b5af0f0128763379eeef0e5bd50c9ccf716de3143d0b845c093158",
  "constraint:payment_uses.payment_uses_direct_intent_fk": "8676f3118ba99382fb0116888bc15ef799fb1d2c50b9fadd67cd7ae950df7e3c",
  "constraint:payment_uses.payment_uses_direct_intent_channel": "592eb578aea34fc46b37c3226b0f277ed5293194f69cad4bcc56df3bb896f575",
  "constraint:payment_uses.payment_uses_one_attempt_owner": "91b57f0d213966f36f25d3c9757624a531d2e2af0f0234dda43c5589115e6ae8",
  "constraint:payment_uses.payment_uses_world_attempt_channel": "6fdbd24aca3b5a89f95e6dda3a2b1da8a255eaf3454c843e6cd9f219da0e827f",
  "constraint:payment_uses.payment_uses_listing_fee_attempt_fk": "9887564ba26dbe5df0d756f52797363c481e7262d20ac4b62393ad23736c352e",
  "constraint:payment_uses.payment_uses_listing_fee_channel": "2c58ee07f2140ed87c2c1f9c1d3fc62560da2ef492471de4c27ce81e5da9c758",
  "constraint:payment_uses.payment_uses_one_durable_owner": "ce79fe7b2f687577893d00b96fcae4522564ac69e7806ed9b24048598d4bb664",
  "constraint:listing_fee_attempts.listing_fee_attempts_pkey": "4dc891945e16ea7d6f277a8b51132b1f8a751408a8e57d36fe86cfa59f8640f4",
  "constraint:listing_fee_attempts.listing_fee_attempts_merchant_id_fkey": "024da88b658c56171c8bc7b4cd8a12a535c17a40c51b9e7ba6c40fe9837dffcd",
  "constraint:listing_fee_attempts.listing_fee_attempts_fee_request_kind_check": "3af54ef8b4f60fc091c241dd4aa695f11bf52182944d9f19c0a431f4fbef3ea6",
  "constraint:listing_fee_attempts.listing_fee_attempts_fee_request_hash_check": "d1828e8c547bccb86a8ee985ff1de241a52cc85fef67f7207e8e4fb0a8b72894",
  "constraint:listing_fee_attempts.listing_fee_attempts_tx_hash_key": "5c2cba220ecfd18734d68542092573f1ba532916ab7e8815fee26565c2366f6a",
  "constraint:listing_fee_attempts.listing_fee_attempts_tx_hash_check": "db9666a8ed6e3aa6c826e95c78b0266d1aa07b62bdef5f19db698e0855694f35",
  "constraint:listing_fee_attempts.listing_fee_attempts_payer_wallet_check": "f11ca84ccde65068fbfb97bdbeb8519c19d2ff68ab94d1a5add76c30700180b5",
  "constraint:listing_fee_attempts.listing_fee_attempts_payee_wallet_check": "d21ed4692666c3526af9cbc02c7cd4df02f1e538ef32b65957065a12b07289b5",
  "constraint:listing_fee_attempts.listing_fee_attempts_asset_check": "2bd534069371ba3121cf1332fbc2357fd2757e5add37f4bafd0769c83e599eb7",
  "constraint:listing_fee_attempts.listing_fee_attempts_amount_usdc_check": "0e3a1587988e527fefb0911cfb149f92486bc93c8f719773e2e9f25fd394ef4f",
  "constraint:listing_fee_attempts.listing_fee_attempts_payment_status_check": "4a0147ce6a683ea96e2fd58ff39ba1c3f49f60a2e5ccb9197c85a6eab739d70b",
  "constraint:listing_fee_attempts.listing_fee_attempts_listing_id_fkey": "54e38c5cf85cff46b0d0cf5faf033b7385a17cfb4f79370b711c313d131844a6",
  "constraint:listing_fee_attempts.listing_fee_attempts_world_draft_id_fkey": "79f652b04dd0bd51c75e59cd24090dc4302ae0c76483213697ee9fa265b8faf5",
  "constraint:listing_fee_attempts.listing_fee_attempt_request_unique": "5310b7c5e5a52302b9a55b9f558eef05c4c63ca9526b586b1a9f69ef7b40985e",
  "constraint:listing_fee_attempts.listing_fee_attempt_window": "1a00d76aa177854b2588e807648d614aff58d2a2432737151beb7348a96ace7e",
  "constraint:listing_fee_attempts.listing_fee_attempt_finality_complete": "07d30bfa73bf7df2d1004aaae2991459ca27a7a7eed5aa9367e8aff32f10bc4a",
  "constraint:listing_fee_attempts.listing_fee_attempt_world_context": "53fcf4c9e871631227c3184a4e89dafe44061f09b00e368f7b988cc40645ac6e",
  "constraint:listing_fee_attempts.listing_fee_attempt_state": "6ec5ebeed1127c8f6b772392f8f944c74343d7261186fa52dfdc9173e2092d3f",
  "constraint:fees.fees_listing_fee_attempt_fk": "7fa2ec94c37d9ced1432f67d5a8641fac62ccb94705417f4ab0a3cfac5eacb52",
  "constraint:fees.fees_verification_method_allowed": "6d62e66304628dc8c6e67d9175be246fc8c1e0c183c00d3bc8825596d9941120",
  "constraint:fees.fees_verification_method_link": "6943c3f7cce9f2af871e877f6988357ec0369cc8106085e7e250ece7c91af0dd",
  "constraint:fees.fees_new_rows_not_legacy": "92c214fc28d2c5f093875c2d4553259700a32114a98f43ae640170134ab9a207",
  "function:protect_world_payment_attempt_terms": "1a9bbf336d087761b061940e9572c612a7883e8bf108387665859da84f946b66",
  "function:reserve_world_payment_attempt_use": "b13b95a9eeda8013bac1fef59466b8fb528a02c9f95e007673161a6b2b59d1a0",
  "function:protect_linked_payment_use": "611dbf05e8b8584bf8758006479e96f0a2dfdde58fdd12e8b7bf403c6fb5a822",
  "function:protect_direct_payment_intent_history": "d8b17c17211bb5aabbf49b50fda410d966de30f0cc78515f95659ea3c797785a",
  "function:reserve_direct_payment_intent_use": "30f7d1c0f0f0577c43b2c69c5a020cda901ed96c12fd0a10838d6f89d79106a2",
  "function:validate_direct_payment_intent_completion": "e5b74150abaf6278a0e5f74ddf25e9bb2a9796e726c9919d68a8992d2333617f",
  "function:validate_direct_purchase_attempt": "b51944fd115c22cd70d148bc914b823ed4ac7d740fe9973d8c342c8b32669bce",
  "function:claim_payment_use": "8645a2f16327de0387b3b687840d9cd1076408c5982c1778ea6ad1a0d24c0e07",
  "function:validate_world_payment_attempt_completion": "c600de1d9a25c90f4653487adc8ff5f844d5b8efa8be6a2498938f4076496c97",
  "function:validate_world_purchase_attempt": "581042ba4dd41608984bd4779cc75d050ec1afdb5e3481af756d5b1c1e226c37",
  "function:protect_listing_fee_attempt_history": "45148541bb96931f5fa407347a79b20b235fb1b943d0f48c9937f2e564b36759",
  "function:reserve_listing_fee_attempt_use": "1a2ab26eedeeb199d5be5f163b397687baf7db96f4035e98906841becec3e535",
  "function:validate_listing_fee_attempt_completion": "d8a657638e93ccf60873e67cda0f6184a4534d1b859929f04fdcadc808f006af",
  "function:validate_linked_listing_fee": "8d8d58a56366479f7214d1d5e7e494d44f45c9abfc4c57f831dd15c42f737635",
  "trigger:world_payment_attempts.world_payment_attempt_terms_immutable": "2913cd54e2bfd2c6997604c743d8ac02ca69f1756e2806d3dd3433d33be3a25e",
  "trigger:world_payment_attempts.world_payment_attempt_reserve_use": "e961cad96d52d7031c151ccb065491dee77842dbbd29fb22fc2880eba3bd695b",
  "trigger:world_payment_attempts.world_payment_attempt_completion_matches": "d1306c5da221c82d2d00b856f3efeae0d0696559d65789f0e317dd960b5780af",
  "trigger:direct_purchase_intents.direct_payment_intent_history_immutable": "2ce541af5b03f3fdd923434aa7565b21803131be446f5e6ddbcf4ed9d9be1a45",
  "trigger:direct_purchase_intents.direct_payment_intent_reserve_use": "d81ef3da2db8502310f0c8cef7ff0087a0c2038a95a1a9e129aae1fef6a85341",
  "trigger:direct_purchase_intents.direct_payment_intent_completion_matches": "34e13abe8a717b052db9c84698f2256f9a87cb78f64da3ea940b328cddba55f7",
  "trigger:purchases.purchases_direct_payment_intent_match": "16fb56a992d30b2473260e697e5a815e266ee8b989f3109db73b2bfc9254c8a4",
  "trigger:purchases.purchases_world_payment_attempt_match": "a324e8851efbbe225e987bffb86a959df70cf881d5c9eda0804b8e32a7abfd46",
  "trigger:payment_uses.linked_payment_use_immutable": "b767f2e049733ad3354c0bef4a687b1125aa2a69758ffb63174678c2c00c886b",
  "trigger:listing_fee_attempts.listing_fee_attempt_history_immutable": "173caa44d42b0f004ecc0090a07373ce1f9477ed4dfae168cf45057a095a5e01",
  "trigger:listing_fee_attempts.listing_fee_attempt_reserve_use": "4390e29206cfb11c7b284ffdb016af3479fcaf6ad6e351959c45610c973e0f83",
  "trigger:listing_fee_attempts.listing_fee_attempt_completion_matches": "6805f41fefd8a74b1d886e5ccd16328a0cbc28674ea85334563426963f9c0a90",
  "trigger:fees.fees_listing_fee_attempt_match": "cb9361bfc5a43cffdbc9439a2a2ea3ebe321c5b2579f4e11c42956b2140cf79e",
  "trigger:purchases.payment_use_claim": "53a94373d03e41c2f8264acdc7b4c3a9f7bac436eb24151419af9e95ac0e5fba",
  "trigger:fees.payment_use_claim": "22fa94d02e95df6fb87c7ddd830ad0ae745ad0b7ca36139923603a7f09d2a384",
  "constraint:x402_payment_attempts.x402_payment_attempts_amount_range": "3fc4b9a86c0c88f0d3f30c3baaf7dd04de5b04134150959f0e97c68e8f3d7937",
  "constraint:x402_payment_attempts.x402_payment_attempts_asset_usdc": "e5a95967c1cd170e0300c94309e08063feb416f019adfb8378b7a5655311d078",
  "constraint:x402_payment_attempts.x402_payment_attempts_authorization_owner": "722e3c423c3421f35a34c902d0866aa25000207986f519fcb17be0ded65ccaef",
  "constraint:x402_payment_attempts.x402_payment_attempts_finality_complete": "07d30bfa73bf7df2d1004aaae2991459ca27a7a7eed5aa9367e8aff32f10bc4a",
  "constraint:x402_payment_attempts.x402_payment_attempts_network_base": "e42e2ba131ef65b28102c41aa3772d11b8e7b79b21c454975fce3a9f8e9f542f",
  "constraint:x402_payment_attempts.x402_payment_attempts_nonce_shape": "9e3a7fa75001076edab963e53e32f73f4e79333d3b7ede408d8e030173e973a9",
  "constraint:x402_payment_attempts.x402_payment_attempts_operation_key_shape": "a8c2d0f1041ae629004987670030b58a44e1c7fe276c6fb41defb9c16fc60cbd",
  "constraint:x402_payment_attempts.x402_payment_attempts_operation_kind_allowed": "52c3caca3ba50ee8c5ef786a7cefb068f660f109f2c5f60de917ea2e7dfb6454",
  "constraint:x402_payment_attempts.x402_payment_attempts_payee_wallet_shape": "d21ed4692666c3526af9cbc02c7cd4df02f1e538ef32b65957065a12b07289b5",
  "constraint:x402_payment_attempts.x402_payment_attempts_payer_wallet_shape": "f11ca84ccde65068fbfb97bdbeb8519c19d2ff68ab94d1a5add76c30700180b5",
  "constraint:x402_payment_attempts.x402_payment_attempts_pkey": "cbd61e16e67aa3f72cc9f1906a37e5d2c10a110fe9ab9a1ec1e5bf12aad0fdc7",
  "constraint:x402_payment_attempts.x402_payment_attempts_proof_digest_key": "04465b05a536a6dab87de881f77aa4348b26f1847bf8bdc270c037746f8c2a95",
  "constraint:x402_payment_attempts.x402_payment_attempts_proof_digest_shape": "80aa404bef9bb10ba2ebe66d6c7224d968757b05f38fee02979fc7b9e7ba201c",
  "constraint:x402_payment_attempts.x402_payment_attempts_requirements_digest_shape": "a844bc803539512f154cdb3525aac251bad121dfc66e4c6bbf49d6c5b35b23a3",
  "constraint:x402_payment_attempts.x402_payment_attempts_resource_size": "ca4fd06991f267dbea3aead979a8ae4bb0c0f6a0f7726cdc88ac91ad011206d2",
  "constraint:x402_payment_attempts.x402_payment_attempts_review_reason_size": "4c367d33642f8f4a711a7641560b4599c493c585bd731217e135369fdea16174",
  "constraint:x402_payment_attempts.x402_payment_attempts_state_facts": "7c7554a6895dafbfc2f1633d05029dbc645b4cc0cd993f82001681dad509e495",
  "constraint:x402_payment_attempts.x402_payment_attempts_status_allowed": "5e0637271f3dea56685376c91ae3c88ebf1efd43a3ba4067b29fb38e1feaf83c",
  "constraint:x402_payment_attempts.x402_payment_attempts_time_order": "f1bed92ba378e28e9af986188d823ac817089b0c0aea20c6d6cd44ef1168b2b6",
  "constraint:x402_payment_attempts.x402_payment_attempts_tx_hash_key": "5c2cba220ecfd18734d68542092573f1ba532916ab7e8815fee26565c2366f6a",
  "constraint:x402_payment_attempts.x402_payment_attempts_tx_hash_shape": "409db72cc2dae28a39818e9ace72f2afdfe2523a48db1bbf48a46f5dd0822936",
  "function:protect_x402_payment_attempt_history": "14d31891676d9e07653987ac7cdf85984d1366594ec0b87c7480ad10968d1fe3",
  "index:x402_payment_attempts.x402_payment_attempts_reconcile": "db965f92e54778558bb0741f145e4956fdfc87cf2dce8a59d9e7dd592aa7e790",
  "trigger:x402_payment_attempts.x402_payment_attempts_keep_history": "0e16182e40885dcf7564d2d4e062b2a2b53e37365357017b10426e2fd0b0ec78",
  "index:fees.fees_x402_payment_attempt_unique": "47e077355046f1e2f9672a89217a304d6c11d0009922805a7fd7e4e5b81bd36f",
  "index:purchases.purchases_x402_payment_attempt_unique": "4fa98c270a1976877f34704355b290ce8470c0f4beae26479f27aeb093c6d0fa",
  "index:payment_uses.payment_uses_x402_payment_attempt_unique": "5e631409d9050258aa552b7e9041831dc9efb6000a1bce2d64f850142330bb56",
  "constraint:x402_payment_attempts.x402_payment_attempts_authorization_window": "e7c975dc8eb152fc74320b282d510e7c67b46f59c0c8ff4713b1110ebf3a3517",
  "constraint:x402_payment_attempts.x402_payment_attempts_operation_overlap": "40ce76673699e00a0dea9c2554c2f251930b88531cedffcc431be28d5d77f876",
  "constraint:x402_payment_attempts.x402_payment_attempts_finality_anchor": "a40564a5ed8a96b62d402223c8ee713383c0844f70ee5a7149bc1db25b50c687",
  "constraint:payment_uses.payment_uses_x402_payment_attempt_fk": "ac075d1a717b75fa297ae28729414c340279b195c244efb54cd558e0cfaf5223",
  "constraint:payment_uses.payment_uses_one_durable_owner_v2": "c4f64ab6dff60a5b5ff8b6dbc1b039dfd2faebb330f41ab40c47b09e73062ec2",
  "constraint:fees.fees_x402_payment_attempt_fk": "e9185387e123158aa7135b6ff08598a832b0c8d92e0bae341fa7b43f376f37cd",
  "constraint:fees.fees_x402_requires_payment_attempt": "15f7893074c2a926e2171403cafd1b847913ff420d304c8ed2db81b85c17b7cb",
  "constraint:purchases.purchases_x402_payment_attempt_fk": "e9185387e123158aa7135b6ff08598a832b0c8d92e0bae341fa7b43f376f37cd",
  "constraint:purchases.purchases_x402_requires_payment_attempt": "6c2fcede1467f264502d50d113567c9abfd690d544dca4dc7a79a1c88ed9bff5",
  "function:validate_x402_result_link": "3fe64a2c0769c8ed9c4961cefdd5f9752c4870e0eaf25f023a6f930369128b23",
  "function:protect_x402_result_link": "7b27751bd27095951481424410fec1e0612de65a75e8b6b5599a27fb76f38e26",
  "function:reserve_x402_payment_attempt_use": "ebdfb721f0dd93c4eda7bcc0b5aab38bbc2de11e14a8584969e8fe626c1bacbe",
  "function:validate_x402_payment_attempt_use": "bfffa86e66864908fe514971c67d3daf7eba9a0ad1b9e36da09491afddb8c03f",
  "trigger:fees.fees_x402_payment_attempt_match": "deea1bc8b8b440559e4f4f904a760762967a201778dad9d737aaad0b231f224f",
  "trigger:purchases.purchases_x402_payment_attempt_match": "25a0bd5e4c5c37036bdd30a3e59b18406e6ce61f2d38ef5a0d514558f2671c75",
  "trigger:fees.fees_x402_result_link_immutable": "358d91cb0824b469033c56fc6b7dcf1ac412d8fb025754aa860dba6712665861",
  "trigger:purchases.purchases_x402_result_link_immutable": "87aba7b1a850e3ef791ea76c387d30d6fe31fe228bc02425dddc703ffcafed96",
  "trigger:x402_payment_attempts.x402_payment_attempt_reserve_use": "7c747f86ef524ee752a9ac15c70f36b1b57a2a0507182a225f74ac573622ecf3",
  "trigger:x402_payment_attempts.x402_payment_attempt_use_matches": "694a80a66b3abc62289a5b514da47bcfcbcbb46a9165ecff1f8199efe67c0e5c",
})

const INDEX_EXPECTATIONS: Readonly<Record<string, IndexExpectation>> = Object.freeze({
  direct_purchase_intents_open_unique: {
    unique: true, definitionIncludes: ['(merchant_id, listing_id)', 'where', 'claimed_at is null'],
  },
  direct_purchase_intents_buyer_listing_unique: {
    unique: true, definitionIncludes: ['(merchant_id, listing_id, id)'],
  },
  direct_purchase_intents_listing_id_id_unique: {
    unique: true, definitionIncludes: ['(listing_id, id)'],
  },
  purchases_direct_intent_unique: {
    unique: true, definitionIncludes: ['(direct_purchase_intent_id)', 'where', 'is not null'],
  },
  world_checkouts_listing_merchant_id_unique: {
    unique: true, definitionIncludes: ['(listing_id, merchant_id, id)'],
  },
  direct_purchase_intents_payment_tx_unique: {
    unique: true, definitionIncludes: ['(payment_tx_hash)', 'where', 'is not null'],
  },
  world_payment_attempts_tx_owner_unique: {
    unique: true, definitionIncludes: ['(tx_hash)', 'where', 'status', 'needs_review'],
  },
  world_payment_attempts_listing_owner_unique: {
    unique: true, definitionIncludes: ['(listing_id)'],
  },
  purchases_world_payment_attempt_unique: {
    unique: true, definitionIncludes: ['(world_payment_attempt_id)', 'where', 'is not null'],
  },
  payment_uses_world_payment_attempt_unique: {
    unique: true, definitionIncludes: ['(world_payment_attempt_id)', 'where', 'is not null'],
  },
  payment_uses_direct_intent_unique: {
    unique: true, definitionIncludes: ['(direct_purchase_intent_id)', 'where', 'is not null'],
  },
  listing_fee_attempts_listing_unique: {
    unique: true, definitionIncludes: ['(listing_id)', 'where', 'is not null'],
  },
  listing_fee_attempts_listing_id_id_unique: {
    unique: true, definitionIncludes: ['(listing_id, id)'],
  },
  payment_uses_listing_fee_attempt_unique: {
    unique: true, definitionIncludes: ['(listing_fee_attempt_id)', 'where', 'is not null'],
  },
  fees_listing_fee_attempt_unique: {
    unique: true, definitionIncludes: ['(listing_fee_attempt_id)', 'where', 'is not null'],
  },
  x402_payment_attempts_reconcile: {
    unique: false,
    definitionIncludes: [
      '(updated_at, operation_key)', 'where', "'settling'::text", "'settled'::text",
      "'needs_review'::text", 'finalized_block_number is null',
    ],
  },
  payment_uses_x402_payment_attempt_unique: {
    unique: true,
    definitionIncludes: ['(x402_payment_operation_key)', 'where', 'is not null'],
  },
  fees_x402_payment_attempt_unique: {
    unique: true,
    definitionIncludes: ['(x402_payment_operation_key)', 'where', 'is not null'],
  },
  purchases_x402_payment_attempt_unique: {
    unique: true,
    definitionIncludes: ['(x402_payment_operation_key)', 'where', 'is not null'],
  },
})


const COLUMN_EXPECTATIONS: Readonly<Record<string, ColumnExpectation>> = Object.freeze({
  'direct_purchase_intents.payment_tx_hash': { dataType: 'text', notNull: false },
  'direct_purchase_intents.payment_status': {
    dataType: 'text', notNull: true, defaultExpression: "'unsubmitted'::text",
  },
  'direct_purchase_intents.finalized_block_number': { dataType: 'bigint', notNull: false },
  'direct_purchase_intents.finalized_block_hash': { dataType: 'text', notNull: false },
  'direct_purchase_intents.finalized_block_time': {
    dataType: 'timestamp with time zone', notNull: false,
  },
  'direct_purchase_intents.finalized_at': { dataType: 'timestamp with time zone', notNull: false },
  'direct_purchase_intents.payment_review_reason': { dataType: 'text', notNull: false },
  'world_payment_attempts.world_checkout_id': { dataType: 'integer', notNull: true },
  'world_payment_attempts.listing_id': { dataType: 'integer', notNull: true },
  'world_payment_attempts.merchant_id': { dataType: 'integer', notNull: true },
  'world_payment_attempts.tx_hash': { dataType: 'text', notNull: true },
  'world_payment_attempts.payer_wallet': { dataType: 'text', notNull: true },
  'world_payment_attempts.payee_wallet': { dataType: 'text', notNull: true },
  'world_payment_attempts.amount_units': { dataType: 'bigint', notNull: true },
  'world_payment_attempts.start_time': { dataType: 'timestamp with time zone', notNull: true },
  'world_payment_attempts.end_time': { dataType: 'timestamp with time zone', notNull: true },
  'world_payment_attempts.city_block_time': {
    dataType: 'timestamp with time zone', notNull: true,
  },
  'world_payment_attempts.verified_via': { dataType: 'text', notNull: true },
  'world_payment_attempts.status': {
    dataType: 'text', notNull: true, defaultExpression: "'payment_pending'::text",
  },
  'world_payment_attempts.finalized_block_number': { dataType: 'bigint', notNull: false },
  'world_payment_attempts.finalized_block_hash': { dataType: 'text', notNull: false },
  'world_payment_attempts.finalized_block_time': {
    dataType: 'timestamp with time zone', notNull: false,
  },
  'world_payment_attempts.finalized_at': { dataType: 'timestamp with time zone', notNull: false },
  'world_payment_attempts.review_reason': { dataType: 'text', notNull: false },
  'world_payment_attempts.created_at': { dataType: 'timestamp with time zone', notNull: true },
  'world_payment_attempts.updated_at': { dataType: 'timestamp with time zone', notNull: true },
  'world_payment_attempts.completed_at': { dataType: 'timestamp with time zone', notNull: false },
  'purchases.world_payment_attempt_id': { dataType: 'integer', notNull: false },
  'payment_uses.world_payment_attempt_id': { dataType: 'integer', notNull: false },
  'payment_uses.direct_purchase_intent_id': { dataType: 'integer', notNull: false },
  'payment_uses.listing_fee_attempt_id': { dataType: 'bigint', notNull: false },
  'listing_fee_attempts.id': { dataType: 'bigint', notNull: true },
  'listing_fee_attempts.merchant_id': { dataType: 'integer', notNull: true },
  'listing_fee_attempts.fee_request_kind': { dataType: 'text', notNull: true },
  'listing_fee_attempts.fee_request_hash': { dataType: 'text', notNull: true },
  'listing_fee_attempts.tx_hash': { dataType: 'text', notNull: true },
  'listing_fee_attempts.payer_wallet': { dataType: 'text', notNull: true },
  'listing_fee_attempts.payee_wallet': { dataType: 'text', notNull: true },
  'listing_fee_attempts.asset': { dataType: 'text', notNull: true },
  'listing_fee_attempts.amount_usdc': { dataType: 'numeric(12,6)', notNull: true },
  'listing_fee_attempts.minimum_block_time': {
    dataType: 'timestamp with time zone', notNull: true,
  },
  'listing_fee_attempts.maximum_block_time': {
    dataType: 'timestamp with time zone', notNull: true,
  },
  'listing_fee_attempts.payment_status': {
    dataType: 'text', notNull: true, defaultExpression: "'payment_pending'::text",
  },
  'listing_fee_attempts.listing_id': { dataType: 'integer', notNull: false },
  'listing_fee_attempts.finalized_block_number': { dataType: 'bigint', notNull: false },
  'listing_fee_attempts.finalized_block_hash': { dataType: 'text', notNull: false },
  'listing_fee_attempts.finalized_block_time': {
    dataType: 'timestamp with time zone', notNull: false,
  },
  'listing_fee_attempts.finalized_at': { dataType: 'timestamp with time zone', notNull: false },
  'listing_fee_attempts.payment_review_reason': { dataType: 'text', notNull: false },
  'listing_fee_attempts.world_draft_id': { dataType: 'integer', notNull: false },
  'listing_fee_attempts.world_offer_id': { dataType: 'integer', notNull: false },
  'listing_fee_attempts.world_seller_handle': { dataType: 'text', notNull: false },
  'listing_fee_attempts.created_at': { dataType: 'timestamp with time zone', notNull: true },
  'listing_fee_attempts.updated_at': { dataType: 'timestamp with time zone', notNull: true },
  'fees.listing_fee_attempt_id': { dataType: 'bigint', notNull: false },
  'fees.verification_method': { dataType: 'text', notNull: true, defaultExpression: null },
  'x402_payment_attempts.operation_key': { dataType: 'text', notNull: true },
  'x402_payment_attempts.operation_kind': { dataType: 'text', notNull: true },
  'x402_payment_attempts.proof_digest': { dataType: 'text', notNull: true },
  'x402_payment_attempts.requirements_digest': { dataType: 'text', notNull: true },
  'x402_payment_attempts.network': {
    dataType: 'text', notNull: true, defaultExpression: "'base'::text",
  },
  'x402_payment_attempts.asset': {
    dataType: 'text', notNull: true,
    defaultExpression: "'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text",
  },
  'x402_payment_attempts.payer_wallet': { dataType: 'text', notNull: true },
  'x402_payment_attempts.payee_wallet': { dataType: 'text', notNull: true },
  'x402_payment_attempts.amount_units': { dataType: 'bigint', notNull: true },
  'x402_payment_attempts.resource': { dataType: 'text', notNull: true },
  'x402_payment_attempts.authorization_nonce': { dataType: 'text', notNull: true },
  'x402_payment_attempts.authorization_valid_after': { dataType: 'bigint', notNull: true },
  'x402_payment_attempts.authorization_valid_before': { dataType: 'bigint', notNull: true },
  'x402_payment_attempts.start_block': { dataType: 'bigint', notNull: true },
  'x402_payment_attempts.status': {
    dataType: 'text', notNull: true, defaultExpression: "'settling'::text",
  },
  'x402_payment_attempts.tx_hash': { dataType: 'text', notNull: false },
  'x402_payment_attempts.review_reason': { dataType: 'text', notNull: false },
  'x402_payment_attempts.operation_started_at': {
    dataType: 'timestamp with time zone', notNull: true, defaultExpression: null,
  },
  'x402_payment_attempts.settlement_started_at': {
    dataType: 'timestamp with time zone', notNull: true, defaultExpression: 'statement_timestamp()',
  },
  'x402_payment_attempts.settled_at': { dataType: 'timestamp with time zone', notNull: false },
  'x402_payment_attempts.finalized_block_number': { dataType: 'bigint', notNull: false },
  'x402_payment_attempts.finalized_block_hash': { dataType: 'text', notNull: false },
  'x402_payment_attempts.finalized_block_time': {
    dataType: 'timestamp with time zone', notNull: false,
  },
  'x402_payment_attempts.finalized_at': { dataType: 'timestamp with time zone', notNull: false },
  'x402_payment_attempts.created_at': {
    dataType: 'timestamp with time zone', notNull: true, defaultExpression: 'statement_timestamp()',
  },
  'x402_payment_attempts.updated_at': {
    dataType: 'timestamp with time zone', notNull: true, defaultExpression: 'statement_timestamp()',
  },
  'payment_uses.x402_payment_operation_key': { dataType: 'text', notNull: false },
  'fees.x402_payment_operation_key': { dataType: 'text', notNull: false },
  'purchases.x402_payment_operation_key': { dataType: 'text', notNull: false },
})

const ordinaryConstraint = (
  ...definitionIncludes: readonly string[]
): ConstraintExpectation => ({
  validated: true,
  deferrable: false,
  initiallyDeferred: false,
  definitionIncludes,
})
const deferredConstraint = (
  ...definitionIncludes: readonly string[]
): ConstraintExpectation => ({
  validated: true,
  deferrable: true,
  initiallyDeferred: true,
  definitionIncludes,
})


const CONSTRAINT_EXPECTATIONS: Readonly<Record<string, ConstraintExpectation>> = Object.freeze({
  'purchases.purchases_direct_intent_channel': ordinaryConstraint(
    'check', 'direct_purchase_intent_id is null', "verified_via = 'claim'::text",
  ),
  'purchases.purchases_direct_intent_listing_fk': ordinaryConstraint(
    'foreign key (listing_id, direct_purchase_intent_id)',
    'references direct_purchase_intents(listing_id, id)',
  ),
  'direct_purchase_intents.direct_purchase_intents_payment_tx': ordinaryConstraint(
    'check', 'payment_tx_hash is null', "payment_tx_hash ~ '^0x[0-9a-f]{64}$'::text",
  ),
  'direct_purchase_intents.direct_purchase_intents_payment_state': ordinaryConstraint(
    'check', "payment_status = 'unsubmitted'::text", "payment_status = 'payment_pending'::text",
    "payment_status = 'completed'::text", "payment_status = 'needs_review'::text",
    "payment_status = 'legacy_completed'::text", 'superseded_at is null',
  ),
  'direct_purchase_intents.direct_purchase_intents_finality_complete': ordinaryConstraint(
    'check', 'finalized_block_number', 'finalized_block_hash',
    'finalized_block_time', 'finalized_at',
  ),
  'world_payment_attempts.world_payment_attempts_pkey': ordinaryConstraint(
    'primary key (world_checkout_id)',
  ),
  'world_payment_attempts.world_payment_attempts_merchant_id_fkey': ordinaryConstraint(
    'foreign key (merchant_id)', 'references merchants(id)',
  ),
  'world_payment_attempts.world_payment_attempts_tx_hash_check': ordinaryConstraint(
    'check', "tx_hash ~ '^0x[0-9a-f]{64}$'::text",
  ),
  'world_payment_attempts.world_payment_attempts_payer_wallet_check': ordinaryConstraint(
    'check', "payer_wallet ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'world_payment_attempts.world_payment_attempts_payee_wallet_check': ordinaryConstraint(
    'check', "payee_wallet ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'world_payment_attempts.world_payment_attempts_amount_units_check': ordinaryConstraint(
    'check', 'amount_units > 0', 'amount_units <=', '10000000000',
  ),
  'world_payment_attempts.world_payment_attempts_verified_via_check': ordinaryConstraint(
    'check', "verified_via = any (array['x402'::text, 'claim'::text])",
  ),
  'world_payment_attempts.world_payment_attempts_status_check': ordinaryConstraint(
    'check', "status = any (array['payment_pending'::text, 'completed'::text, 'needs_review'::text])",
  ),
  'world_payment_attempts.world_payment_attempts_finalized_block_number_check': ordinaryConstraint(
    'check', 'finalized_block_number is null', 'finalized_block_number >= 0',
  ),
  'world_payment_attempts.world_payment_attempts_finalized_block_hash_check': ordinaryConstraint(
    'check', 'finalized_block_hash is null', "finalized_block_hash ~ '^0x[0-9a-f]{64}$'::text",
  ),
  'world_payment_attempts.world_payment_attempts_review_reason_check': ordinaryConstraint(
    'check', 'review_reason is null', 'octet_length(review_reason)',
  ),
  'world_payment_attempts.world_payment_attempt_checkout_fk': ordinaryConstraint(
    'foreign key (listing_id, merchant_id, world_checkout_id)',
    'references world_checkouts(listing_id, merchant_id, id)',
  ),
  'world_payment_attempts.world_payment_attempt_window': ordinaryConstraint(
    'check', 'end_time > start_time', "'00:05:00'::interval",
  ),
  'world_payment_attempts.world_payment_attempt_finality_complete': ordinaryConstraint(
    'check', 'finalized_block_number', 'finalized_block_hash',
    'finalized_block_time', 'finalized_at',
  ),
  'world_payment_attempts.world_payment_attempt_state_facts': ordinaryConstraint(
    'check', "status = 'payment_pending'::text", "status = 'completed'::text",
    "status = 'needs_review'::text", 'finalized_block_time = city_block_time',
    'finalized_block_time >= start_time', 'finalized_block_time < end_time',
  ),
  'world_payment_attempts.world_payment_attempt_timestamps': ordinaryConstraint(
    'check', 'updated_at >= created_at', 'completed_at >= created_at',
  ),
  'purchases.purchases_world_payment_attempt_fk': deferredConstraint(
    'foreign key (world_payment_attempt_id)',
    'references world_payment_attempts(world_checkout_id)',
  ),
  'purchases.purchases_world_requires_payment_attempt': {
    ...ordinaryConstraint('check', "verified_via <> 'world'::text", 'world_payment_attempt_id is not null'),
    validated: false,
  },
  'payment_uses.payment_uses_world_payment_attempt_fk': deferredConstraint(
    'foreign key (world_payment_attempt_id)',
    'references world_payment_attempts(world_checkout_id)',
  ),
  'payment_uses.payment_uses_direct_intent_fk': deferredConstraint(
    'foreign key (direct_purchase_intent_id)',
    'references direct_purchase_intents(id)',
  ),
  'payment_uses.payment_uses_direct_intent_channel': ordinaryConstraint(
    'check', 'direct_purchase_intent_id is null', "used_as = 'purchases'::text",
  ),
  'payment_uses.payment_uses_one_attempt_owner': ordinaryConstraint(
    'check', 'num_nonnulls(world_payment_attempt_id, direct_purchase_intent_id) <= 1',
  ),
  'payment_uses.payment_uses_world_attempt_channel': ordinaryConstraint(
    'check', 'world_payment_attempt_id is null', "used_as = 'purchases'::text",
  ),
  'payment_uses.payment_uses_listing_fee_attempt_fk': ordinaryConstraint(
    'foreign key (listing_fee_attempt_id)', 'references listing_fee_attempts(id)',
  ),
  'payment_uses.payment_uses_listing_fee_channel': ordinaryConstraint(
    'check', 'listing_fee_attempt_id is null', "used_as = 'fees'::text",
  ),
  'payment_uses.payment_uses_one_durable_owner': ordinaryConstraint(
    'check',
    'num_nonnulls(world_payment_attempt_id, direct_purchase_intent_id, listing_fee_attempt_id) <= 1',
  ),
  'listing_fee_attempts.listing_fee_attempts_pkey': ordinaryConstraint('primary key (id)'),
  'listing_fee_attempts.listing_fee_attempts_merchant_id_fkey': ordinaryConstraint(
    'foreign key (merchant_id)', 'references merchants(id)',
  ),
  'listing_fee_attempts.listing_fee_attempts_fee_request_kind_check': ordinaryConstraint(
    'check', "fee_request_kind = any (array['artifact_listing'::text, 'world_listing'::text])",
  ),
  'listing_fee_attempts.listing_fee_attempts_fee_request_hash_check': ordinaryConstraint(
    'check', "fee_request_hash ~ '^[0-9a-f]{64}$'::text",
  ),
  'listing_fee_attempts.listing_fee_attempts_tx_hash_key': ordinaryConstraint(
    'unique (tx_hash)',
  ),
  'listing_fee_attempts.listing_fee_attempts_tx_hash_check': ordinaryConstraint(
    'check', "tx_hash ~ '^0x[0-9a-f]{64}$'::text",
  ),
  'listing_fee_attempts.listing_fee_attempts_payer_wallet_check': ordinaryConstraint(
    'check', "payer_wallet ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'listing_fee_attempts.listing_fee_attempts_payee_wallet_check': ordinaryConstraint(
    'check', "payee_wallet ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'listing_fee_attempts.listing_fee_attempts_asset_check': ordinaryConstraint(
    'check', "asset ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'listing_fee_attempts.listing_fee_attempts_amount_usdc_check': ordinaryConstraint(
    'check', 'amount_usdc = 1.000000',
  ),
  'listing_fee_attempts.listing_fee_attempts_payment_status_check': ordinaryConstraint(
    'check', "payment_status = any (array['payment_pending'::text, 'completed'::text, 'needs_review'::text])",
  ),
  'listing_fee_attempts.listing_fee_attempts_listing_id_fkey': ordinaryConstraint(
    'foreign key (listing_id)', 'references listings(id)',
  ),
  'listing_fee_attempts.listing_fee_attempts_world_draft_id_fkey': ordinaryConstraint(
    'foreign key (world_draft_id)', 'references world_drafts(id)',
  ),
  'listing_fee_attempts.listing_fee_attempt_request_unique': ordinaryConstraint(
    'unique (merchant_id, fee_request_kind, fee_request_hash)',
  ),
  'listing_fee_attempts.listing_fee_attempt_window': ordinaryConstraint(
    'check', "maximum_block_time = (minimum_block_time + '01:00:00'::interval)",
  ),
  'listing_fee_attempts.listing_fee_attempt_finality_complete': ordinaryConstraint(
    'check', 'finalized_block_number', 'finalized_block_hash',
    'finalized_block_time', 'finalized_at',
  ),
  'listing_fee_attempts.listing_fee_attempt_world_context': ordinaryConstraint(
    'check', "fee_request_kind = 'artifact_listing'::text",
    "fee_request_kind = 'world_listing'::text", 'world_draft_id', 'world_offer_id',
  ),
  'listing_fee_attempts.listing_fee_attempt_state': ordinaryConstraint(
    'check', "payment_status = 'payment_pending'::text", "payment_status = 'completed'::text",
    "payment_status = 'needs_review'::text", 'finalized_block_time >= minimum_block_time',
    'finalized_block_time <= maximum_block_time',
  ),
  'fees.fees_listing_fee_attempt_fk': ordinaryConstraint(
    'foreign key (listing_id, listing_fee_attempt_id)',
    'references listing_fee_attempts(listing_id, id)',
  ),
  'fees.fees_verification_method_allowed': ordinaryConstraint(
    'check', "verification_method = any (array['legacy'::text, 'x402'::text, 'direct'::text])",
  ),
  'fees.fees_verification_method_link': ordinaryConstraint(
    'check', "verification_method = any (array['legacy'::text, 'x402'::text])",
    'listing_fee_attempt_id is null', "verification_method = 'direct'::text",
    'listing_fee_attempt_id is not null',
  ),
  'purchases.purchases_claim_requires_direct_payment_intent': {
    ...ordinaryConstraint(
      'check', "verified_via <> 'claim'::text", 'direct_purchase_intent_id is not null',
    ),
    validated: false,
  },
  'fees.fees_new_rows_not_legacy': {
    ...ordinaryConstraint('check', "verification_method <> 'legacy'::text"),
    validated: false,
  },
  'x402_payment_attempts.x402_payment_attempts_pkey': ordinaryConstraint(
    'primary key (operation_key)',
  ),
  'x402_payment_attempts.x402_payment_attempts_operation_key_shape': ordinaryConstraint(
    'check', 'octet_length(operation_key) >= 1', 'octet_length(operation_key) <= 240',
    "operation_key ~ '^[a-za-z0-9][a-za-z0-9:._/-]*$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_operation_kind_allowed': ordinaryConstraint(
    'check',
    "operation_kind = any (array['listing_fee'::text, 'world_listing_fee'::text, 'purchase'::text])",
  ),
  'x402_payment_attempts.x402_payment_attempts_proof_digest_key': ordinaryConstraint(
    'unique (proof_digest)',
  ),
  'x402_payment_attempts.x402_payment_attempts_proof_digest_shape': ordinaryConstraint(
    'check', "proof_digest ~ '^[0-9a-f]{64}$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_requirements_digest_shape': ordinaryConstraint(
    'check', "requirements_digest ~ '^[0-9a-f]{64}$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_network_base': ordinaryConstraint(
    'check', "network = 'base'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_asset_usdc': ordinaryConstraint(
    'check', "asset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_payer_wallet_shape': ordinaryConstraint(
    'check', "payer_wallet ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_payee_wallet_shape': ordinaryConstraint(
    'check', "payee_wallet ~ '^0x[0-9a-f]{40}$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_amount_range': ordinaryConstraint(
    'check', 'amount_units >= 1', "amount_units <= '10000000000'::bigint",
  ),
  'x402_payment_attempts.x402_payment_attempts_resource_size': ordinaryConstraint(
    'check', 'octet_length(resource) >= 1', 'octet_length(resource) <= 2048',
  ),
  'x402_payment_attempts.x402_payment_attempts_nonce_shape': ordinaryConstraint(
    'check', "authorization_nonce ~ '^0x[0-9a-f]{64}$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_status_allowed': ordinaryConstraint(
    'check',
    "status = any (array['settling'::text, 'settled'::text, 'verified'::text, 'needs_review'::text])",
  ),
  'x402_payment_attempts.x402_payment_attempts_tx_hash_key': ordinaryConstraint(
    'unique (tx_hash)',
  ),
  'x402_payment_attempts.x402_payment_attempts_tx_hash_shape': ordinaryConstraint(
    'check', 'tx_hash is null', "tx_hash ~ '^0x[0-9a-f]{64}$'::text",
  ),
  'x402_payment_attempts.x402_payment_attempts_review_reason_size': ordinaryConstraint(
    'check', 'review_reason is null', 'octet_length(review_reason) >= 1',
    'octet_length(review_reason) <= 240',
  ),
  'x402_payment_attempts.x402_payment_attempts_authorization_owner': ordinaryConstraint(
    'unique (network, asset, payer_wallet, authorization_nonce)',
  ),
  'x402_payment_attempts.x402_payment_attempts_authorization_window': ordinaryConstraint(
    'check', 'authorization_valid_after >= 0',
    "authorization_valid_before <= '9007199254740991'::bigint",
    'authorization_valid_before > (authorization_valid_after + 1)',
  ),
  'x402_payment_attempts.x402_payment_attempts_operation_overlap': ordinaryConstraint(
    'check', 'start_block >= 0', 'greatest(',
    'authorization_valid_after + 1', 'authorization_valid_before',
  ),
  'x402_payment_attempts.x402_payment_attempts_finality_complete': ordinaryConstraint(
    'check', 'finalized_block_number is null', 'finalized_block_hash is null',
    'finalized_block_time is null', 'finalized_at is null',
    'finalized_block_number is not null', 'finalized_block_number >= 0',
    "finalized_block_hash ~ '^0x[0-9a-f]{64}$'::text",
    'finalized_block_time is not null', 'finalized_at is not null',
  ),
  'x402_payment_attempts.x402_payment_attempts_finality_anchor': ordinaryConstraint(
    'check', "status <> 'verified'::text", 'finalized_block_number >= start_block',
    'authorization_valid_after', 'authorization_valid_before',
  ),
  'x402_payment_attempts.x402_payment_attempts_state_facts': ordinaryConstraint(
    'check', "status = 'settling'::text", "status = 'needs_review'::text",
    "status = 'settled'::text", "status = 'verified'::text",
    'tx_hash is null', 'tx_hash is not null', 'review_reason is null',
    'review_reason is not null', 'settled_at is null', 'settled_at is not null',
    'finalized_block_number is null', 'finalized_block_number is not null',
  ),
  'x402_payment_attempts.x402_payment_attempts_time_order': ordinaryConstraint(
    'check', 'operation_started_at <= settlement_started_at',
    'settlement_started_at >= created_at', 'updated_at >= created_at',
    'settled_at >= settlement_started_at', 'finalized_at >= finalized_block_time',
  ),
  'payment_uses.payment_uses_x402_payment_attempt_fk': {
    ...ordinaryConstraint(
      'foreign key (x402_payment_operation_key)',
      'references x402_payment_attempts(operation_key)',
      'deferrable initially deferred',
    ),
    validated: false, deferrable: true, initiallyDeferred: true,
  },
  'payment_uses.payment_uses_one_durable_owner_v2': {
    ...ordinaryConstraint(
      'check', 'num_nonnulls(world_payment_attempt_id, direct_purchase_intent_id, '
        + 'listing_fee_attempt_id, x402_payment_operation_key) <= 1',
    ),
    validated: false,
  },
  'fees.fees_x402_payment_attempt_fk': {
    ...ordinaryConstraint(
      'foreign key (x402_payment_operation_key)',
      'references x402_payment_attempts(operation_key)',
    ),
    validated: false,
  },
  'fees.fees_x402_requires_payment_attempt': {
    ...ordinaryConstraint(
      'check', "verification_method = 'x402'::text", 'x402_payment_operation_key is not null',
      "verification_method <> 'x402'::text", 'x402_payment_operation_key is null',
    ),
    validated: false,
  },
  'purchases.purchases_x402_payment_attempt_fk': {
    ...ordinaryConstraint(
      'foreign key (x402_payment_operation_key)',
      'references x402_payment_attempts(operation_key)',
    ),
    validated: false,
  },
  'purchases.purchases_x402_requires_payment_attempt': {
    ...ordinaryConstraint(
      'check', "verified_via = 'x402'::text", 'x402_payment_operation_key is not null',
      "verified_via <> 'x402'::text", 'x402_payment_operation_key is null',
    ),
    validated: false,
  },
})


export const table = (name: string): Postcondition => ({ kind: 'table', name })
export const index = (
  tableName: string,
  name: string,
  expectation: Readonly<{
    unique?: boolean
    definitionIncludes?: readonly string[]
    definitionSha256?: string
  }> = {},
): Postcondition => ({
  kind: 'index', table: tableName, name,
  ...(INDEX_EXPECTATIONS[name] ?? {}),
  ...(EXACT_DEFINITION_SHA256[`index:${tableName}.${name}`]
    ? { definitionSha256: EXACT_DEFINITION_SHA256[`index:${tableName}.${name}`] }
    : {}),
  ...expectation,
})
const column = (
  tableName: string,
  name: string,
  expectation: Readonly<{
    dataType?: string
    notNull?: boolean
    defaultExpression?: string | null
  }> = {},
): Postcondition => ({
  kind: 'column', table: tableName, name,
  ...(COLUMN_EXPECTATIONS[`${tableName}.${name}`] ?? {}),
  ...expectation,
})
export const columns = (tableName: string, names: readonly string[]): readonly Postcondition[] =>
  names.map(name => column(tableName, name))
export const constraint = (
  tableName: string,
  name: string,
  expectation: Readonly<{
    validated?: boolean
    deferrable?: boolean
    initiallyDeferred?: boolean
    definitionIncludes?: readonly string[]
    definitionSha256?: string
  }> = {},
): Postcondition => ({
  kind: 'constraint', table: tableName, name,
  ...(CONSTRAINT_EXPECTATIONS[`${tableName}.${name}`] ?? {}),
  ...(EXACT_DEFINITION_SHA256[`constraint:${tableName}.${name}`]
    ? { definitionSha256: EXACT_DEFINITION_SHA256[`constraint:${tableName}.${name}`] }
    : {}),
  ...expectation,
})
export const constraints = (
  tableName: string,
  names: readonly string[],
): readonly Postcondition[] => names.map(name => constraint(tableName, name))
export const triggerFunction = (
  name: string,
  contains?: string,
  containsAll?: readonly string[],
): Postcondition => ({
  kind: 'function', name, ...(contains ? { contains } : {}),
  ...(containsAll?.length ? { containsAll } : {}),
  ...(EXACT_DEFINITION_SHA256[`function:${name}`]
    ? { definitionSha256: EXACT_DEFINITION_SHA256[`function:${name}`] }
    : {}),
})
export const trigger = (
  tableName: string,
  name: string,
  functionName: string,
  deferred = false,
  definitionIncludes: readonly string[] = [],
): Postcondition => ({
  kind: 'trigger', table: tableName, name, functionName, deferred, enabled: 'O',
  ...(definitionIncludes.length ? { definitionIncludes } : {}),
  ...(EXACT_DEFINITION_SHA256[`trigger:${tableName}.${name}`]
    ? { definitionSha256: EXACT_DEFINITION_SHA256[`trigger:${tableName}.${name}`] }
    : {}),
})
