import { Aggregate, Condition, LogicalGroup, SortCriteria } from './QueryBuilder';

/**
 * A column's QUERY-side contract — the query-model parallel of a column's storage-side
 * `serialize`/`deserialize`: how uses of the column in a query (conditions, ORDER BY,
 * aggregation, GROUP BY) translate into uses of what the database actually stores and
 * indexes for it.
 *
 * The contract is generic: this package defines the seam and `QueryBuilder` applies it
 * (`QueryBuilder.applyColumnTransforms`); column models above (e.g. @proteinjs/db's
 * `Column.queryTransform`) supply implementations. A column whose stored representation
 * diverges from its caller-facing value — encrypted columns translating conditions onto
 * derived fingerprint/token artifacts, hashed columns, computed columns — implements the
 * methods it supports and THROWS a clear contract error for uses it cannot serve, so an
 * unsupported query shape fails loudly at query-build time instead of silently returning
 * wrong rows.
 *
 * Every method is optional; an absent method means the column participates in that use
 * natively. Every method may return `undefined` to leave the specific use untouched.
 */
export interface ColumnQueryTransform<T = any> {
  /**
   * Translate a condition on this column into an equivalent condition (or logical group)
   * over queryable artifacts — or throw a contract error naming the sanctioned paths.
   * Async on purpose: translation may consult derived index state (the reason this phase
   * runs at statement-build time on the server, not at builder-construction time — the
   * builder itself stays wire-portable and column-blind).
   *
   * Replacement conditions are normalized exactly as caller-built conditions are (empty
   * IN → an empty-set condition, etc.) and compare case-sensitively (they target derived
   * artifacts, not caller text).
   */
  transformCondition?(
    condition: Condition<T>,
    context: ColumnQueryTransformContext
  ): Promise<Condition<T> | LogicalGroup<T> | undefined>;
  /** Translate an ORDER BY on this column (e.g. onto a derived sort artifact) — or throw. */
  transformSort?(criteria: SortCriteria<T>): SortCriteria<T> | undefined;
  /** Translate an aggregation over this column — or throw. */
  transformAggregate?(aggregate: Aggregate<T>): Aggregate<T> | undefined;
  /** Translate a GROUP BY field naming this column — or throw. */
  transformGroupByField?(field: string): string | undefined;
}

export interface ColumnQueryTransformContext {
  /** Whether the caller asked for case-sensitive matching on this condition. */
  caseSensitive: boolean;
}

/**
 * Resolves the transform for a (table, column-property) pair — supplied by the column
 * model above this package. Consulted by `QueryBuilder.applyColumnTransforms` for every
 * column use in the query, including inside subquery values.
 */
export interface ColumnQueryTransformProvider {
  getTransform(tableName: string, columnPropertyName: string): ColumnQueryTransform | undefined;
}
