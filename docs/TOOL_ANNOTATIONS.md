# Market MCP tool annotation review

> Status: current

B6 local source review, 2026-09-12. Portal scan and vendor review remain pending.

The serialized `tools/list` gives all 27 tools a readable top-level `title` and `annotations.title`. Every tool also has explicit `readOnlyHint`, `destructiveHint`, and `openWorldHint`. Below, R/D/O are those three booleans in that order. “Open” means the tool operates on the public market or city records, even when the caller must sign in. `me` and `my_purchases` are bounded to the signed-in merchant and have O=false. All state-changing tools have R=false. Temporary records can still disclose public data or consume a limited slot, so their effect must be explained to users.

| Tool | R/D/O | Reason |
| --- | --- | --- |
| front_door | T/F/T | Reads public market introduction and activity. |
| official_facts | T/F/T | Reads public service and payment facts. |
| browse | T/F/T | Searches public listings. |
| visit_store | T/F/T | Reads a public merchant storefront. |
| set_store | F/T/T | Overwrites or clears the public store line; the old line is not restored automatically. |
| read_listing | T/F/T | Reads a public listing and comments. |
| read_events | T/F/T | Reads the public activity log. |
| merchants | T/F/T | Lists public merchant records. |
| list_item | F/T/T | Publishes a listing and may settle a fee; public/payment history persists. |
| draft_world | F/T/T | Creates a public draft readable by ID, containing the seller's details and thing ID; cancel/expiry does not erase its historical row. It also consumes the pending-draft slot until closed. |
| list_world | F/T/T | Publishes the world listing and may settle a fee. |
| checkout_world | F/T/T | Creates a public buyer/city-handle checkout readable by ID; expiry does not erase the row, and the active slot is occupied for ten minutes. It does not itself charge or reserve the city thing. |
| sync_world | F/T/T | Can record a completed sale or terminal cancellation after public city and chain checks; it never takes a new payment. |
| edit_item | F/T/T | Overwrites public listing text or artifact; earlier purchases may retain old delivery. |
| world_status | T/F/T | Reads public world offer, checkout, and finality status. |
| withdraw_item | F/T/T | Ends a public listing; the withdrawal stays in history. |
| buy | F/T/T | Can settle payment and deliver an artifact; payment and sale are not undoable by the tool. |
| my_purchases | T/F/F | Retrieves only the signed-in merchant's purchase/download history. |
| vote | F/T/T | Records a public vote; vote history/limits remain even if later actions change display. |
| comment | F/T/T | Publishes a public comment that this tool cannot retract. |
| me | T/F/F | Reads the signed-in merchant's bounded account view. |
| help | T/F/T | Reads the public connector catalog. |
| flag | F/T/T | Creates a public moderation flag and consumes the shared social quota. |
| cancel_world_draft | F/T/T | Cancels a pending draft; the public draft record remains in canceled state. |
| treasury | T/F/T | Reads public fee and treasury records. |
| remove_listing | F/T/T | Maintainer removal persists publicly with reason. |
| pin_listing | F/T/T | Maintainer changes a public featured slot; the action is publicly logged. |

The [OpenAI annotation definition](https://developers.openai.com/plugins/deploy/submission#domain-verification) uses `destructiveHint` for overwrite, revocation, transactions, or irreversible side effects. The [Anthropic review checklist](https://claude.com/docs/connectors/building/review-criteria#provide-tool-annotations) additionally calls for `destructiveHint: true` on tools modifying data. The values above reflect actual side effects and the public-history contract; a portal reviewer may require a different classification, which must be resolved openly before submission. None of these hints grants spending or changes authorization.
