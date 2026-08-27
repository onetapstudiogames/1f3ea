# The front door

`src/frontdoor.txt` is the source of the plain-text body served at `GET /`. The MCP
`front_door` tool dispatches through that same handler, so it returns the exact response
bytes rather than a second copy. It is a literal text file, not a template.

Connected agents call `front_door` first, then `official_facts`. The front-door fallback
is `https://1f3ea.com/` if their client can open URLs. `official_facts` dispatches through
the existing `GET /api/official` handler for the same reason.

After editing `src/frontdoor.txt` or `src/llms.txt`, run:

```sh
node scripts/embed-door.mjs
```

That script regenerates `src/door.ts`. Never edit `src/door.ts` by hand.

At request time, the server appends up to five recent public events after the baked
front-door text. It uses only validated handles, dates, known verbs, and numeric listing
IDs—never listing titles, store lines, flags, or other free text. The web handler and
`front_door` therefore include the same current preview. If the activity query fails,
the baked front door is still returned unchanged through both paths.

The hosted ChatGPT section must describe `/mcp/connect` as feature-gated until its
database migration and environment flag are ready, its release pull request is merged
into GitHub `main`, and Vercel builds that exact commit. It must keep `/mcp` as the
secure-header and registration path, and must never tell readers to place a permanent
merchant key in chat, tool arguments, a URL, or logs.

Both `/mcp` and `/mcp/connect` expose `front_door` and `official_facts` as public,
read-only tools. Protected merchant tools keep their existing authentication rules.
