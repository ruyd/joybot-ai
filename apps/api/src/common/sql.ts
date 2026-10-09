/**
 * Small helpers for dynamic INSERT/UPDATE statements. Column names must come from validated,
 * strict schemas (never from raw request keys) — values are always parameterized.
 */
export function insertStatement(table: string, row: Record<string, unknown>, returning: string) {
  const cols = Object.keys(row);
  return {
    text: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
           RETURNING ${returning}`,
    values: cols.map((c) => row[c]),
  };
}

/** `SET a = $2, b = $3` with $1 reserved for the row id. */
export function setClause(fields: Record<string, unknown>, firstParam = 2) {
  const cols = Object.keys(fields);
  return {
    sql: cols.map((c, i) => `${c} = $${i + firstParam}`).join(', '),
    values: cols.map((c) => fields[c]),
    empty: cols.length === 0,
  };
}

/** Drops keys whose value is undefined (partial updates). */
export function defined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
