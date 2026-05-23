import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const currentDir = dirname(fileURLToPath(import.meta.url));

describe('baseline init migration', () => {
  const migrationsDir = join(currentDir, '../prisma/migrations');
  const initDir = '00000000000000_init';
  const initSql = readFileSync(join(migrationsDir, initDir, 'migration.sql'), 'utf8');
  // Stripped of `-- line comments` so substring assertions don't false-match
  // names that are mentioned only in the migration's prose header.
  const initSqlCode = initSql.replace(/--[^\n]*/g, '');

  it('sorts before every dated migration so a fresh DB starts from it', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(dirs[0]).toBe(initDir);
    // Sanity: there must be at least one dated migration after init,
    // otherwise the "is this baseline still needed?" question changes.
    expect(dirs.length).toBeGreaterThan(1);
    expect(dirs[1]).toMatch(/^\d{14}_/);
  });

  it('creates every base table that later migrations ALTER', () => {
    // The actual bug: pre-this-baseline, 20251212000000 ran ALTER TABLE
    // "operations" against a table nothing had created. Lock in that every
    // table referenced by a downstream ALTER exists in the baseline (or is
    // dropped with IF EXISTS).
    expect(initSql).toMatch(/CREATE TABLE IF NOT EXISTS "users"/);
    expect(initSql).toMatch(/CREATE TABLE IF NOT EXISTS "operations"/);
    expect(initSql).toMatch(/CREATE TABLE IF NOT EXISTS "user_sync_state"/);
    expect(initSql).toMatch(/CREATE TABLE IF NOT EXISTS "sync_devices"/);
  });

  it('is idempotent so it can be applied to legacy databases', () => {
    // Postgres has no ADD CONSTRAINT IF NOT EXISTS, so foreign keys must
    // be wrapped in DO/EXCEPTION blocks. CREATE TABLE / CREATE INDEX must
    // use IF NOT EXISTS. If this regresses, legacy prod DBs that already
    // have the schema will fail when Prisma tries to apply this baseline.
    const createStatements = initSql.match(/^CREATE (TABLE|INDEX|UNIQUE INDEX)/gim) ?? [];
    expect(createStatements.length).toBeGreaterThan(0);
    for (const stmt of createStatements) {
      expect(stmt + ' IF NOT EXISTS').toMatch(/IF NOT EXISTS$/i);
    }
    // Every ALTER TABLE ADD CONSTRAINT must be inside a DO block.
    const addConstraintCount = (initSql.match(/ADD CONSTRAINT/gi) ?? []).length;
    const doBlockCount = (initSql.match(/EXCEPTION WHEN duplicate_object/gi) ?? [])
      .length;
    // Excludes the PRIMARY KEY constraints declared inline in CREATE TABLE,
    // which don't need DO blocks because IF NOT EXISTS on the table covers
    // them.
    const fkAddConstraintCount = (initSql.match(/ALTER TABLE[^;]*ADD CONSTRAINT/gi) ?? [])
      .length;
    expect(fkAddConstraintCount).toBeGreaterThan(0);
    expect(doBlockCount).toBe(fkAddConstraintCount);
    expect(addConstraintCount).toBeGreaterThanOrEqual(fkAddConstraintCount);
  });

  it('omits indexes that 20260512000000 drops, to keep legacy DBs clean', () => {
    // Two pre-baseline indexes were dropped by 20260512000000. Recreating
    // them here would leave them present on legacy DBs after the baseline
    // applies (those DBs already ran the drop). Fresh DBs end up without
    // them too because 20260512000000 uses DROP INDEX IF EXISTS.
    expect(initSqlCode).not.toContain('"operations_user_id_entity_type_entity_id_idx"');
    expect(initSqlCode).not.toContain('"operations_user_id_server_seq_idx"');
  });

  it('omits columns/tables that later migrations add or drop with IF EXISTS', () => {
    // is_payload_encrypted is added by 20251212000000, sync_import_reason
    // by 20260329000000, payload_bytes by 20260514000001 — none of those
    // ALTERs use IF NOT EXISTS, so the baseline must NOT pre-create them.
    expect(initSqlCode).not.toContain('is_payload_encrypted');
    expect(initSqlCode).not.toContain('sync_import_reason');
    expect(initSqlCode).not.toContain('payload_bytes');
    // storage_quota_bytes / reset_password_token / passkey_recovery_token
    // are likewise added by later non-IF-NOT-EXISTS ALTERs.
    expect(initSqlCode).not.toContain('storage_quota_bytes');
    expect(initSqlCode).not.toContain('reset_password_token');
    expect(initSqlCode).not.toContain('passkey_recovery_token');
    // tombstones is dropped by 20251228000001 with IF EXISTS — omitting it
    // keeps the fresh-DB end state identical to schema.prisma.
    expect(initSqlCode).not.toContain('"tombstones"');
    // passkeys table is created by 20260102000000, not by the baseline.
    expect(initSqlCode).not.toMatch(/CREATE TABLE[^;]*"passkeys"/);
    // parent_op_id is dropped by 20251228000000 with IF EXISTS — same logic.
    expect(initSqlCode).not.toContain('parent_op_id');
  });

  it('keeps password_hash NOT NULL — 20260102000000 will relax it', () => {
    // The baseline reflects pre-20251212 state. password_hash was NOT NULL
    // back then; 20260102000000 (passkey support) makes it nullable. That
    // ALTER is idempotent in Postgres so the column being already nullable
    // wouldn't fail, but reflecting the historical state matters when this
    // baseline runs on a legacy DB that was deployed pre-passkeys.
    expect(initSql).toMatch(/"password_hash"\s+TEXT NOT NULL/);
  });
});

describe('performance migrations', () => {
  it('adds the entity sequence index without a blocking or destructive migration', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260511000000_add_entity_sequence_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/i);
    expect(migrationSql).toContain(
      '"operations_user_id_entity_type_entity_id_server_seq_idx"',
    );
    expect(migrationSql).toContain(
      'ON "operations"("user_id", "entity_type", "entity_id", "server_seq")',
    );
    expect(migrationSql).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds partial full-state sequence index and drops redundant indexes', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260512000000_add_full_state_sequence_index_drop_redundant_indexes/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain('"operations_user_id_full_state_server_seq_idx"');
    expect(migrationSql).toContain('ON "operations"("user_id", "server_seq")');
    expect(migrationSql).toContain(
      `WHERE "op_type" IN ('SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR')`,
    );
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_op_type_idx"',
    );
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_entity_type_entity_id_idx"',
    );
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_server_seq_idx"',
    );
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds partial encrypted-op sequence index concurrently', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260514000000_add_encrypted_ops_partial_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_user_id_server_seq_encrypted_idx"',
    );
    expect(migrationSql).toContain('"operations_user_id_server_seq_encrypted_idx"');
    expect(migrationSql).toContain('ON "operations"("user_id", "server_seq")');
    expect(migrationSql).toContain('WHERE "is_payload_encrypted" = true');
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds operation payload_bytes as a metadata-only column (no table rewrite)', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260514000001_add_operation_payload_bytes/migration.sql',
      ),
      'utf8',
    );

    // ADD COLUMN ... NOT NULL DEFAULT <constant> is a metadata-only operation on
    // PostgreSQL 11+ (the default is stored in pg_attribute, no table rewrite).
    // These guards lock in the fast path: a future edit to a volatile/expression
    // default or a separate UPDATE backfill would rewrite/lock a 100M-row table.
    expect(migrationSql).toMatch(
      /ALTER TABLE "operations"\s+ADD COLUMN "payload_bytes" BIGINT NOT NULL DEFAULT 0/i,
    );
    expect(migrationSql).not.toMatch(/\bUPDATE\b/i);
    expect(migrationSql).not.toMatch(/\bUSING\b/i);
    expect(migrationSql).not.toMatch(/DEFAULT\s+(?!0\b)/i);
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('adds the payload_bytes unbackfilled partial index concurrently', () => {
    const migrationSql = readFileSync(
      join(
        currentDir,
        '../prisma/migrations/20260514000002_add_payload_bytes_unbackfilled_index/migration.sql',
      ),
      'utf8',
    );

    expect(migrationSql).toContain('CREATE INDEX CONCURRENTLY');
    expect(migrationSql).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "operations_payload_bytes_unbackfilled_idx"',
    );
    expect(migrationSql).toContain('"operations_payload_bytes_unbackfilled_idx"');
    expect(migrationSql).toContain('ON "operations"("user_id", "id")');
    // Partial predicate must match the boot self-check / quota probe
    // (payload_bytes = 0) so the index drains to empty post-backfill.
    expect(migrationSql).toContain('WHERE "payload_bytes" = 0');
    expect(migrationSql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(migrationSql).not.toMatch(/\bBEGIN\b|\bCOMMIT\b/i);
  });

  it('runs migrations before replacing the app during compose deploys', () => {
    const deployScript = readFileSync(join(currentDir, '../scripts/deploy.sh'), 'utf8');
    const runtimeMigrateScript = readFileSync(
      join(currentDir, '../scripts/migrate-deploy.sh'),
      'utf8',
    );
    const buildAndPushScript = readFileSync(
      join(currentDir, '../scripts/build-and-push.sh'),
      'utf8',
    );
    const dockerfile = readFileSync(join(currentDir, '../Dockerfile'), 'utf8');
    const composeFile = readFileSync(join(currentDir, '../docker-compose.yml'), 'utf8');
    const composeBuildFile = readFileSync(
      join(currentDir, '../docker-compose.build.yml'),
      'utf8',
    );
    const helmDeployment = readFileSync(
      join(currentDir, '../helm/supersync/templates/deployment.yaml'),
      'utf8',
    );
    const dockerWorkflow = readFileSync(
      join(currentDir, '../../../.github/workflows/supersync-docker.yml'),
      'utf8',
    );
    const migrationCommand = 'sh scripts/migrate-deploy.sh';
    const startCommand = 'up -d --wait --wait-timeout "$WAIT_TIMEOUT"';
    const externalDbStartCommand =
      'up -d --wait --wait-timeout "$WAIT_TIMEOUT" --no-deps supersync caddy';

    expect(deployScript).toContain('POSTGRES_WAIT_TIMEOUT');
    expect(deployScript).toContain('load_env_value()');
    expect(deployScript).toContain('POSTGRES_SERVICE="${POSTGRES_SERVICE-postgres}"');
    expect(deployScript).toContain('@db:5432');
    expect(deployScript).toContain('@postgres:5432');
    expect(deployScript).toContain('SUPER_SYNC_DEPLOY_REEXECED');
    expect(deployScript).toMatch(/git hash-object/);
    expect(deployScript).toMatch(/exec\s+"\$DEPLOY_SCRIPT_FILE"/);
    expect(deployScript).toContain('verify_supersync_image_revision()');
    expect(deployScript).toContain('supersync_image_source_revision()');
    expect(deployScript).toContain('assert_clean_supersync_image_inputs()');
    expect(deployScript).toContain('git log -1 --format=%H');
    expect(deployScript).toContain('../../.dockerignore');
    expect(deployScript).toContain('git ls-files --others --exclude-standard');
    expect(deployScript).toContain('packages/shared-schema');
    expect(deployScript).toContain('Refusing to build a labeled supersync image');
    expect(deployScript).toContain('SUPERSYNC_SKIP_IMAGE_REVISION_CHECK');
    expect(deployScript).toContain('org.opencontainers.image.revision');
    expect(deployScript).toContain('config --format json');
    expect(deployScript).toContain('.services.supersync.image // empty');
    expect(deployScript).toContain('jq is required');
    expect(deployScript).toContain('docker compose config --format json failed');
    expect(deployScript).toContain('docker image inspect');
    expect(deployScript).toContain('run --rm --no-deps --interactive=false -T supersync');
    expect(deployScript).toContain('prisma db execute');
    expect(deployScript).toContain(migrationCommand);
    expect(deployScript).toContain('Migrator container started');
    expect(deployScript).toContain('prisma db execute --schema prisma/schema.prisma');
    // Recovery now lives in the in-image scripts/migrate-deploy.sh. The host
    // must NOT re-hardcode migration names or index DDL: that lockstep
    // host/image coupling is exactly what caused the production skew bug.
    expect(deployScript).not.toMatch(/_INDEX_MIGRATION=/);
    expect(deployScript).not.toContain('run_concurrent_index_sql');
    expect(deployScript).not.toContain('CREATE INDEX CONCURRENTLY "operations');
    // Host still owns the timeout + exit-code policy around the migrator.
    expect(deployScript).toContain('timeout "$MIGRATION_TIMEOUT"');
    expect(deployScript).toContain('prisma migrate deploy timed out');
    expect(deployScript).toContain('database migrations failed (exit $MIGRATE_STATUS)');
    expect(deployScript).toContain(externalDbStartCommand);
    expect(deployScript).toContain('RUN_MIGRATIONS_ON_STARTUP');
    expect(deployScript.indexOf(migrationCommand)).toBeLessThan(
      deployScript.indexOf(startCommand),
    );
    expect(dockerfile).toContain('ARG VCS_REF=unknown');
    expect(dockerfile).toContain('LABEL org.opencontainers.image.revision=$VCS_REF');
    expect(dockerfile).toContain('RUN_MIGRATIONS_ON_STARTUP');
    expect(dockerfile).toContain('sh scripts/migrate-deploy.sh');
    expect(dockerfile).toContain('NODE_OPTIONS=--max-old-space-size=576');
    expect(composeBuildFile).toContain('VCS_REF: ${SUPERSYNC_BUILD_SHA:-local}');
    expect(buildAndPushScript).toContain('supersync_image_source_revision()');
    expect(buildAndPushScript).toContain('assert_clean_supersync_image_inputs');
    expect(buildAndPushScript).toContain('git -C "$REPO_ROOT" log -1 --format=%H');
    expect(buildAndPushScript).toContain('.dockerignore');
    expect(buildAndPushScript).toContain('git -C "$REPO_ROOT" ls-files --others');
    expect(buildAndPushScript).toContain('--build-arg "VCS_REF=$VCS_REF"');
    expect(dockerWorkflow).toContain('push:');
    expect(dockerWorkflow).toContain('branches:');
    expect(dockerWorkflow).toContain('- master');
    expect(dockerWorkflow).toContain('fetch-depth: 0');
    expect(dockerWorkflow).toContain('.dockerignore');
    expect(dockerWorkflow).toContain('packages/super-sync-server/**');
    expect(dockerWorkflow).toContain('Resolve image source revision');
    expect(dockerWorkflow).toContain('Could not resolve SuperSync image source revision');
    expect(dockerWorkflow).toContain('revision=$revision');
    expect(dockerWorkflow).toContain('VCS_REF=${{ steps.source-ref.outputs.revision }}');
    expect(dockerWorkflow).not.toContain('labels: ${{ steps.meta.outputs.labels }}');
    expect(helmDeployment).toContain('sh scripts/migrate-deploy.sh');
    // Architectural invariant (the actual bug class): the generic runtime
    // script must NOT hardcode any migration name or index DDL — that lockstep
    // coupling is what went stale and broke the production deploy. Behavioral
    // coverage of the recovery logic lives in migrate-deploy-script.spec.ts.
    expect(runtimeMigrateScript).toContain('npx prisma migrate deploy');
    expect(runtimeMigrateScript).not.toMatch(/_INDEX_MIGRATION=/);
    expect(runtimeMigrateScript).not.toContain(
      'operations_user_id_server_seq_encrypted_idx',
    );
    expect(runtimeMigrateScript).not.toContain(
      'operations_payload_bytes_unbackfilled_idx',
    );
    expect(runtimeMigrateScript).not.toContain(
      'operations_user_id_full_state_server_seq_idx',
    );
    expect(composeFile).toContain(
      'RUN_MIGRATIONS_ON_STARTUP=${RUN_MIGRATIONS_ON_STARTUP:-false}',
    );
    expect(composeFile).toContain(
      'SUPERSYNC_PAYLOAD_BYTES_BACKFILL_COMPLETE=${SUPERSYNC_PAYLOAD_BYTES_BACKFILL_COMPLETE:-false}',
    );
    expect(composeFile).toContain(
      'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -c "SELECT 1"',
    );
    expect(composeFile).toContain('aliases:');
    expect(composeFile).toContain('- db');
  });

  it('backfills operation payload bytes with per-user batched updates', () => {
    const script = readFileSync(
      join(currentDir, '../scripts/migrate-payload-bytes.ts'),
      'utf8',
    );
    const packageJson = readFileSync(join(currentDir, '../package.json'), 'utf8');

    expect(script).toContain('SELECT DISTINCT user_id');
    // Batch size sized for throughput: a tiny batch made a 100M-row backfill take
    // tens of hours, prolonging the slow octet_length() quota fallback window.
    expect(script).toContain('const DEFAULT_BATCH_SIZE = 500');
    expect(script).toContain('const MAX_BATCH_SIZE = 1000');
    // The override is still clamped so a fat-fingered value cannot OOM the
    // Node process building the VALUES string.
    expect(script).toContain('Math.min(parsed, MAX_BATCH_SIZE)');
    expect(script).toContain('userId,');
    expect(script).toContain('FROM (VALUES ${values}) AS v(id, bytes)');
    expect(script).toContain('SET payload_bytes = v.bytes');
    expect(script).toContain('storage_used_bytes = usage.total_bytes');
    expect(packageJson).toContain(
      '"migrate-payload-bytes": "node dist/scripts/migrate-payload-bytes.js"',
    );
    expect(packageJson).toContain(
      '"migrate-payload-bytes:dev": "ts-node scripts/migrate-payload-bytes.ts"',
    );
    expect(script).not.toContain('prisma.operation.update({');
  });
});
