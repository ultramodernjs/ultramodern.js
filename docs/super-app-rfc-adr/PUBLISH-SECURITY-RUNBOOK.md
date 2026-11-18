# Publish Security Runbook

This repository publishes BleedingDev UltraModern packages through GitHub OIDC
trusted publishing. The publish workflow is intentionally tokenless: do not add
`NPM_TOKEN` or `NODE_AUTH_TOKEN` to the publish job.

## Required Account Controls

- GitHub organization membership must require 2FA.
- npm publisher accounts and organizations must require 2FA.
- npm trusted publishing must be configured for `BleedingDev/ultramodern.js` and
  the `Publish BleedingDev Packages` workflow.
- Long-lived npm automation tokens must not be used for the BleedingDev publish
  package set. Remove stale repo, organization, and environment secrets that can
  publish packages.

## Required Repository Controls

- Publish only from `refs/heads/main-ultramodern`.
- Publish only through the `npm-publish` GitHub environment.
- Keep publish workflow permissions minimal: `contents: read` and
  `id-token: write`.
- Keep `actions/checkout` credentials disabled with
  `persist-credentials: false`.
- Keep GitHub Actions pinned to commit SHAs in publish and generated template
  workflows.
- Do not use `pull_request_target` in this repository or generated templates.
- Keep StepSecurity harden-runner in audit mode unless every required outbound
  endpoint has been measured and allowlisted.
- Keep Renovate enabled with dependency dashboard review, one-day release age,
  grouped updates, action digest pinning, and manual approval for major updates.

## Independent sidecar publication

`publish-bleedingdev.yml` has two explicit dispatch modes. `cohort` is the
default and requires the framework `version`. It keeps source qualification,
clean-room acceptance and the Tractor rehearsal before either npm publisher.
Published acceptance and Tractor still precede the cohort outcome and change
record. In this mode `publish-sidecars` runs only when `reconcile-sidecars`
finds a staged sidecar version that is not on npm yet; when every one already
is, with the accepted bytes, provenance and tag, it is skipped and the cohort
publishes on that reconciliation alone.

`sidecars` prepares only the reviewed recipe closure. Leave `version` and all
recovery inputs empty. Preparation authenticates upstream archives and patches,
then packs the exact sidecar bytes. A separate read-only job tests and probes
that bundle, binds its source, tools, inputs and producer identity in a sidecar
qualification receipt, and reconciles it against npm without publishing. The
guarded `publish-sidecars` job downloads and verifies both artifacts before
OIDC publication. No framework cohort, cohort receipt, cohort outcome or
Tractor job runs in this mode.

Both modes require the repository owner and triggering owner on
`main-ultramodern`, use the same live-publication lock, and publish only `latest`
through the hosted `npm-publish` job. `dry_run: true` never schedules an npm
publisher. Sidecar artifacts and receipts are bound to the same run and attempt;
sidecar recovery is unsupported. After a failed attempt, rerun all jobs or make
a fresh dispatch rather than mixing artifacts from different attempts.

New package names still require the explicitly authorized deprecated
`0.0.0-bootstrap` placeholder and recorded registry chronology described in
`scripts/ultramodern-supply/README.md`. Configure npm trust for
`BleedingDev/ultramodern.js`, workflow filename `publish-bleedingdev.yml`, and
environment `npm-publish`, with direct publication enabled. Configuration does
not replace the workflow's authorization and qualification checks. Outside the
release lanes, consumers retain the 24-hour release-age gate; activate exact
first-party aliases only after the published sidecars have matured.

## Alert Review

Security alerts are part of release readiness. Before a non-dry-run publish,
review GitHub security alerts, Dependabot/GitHub Advisory alerts, Renovate
dashboard items, Socket alerts if enabled, and StepSecurity harden-runner audit
findings. Do not ignore a new high-severity supply-chain alert without recording
the owner, reason, and remediation path in the release evidence.
