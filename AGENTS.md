# The working standard

Read this before changing anything. It applies to every agent — Claude, Codex,
or anything else — and to every change, however small. CLAUDE.md holds the
project charter; this file holds the bar your work must clear.

## Definition of done

A change is done when ALL of these are true, and not before:

1. **The root cause is fixed, not the symptom site.** If the fix lives where
   the error appeared rather than where the fault is, it is not done.
2. **Tests prove the fix**, and the full local suite passes: `npm run
   typecheck` and `npm run test:coverage` (the 80% gate is a floor, not a
   target). Release candidates also run `bash scripts/deploy.sh --prepare` on
   a clean pushed branch and read its explicit exit result.
3. **A feature touching an external service has one real run recorded.** A
   green suite against fakes has repeatedly failed on first contact with the
   live service — this repo's launch day was five production fire-drills in a
   row for exactly that reason. Until a real run happened, say so plainly.
4. **A closed issue or report carries live verification evidence** — what was
   probed on the deployed site and what it returned — not an assertion that
   the code changed.
5. **Docs moved with the code, in the same PR.** Contract-visible changes
   touch the mirror surfaces: src/frontdoor.txt, src/door.ts, src/llms.txt,
   docs/SPEC.md, docs/DECISIONS.md, and the market skill where it describes
   the flow. A PR that changes behavior and not the surfaces that describe it
   is not done.
6. **Nothing new is dead or duplicated.** No unused exports, no logic remade
   that existed elsewhere, no abstraction with one caller. The simplest shape
   that fully works is the deliverable. (src/index.ts is already oversized —
   do not grow it; new route groups get their own module.)

## How work runs here

- **PRs only.** Production ships by merging to main; Vercel's GitHub
  integration builds that exact commit. Nothing deploys from a local folder —
  scripts/deploy.sh is a verification helper and its tests keep it that way.
- **Split by what a change touches, never by how long it takes.** A reviewer
  must never find security or payment changes buried behind cosmetic ones.
- **State contracts before use:** every accepted shape, precondition, default,
  limit, and refusal reason is written where the caller reads, in caller
  words. A rule learned only by rejection is a defect.
- **Report honestly.** Failed means failed, partial means partial, skipped
  means skipped. Size work by review cycles and blast radius, never days.
- **Adjacent problems are reported, not fixed.**
- **When work is prompted** (to Codex or a subagent): give the problem and the
  goal, never a list of hard rules; require a read-back before any edit; name
  the non-goals. Dense conclusions in reports — cite ids and path:line, no
  long verbatim excerpts.

## The ways work has failed here before

Check your change against each: a launch that broke production five times in
one day because nothing ran before pushing; a deploy script whose fix needed
two more fixes within a day; a feature and two patches for it landing nine
minutes apart because nothing was tested before commit; docs that promised one
deploy path while the script did another. If your change smells like any of
these, stop and say so.
