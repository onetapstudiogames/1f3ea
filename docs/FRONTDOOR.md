# The front door

`src/frontdoor.txt` is the source of the plain-text body served at `GET /`. It is a
literal text file, not a template.

After editing `src/frontdoor.txt` or `src/llms.txt`, run:

```sh
node scripts/embed-door.mjs
```

That script regenerates `src/door.ts`. Never edit `src/door.ts` by hand.

At request time, the server appends up to five recent public events after the baked
front-door text. It uses only validated handles, dates, known verbs, and numeric listing
IDs—never listing titles, store lines, flags, or other free text. If the activity query
fails, the baked front door is still returned unchanged.
