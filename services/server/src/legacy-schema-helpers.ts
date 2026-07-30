import type { DatabaseQueryable } from "./database-types.js";

export async function ensureNullable(
  db: DatabaseQueryable,
  table: string,
  column: string
): Promise<void> {
  const result = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (result.rows[0]?.is_nullable === "NO") {
    await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`);
  }
}

export async function ensureNotNullable(
  db: DatabaseQueryable,
  table: string,
  column: string
): Promise<void> {
  const result = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (result.rows[0]?.is_nullable === "YES") {
    await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`);
  }
}

export async function ensureColumn(
  db: DatabaseQueryable,
  table: string,
  column: string,
  statement: string
): Promise<void> {
  const result = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column]
  );
  if (!result.rows[0]) await db.query(statement);
}

export async function ensureConstraint(
  db: DatabaseQueryable,
  table: string,
  constraint: string,
  statement: string
): Promise<void> {
  const result = await db.query<{ constraint_name: string }>(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_name = $1 AND constraint_name = $2`,
    [table, constraint]
  );
  if (!result.rows[0]) await db.query(statement);
}
