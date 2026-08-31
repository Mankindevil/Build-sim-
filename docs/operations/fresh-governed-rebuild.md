# Fresh governed runtime rebuild

Use this workflow when legacy data should remain recoverable but must not be
treated as current authority. It deliberately does **not** migrate legacy
plans, facts, prices, observations, attachments, or catalog assertions.

## Guarantees

- A full encrypted backup is created and verified before the active pointer
  can change.
- The reviewed plan is bound to the exact runtime generation, revision,
  pointer and production reference graph.
- The new generation contains only the backup verification record and the
  fresh-rebuild audit manifest.
- A staged generation is validated before the atomic pointer switch. Failure
  leaves the old generation active.
- The only rollback path is the verified full backup; old values are never
  silently reclassified as current facts.

## 1. Create and review a dry-run plan

```bash
npm run runtime:fresh-rebuild -- \
  --runtime-root /absolute/path/to/runtime \
  --output /private/operator/fresh-rebuild-plan.json
```

The output file is `0600`. Review `legacyDisposition`, the source generation,
revision and both source hashes. Record the printed `planHash`.

## 2. Prepare private backup credentials

Create a password file outside the runtime and restrict it to `0600`. Do not
put the password in a command argument or repository file.

## 3. Backup, verify and activate the empty generation

```bash
npm run runtime:fresh-rebuild -- \
  --apply \
  --runtime-root /absolute/path/to/runtime \
  --plan /private/operator/fresh-rebuild-plan.json \
  --expected-plan-hash <reviewed-plan-hash> \
  --backup-output /separate/backup-volume/legacy-runtime.backup \
  --password-file /private/operator/backup-password \
  --confirmation BACKUP_AND_ACTIVATE_FRESH_GOVERNED_RUNTIME
```

The command refuses to overwrite a backup and refuses to place its plan or
backup inside the runtime root.

## 4. Reacquire N6 from JONSBO

After the fresh generation is active:

```bash
npm run evidence:reacquire-n6 -- \
  --runtime-root /absolute/path/to/runtime \
  --report-output /private/operator/n6-reacquisition-comparison.json
```

This command starts at the governed JONSBO product URL, discovers the manual,
downloads it through the official-fetch boundary and archives the exact bytes.
The legacy adapter fields appear only in the external comparison report as
`legacy_unverified`.

JONSBO currently publishes the N6 model and manual but no explicit hardware
revision in that document. Therefore initial acquisition is correctly reported
as `official_archive_identity_unverified`: the source domain and bytes are
official, while no active official fact is created until the plan-scoped
OCR/extraction and reviewed promotion can prove the required identity scope.

## Rollback

```bash
npm run runtime:backup:restore -- \
  --runtime-root /absolute/path/to/runtime \
  --input /separate/backup-volume/legacy-runtime.backup \
  --password-file /private/operator/backup-password
```

Restore verifies the package again, stages it into a newer generation and
validates the production reference closure before switching the pointer.
