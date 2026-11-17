# Release rollback runbook

For the `@bleedingdev/*` release train published by
`.github/workflows/publish-bleedingdev.yml`.

## Non-negotiable policy

- npm versions are immutable. A published `name@version` cannot be reused,
  even after unpublish; do not overwrite or republish the bad version.
- UltraModern publishes the full public cohort at dist-tag `latest`. The
  release CLI rejects `--packages`; a package-only republish is not a
  supported release-path operation.
- Trusted-publishing OIDC publishes package bytes but cannot mutate dist-tags.
  `ultramodern-canary` is retired. Do not restore it or repair `latest` with a
  tag flip.
- The only rollback is **deprecate-and-republish**: deprecate the bad version,
  cut a new `*-ultramodern.<revision>` version, and publish a corrected cohort.
  The new publication moves `latest` as part of the normal publish path.

## Authority and credentials

The current npm package/org owner executes registry mutations from an
interactive machine with 2FA. Use `command npm` for manual npm operations and
provide the current OTP when npm challenges or when passing `--otp`. Every
command that reads or mutates the registry pins
`--registry=https://registry.npmjs.org/`: trusted publishing requires the public
registry, and an executor's scoped `@bleedingdev:registry` config could
otherwise silently point the read or the deprecation elsewhere. The
corrected cohort itself must be published by the owner-triggered
`Publish BleedingDev Packages` workflow through trusted OIDC; do not replace
that path with a local token or an ad hoc `npm publish`.

## 1. Triage and record state

Set the exact package and versions; do not guess the current tag:

```bash
PACKAGE='@bleedingdev/<package>'
BAD_VERSION='<published bad version>'
GOOD_VERSION='<new ultramodern revision>'
DEPRECATION="Deprecated: use ${PACKAGE}@${GOOD_VERSION}; see the release incident."

command npm view "$PACKAGE" dist-tags --json --registry=https://registry.npmjs.org/
command npm view "$PACKAGE@$BAD_VERSION" dist --json --registry=https://registry.npmjs.org/
```

Record the output before changing the registry. Repeat for every affected
package.

## 2. Per-package incident

Deprecate only the affected package/version immediately:

```bash
OTP='<current six-digit OTP>'
command npm deprecate "$PACKAGE@$BAD_VERSION" "$DEPRECATION" \
  --otp "$OTP" --registry=https://registry.npmjs.org/
```

This is a **per-package deprecation**, not a package-only republish. Because
`--packages` is forbidden, request a corrected full-cohort release from the
release owner. Do not move `latest` manually.

## 3. Whole-train incident or corrected release

1. Deprecate each affected package at the bad version using the command above.
2. Cut the next unused `*-ultramodern.<revision>` version; never reuse
   `BAD_VERSION`.
3. Dispatch `Publish BleedingDev Packages` on `main-ultramodern` with that
   version. Run the workflow's `dry_run` first when time permits, then run the
   non-dry publication. The workflow validates the accepted artifacts and
   publishes the corrected full cohort at `latest` through OIDC.
4. Verify every package after publication:

```bash
for PACKAGE in '@bleedingdev/<package-a>' '@bleedingdev/<package-b>'; do
  command npm view "$PACKAGE" dist-tags --json --registry=https://registry.npmjs.org/
  command npm view "$PACKAGE@$GOOD_VERSION" dist --json --registry=https://registry.npmjs.org/
done
```

Expected result: each package has `latest` equal to `GOOD_VERSION`, and each
corrected `dist` record is present. If any package disagrees, stop and escalate
to the release owner; do not use `npm dist-tag` to force coherence.

## 4. Re-driving a failed release run

A failed run is not a rollback. Re-drive it in this order:

1. **Nothing in the repository changed:** re-run the failed jobs of that run
   (`gh run rerun <run-id> --failed`). Successful jobs keep their outputs and
   artifacts, so the accepted producer identity, the publication attempt, and
   every downstream verification stay bound to the same run. This is the
   default and the cheapest path.
2. **The run can no longer be re-run, or the fix is outside the release bytes:**
   dispatch `Publish BleedingDev Packages` again with `recovery_run_id` and
   `recovery_run_attempt` set to the prior run and its producer attempt. That
   run's accepted bundle is reused instead of rebuilt, and the recovery lane
   skips the *source* qualification: it publishes the recovered bytes, not this
   dispatch's HEAD. Both jobs instead require the recovered run's
   `bleedingdev-source-qualification` receipt, and `prepare-release` requires
   it to name the recovered manifest's own source commit. A run whose
   qualification never passed uploaded no receipt, so its bundle cannot be
   promoted; re-dispatch from source instead.
3. **The release bytes themselves are wrong:** this is a rollback. Use the
   deprecate-and-republish path above with a new revision; never recover bad
   bytes.

### What a recovery dispatch still qualifies

Recovery skips the source qualification, never the tooling qualification. The
workflow file, the two OIDC publish CLIs, the receipt verifiers they call, and
the outcome and record tooling are all checked out from the *dispatch's* HEAD,
so `qualify-source` installs the workspace and runs lint, the workflow security
validator, and the publish tooling suites on every dispatch, recovery included.
What recovery drops is the expensive source lane: the framework build closures,
the browser qualification runtime, and the framework unit suites — the bulk of
the job's wall clock.

### Repeated recovery targets the original producer, never a recovery run

`recovery_run_id` always names the run that **produced** the bundle. If a
recovery dispatch itself fails and has to be re-driven, the next dispatch names
that same original producer run again — never the intervening recovery run.

This is enforced, not merely advised. A recovery run re-uploads the bundle it
recovered, but its `qualify-source` records no qualification receipt of its own
(the record and upload steps run only in the source lane). Naming a recovery run
as `recovery_run_id` therefore finds bytes and no proof, and the receipt
download fails the job. Chaining recoveries is impossible by construction; the
original producer run and its bundle stay the single recovery target for as many
attempts as it takes.

### When qualification and production landed on different attempts

`qualify-source` and `prepare-release` are separate jobs, and
`gh run rerun --failed` advances only the jobs that failed. A producer run can
therefore have passed qualification on attempt 1 and produced its bundle on
attempt 2. Set the optional `recovery_qualification_attempt` to the attempt that
recorded the receipt and leave `recovery_run_attempt` on the attempt that
produced the bundle; blank means "same as `recovery_run_attempt`", which is the
ordinary case.

The split is safe because the attempt only selects which artifact to fetch. What
authorizes the reuse is the commit binding: `prepare-release` requires the
receipt to name the recovered manifest's own source commit, so a qualification
attempt that qualified some other commit fails there rather than promoting it.
The bundle and its acceptance receipt always stay on `recovery_run_attempt` —
they are one indivisible pair, and an acceptance receipt must never vouch for
tarballs it did not cover.

## 5. After publication: `Accept published BleedingDev release`

A green `Publish BleedingDev Packages` run means npm accepted every tarball,
nothing more. Its last job, `start-release-acceptance`, dispatches
`.github/workflows/accept-bleedingdev-release.yml` for that run. That run reads
the cohort back from npm (exact bytes, `latest`, and the original run's signed
invocation), runs published ERP-10 and renderer features and published Tractor,
records the authenticated publish outcome and only then writes the GitHub
release `ultramodern-v<version>`. The cohort is accepted only when that run is
green; the publish run's summary links it.

- **The acceptance run failed on a transient cause, or only the release record
  failed:** `gh run rerun <acceptance-run-id> --failed`. It converges on an
  existing release.
- **It was cancelled, never started, or can no longer be re-run:** dispatch it
  again for the same publish run (the publish run's attempts are in its job
  list):

```bash
gh workflow run accept-bleedingdev-release.yml --repo ultramodernjs/ultramodern.js \
  --ref main-ultramodern -f original_run_id=<publish-run-id> \
  -f producer_run_attempt=<attempt of prepare-release> \
  -f publication_run_attempt=<attempt of the publish job>
```

- **It failed because the published cohort is wrong:** that cohort keeps no
  release record. Use the deprecate-and-republish path in §3.

The next live cohort's `publish-security` refuses to start while the previous
cohort's acceptance is queued, running, cancelled or was never started, so
`latest` never moves under a running acceptance and no cohort is buried
unaccepted. A previous acceptance that finished red does not block: it is
printed as an error in the next run, because publishing a corrected cohort is
the only remedy. Recovery and dry-run dispatches are never held.

Tractor retained adoption (`ultramodern-tractor-downstream.yml` dispatched by
hand) accepts a publish run only when that run's published acceptance is green.
Never re-dispatch a completed publication.

## Evidence anchors

- Workflow tag, retired canary, OIDC limitation, and owner/branch gates:
  `.github/workflows/publish-bleedingdev.yml`
- Full-cohort and `--packages` prohibition:
  `scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/options.mjs`
- Registry inspection and trusted publication implementation:
  `scripts/ultramodern-publish/lib/prepare-bleedingdev-packages/{registry,npm-buffer-publisher}.mjs`
- npm command syntax: `command npm help deprecate`, `command npm help publish`,
  `command npm help view`, and `command npm help dist-tag`.
