# Independent Audit Boundary Design

**Status:** Approved for implementation on 2026-09-03.

## Goal

Keep `dsh-searxng` independently maintainable and releasable while retaining
`dsh-vet` as a replaceable, non-blocking audit integration and public adoption
case.

## Selected approach

Use a loose, one-way integration:

- `dsh-searxng` owns its adopter-voice draft, published post, audit workflow,
  report branch, and badge.
- `dsh-vet` remains an external tool selected by `dsh-searxng`; it is not a
  runtime or package dependency.
- The audit runs after changes reach `main` and on manual dispatch, but it does
  not run as a required pull-request check. A scanner, npm, or report-publishing
  failure therefore cannot block unrelated plugin changes.
- The action is pinned to an immutable commit SHA, with the release tag retained
  in a comment and the matching scanner version supplied explicitly.
- The adopter post is first-party evidence because both projects share a
  maintainer. It must not satisfy dsh-vet's v0.3 requirements for marketplace
  rendering or a verified third-party emitter.

## Alternatives considered

### Keep the current required pull-request audit

This preserves the existing check but couples every plugin merge to the audit
action and npm availability. It also audits the already-published npm package,
not the proposed pull-request code, so it is not an effective PR gate.

### Remove dsh-vet completely

Removing the workflow, report branch, badge, and references would produce
literal independence, but it would discard useful continuous audit evidence and
the adoption story. This is unnecessary because non-blocking integration gives
the projects independent release paths without hiding their relationship.

## Repository changes

### dsh-searxng

1. Add the adopter-voice draft under `docs/outreach/`.
2. Remove the `pull_request` trigger from `.github/workflows/dsh-vet.yml`.
3. Pin `rogerdigital/dsh-vet/action` to the immutable commit behind the selected
   release and pass the matching scanner version explicitly.
4. Update the `protect-main` ruleset so `audit` is no longer a required status
   check; keep the four platform verification checks required.
5. Publish the adopter post from the dsh-searxng maintainer context and record
   the resulting URL in the local outreach document.

### dsh-vet

1. Do not merge the abandoned `docs/searxng-adopters-post` branch.
2. Remove the local abandoned branch after the dsh-searxng copy is safely
   committed.
3. Keep existing historical calibration reports as frozen evidence; they do
   not follow dsh-searxng releases and create no operational dependency.
4. Do not mark marketplace adoption, third-party emitter verification, feedback
   absorption, or contract freeze complete because of this post.

## Failure behavior

- A failed audit leaves the last committed report and badge visible but does not
  block pull requests or plugin releases.
- A failed report publication is handled inside the dsh-searxng repository; no
  workflow writes to dsh-vet.
- Updating the scanner requires an explicit dsh-searxng change and verification.

## Verification

- Confirm the draft exists only in the dsh-searxng work branch.
- Confirm `package.json` still has no dsh-vet dependency.
- Confirm the workflow has only `push` to `main` and `workflow_dispatch`
  triggers, uses an immutable action SHA, and supplies the intended version.
- Confirm the active ruleset requires only the four platform `Verify` checks.
- Run the repository's normal verification suite and manually dispatch the audit
  after merge.
- Confirm the published post is described as a maintainer-owned adoption case,
  not independent ecosystem adoption.
