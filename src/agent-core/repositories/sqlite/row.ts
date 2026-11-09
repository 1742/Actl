export type SqliteRow = Record<string, unknown>;

export function stringColumn(row: SqliteRow, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`SQLite column ${name} is not text.`);
  return value;
}

export function nullableStringColumn(row: SqliteRow, name: string): string | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`SQLite column ${name} is not nullable text.`);
  return value;
}

export function numberColumn(row: SqliteRow, name: string): number {
  const value = row[name];
  if (typeof value !== "number") throw new Error(`SQLite column ${name} is not numeric.`);
  return value;
}

export function nullableNumberColumn(row: SqliteRow, name: string): number | null {
  const value = row[name];
  if (value === null) return null;
  if (typeof value !== "number") throw new Error(`SQLite column ${name} is not nullable numeric.`);
  return value;
}

export function bufferColumn(row: SqliteRow, name: string): Buffer {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new Error(`SQLite column ${name} is not a blob.`);
  return Buffer.from(value);
}

export function assertChanged(result: { changes: number | bigint }, entity: string, id: string): void {
  if (result.changes === 0 || result.changes === 0n) throw new Error(`${entity} not found: ${id}`);
}
