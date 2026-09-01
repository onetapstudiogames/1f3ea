# Deployment runbook

Production has one release path: merge a reviewed pull request into GitHub `main` and
Vercel's GitHub integration builds and deploys that exact merged commit. No local folder,
provider CLI, migration command, or `scripts/deploy.sh` invocation deploys the market.

## Prepare a pull request

1. Branch from the current `origin/main`. Keep payment work alone; keep structural code
   separate from documentation and copy so each receives the right review.
2. Run `npm run typecheck` and `npm run test:coverage`. Run `npm run test:postgres` for
   database or payment changes, and `npm run test:e2e` for served-page or critical-flow
   changes. Record any skipped real-service check plainly.
3. Review `git status --short`, the complete diff, and ignored files relevant to the work.
   Compare the tracked-file count with the committed-tree count in step 4, then commit.
4. Immediately before every push, run the repository trap exactly:

   ```sh
   git ls-tree -r HEAD --name-only | wc -l
   ```

   Sanity-check that number against the real tracked file count and the known additions
   in the commit. Stop if it is unexpectedly small or the worktree contains unintended
   files. Never use `--no-verify`; fix any failure reported by Git, CI, or the release gate.
5. Push the named branch normally with upstream tracking, then run:

   ```sh
   bash scripts/deploy.sh --prepare
   ```

   This requires a clean branch whose exact `HEAD` is already on its matching origin
   branch. It reruns typecheck, coverage, real-Postgres tests, and browser tests, and emits
   `GATE_EXIT=0` only on success. It does not deploy or change Vercel, DNS, or provider
   configuration.

For a docs/copy branch that describes companion code PRs, merge those code PRs first,
rebase the docs branch onto the resulting `main`, then re-audit `docs/CITY_PARITY.md` and
every served contract mirror before the final gate. Do not let a docs branch advertise code
that is absent from its merge base.

## Review and release

Open a pull request with the problem, changed contract, risks, test evidence, real-service
evidence, and anything still unverified. Payment changes require the dedicated money-review
panel and adversarial refuter evidence. Do not combine separate risk lanes to save ceremony.

After approval, merge through GitHub. Then prove Vercel serves the exact merged `main`
commit before making a live claim. Run only read-only or self-cleaning production probes
authorized by the change. Payment-path work needs the required production probe; a feature
using an external service needs one recorded real run. A code diff, preview build, reachable
route, or green fake is not live verification.

If a release includes a database migration, follow
[RELEASE_MIGRATIONS.md](../RELEASE_MIGRATIONS.md) and
[ENVIRONMENT.md](ENVIRONMENT.md). A deploy and a migration are separate ceremonies. Keep
payment custody closed for the documented migration window, and do not infer schema state
from application behavior.

## Rollback

Application rollback uses a new reviewed pull request that reverts the exact bad merge on
top of current `main`; it then passes the same push trap, release gate, merge, deployed-commit
check, and live probe. Do not redeploy a local checkout, force-move `main`, or use a provider
rollback that makes production differ from GitHub.

An additive migration is not automatically rolled back with application code. Keep payment
custody closed when schema compatibility is uncertain, inspect the recorded migration and
provider recovery point, and use a separately reviewed forward repair or explicitly approved
database recovery plan. Never infer a safe database rollback from a successful code revert.

## Stop conditions

Stop the release when the pushed commit differs, the worktree is dirty, the tree count is
implausible, any required gate is not green, migration evidence is missing, or the live
probe contradicts the source contract. Leave the issue open and record the exact failed or
unverified check. Do not repair production with an unreviewed local deploy.
