import { Table, getColumnPropertyName, getTables } from './Table';

/**
 * One reverse-cascade edge: a column flagged `reverseCascadeDelete: true` whose rows die when
 * the record they point at is deleted. `dynamicReference` edges carry the resolved property
 * name of the sibling column that stores the target table's name per row.
 */
export type ReverseCascadeEdge = {
  /** The table holding the flagged column (its rows are the reverse-cascade victims). */
  referencingTable: Table<any>;
  /** Property name of the flagged column on `referencingTable.columns`. */
  columnPropertyName: string;
  /** Position in the registry walk (table order, then column order) — lookups preserve it. */
  order: number;
} & (
  | { refKind: 'reference' | 'referenceArray' }
  | { refKind: 'dynamicReference'; dynamicRefTableColumnPropertyName: string }
);

/**
 * Derived in-memory reverse-cascade edge index over the static table registry.
 *
 * Maps the referenced-target dimension (`referencedTableName → [(referencingTable,
 * columnProperty, refKind)]`) for every column flagged `reverseCascadeDelete: true`, so
 * `Db.delete` consults an O(edges-for-target) lookup instead of re-scanning every registered
 * table's columns on every delete. Table definitions are the source of truth and are static
 * per process, so the index is built once — lazily on first use — and never invalidated.
 *
 * Edge derivation mirrors the three reference column shapes:
 * - `ReferenceColumn` / `ReferenceArrayColumn` edges are keyed under their declared
 *   `referenceTable` — they can only ever point at that one target.
 * - `DynamicReferenceColumn` edges are target-agnostic (the target table name lives in a
 *   sibling column per row), so they apply to every target table and are returned for all
 *   lookups; the per-row table-name condition stays in the delete query, exactly as the
 *   pre-index scan issued it.
 */
export class ReverseCascadeEdgeIndex {
  private static instance: ReverseCascadeEdgeIndex | undefined;
  private edgesByTargetTable = new Map<string, ReverseCascadeEdge[]>();
  private dynamicEdges: ReverseCascadeEdge[] = [];

  static get(): ReverseCascadeEdgeIndex {
    if (!ReverseCascadeEdgeIndex.instance) {
      ReverseCascadeEdgeIndex.instance = new ReverseCascadeEdgeIndex();
    }

    return ReverseCascadeEdgeIndex.instance;
  }

  /**
   * All reverse-cascade edges that can point at `targetTableName`: the edges keyed under it
   * plus every dynamic (target-agnostic) edge, in the same registry-walk order the pre-index
   * all-tables scan visited them.
   */
  getEdges(targetTableName: string): ReverseCascadeEdge[] {
    const exactEdges = this.edgesByTargetTable.get(targetTableName) ?? [];
    if (exactEdges.length === 0) {
      return this.dynamicEdges;
    }

    if (this.dynamicEdges.length === 0) {
      return exactEdges;
    }

    return [...exactEdges, ...this.dynamicEdges].sort((a, b) => a.order - b.order);
  }

  private constructor() {
    this.build();
  }

  private build(): void {
    let order = 0;
    for (const referencingTable of getTables()) {
      for (const columnPropertyName in referencingTable.columns) {
        const column = referencingTable.columns[columnPropertyName] as any;
        if (!column || column.reverseCascadeDelete !== true) {
          continue;
        }

        // DynamicReferenceColumn: identified by its sibling table-name column pointer
        if (typeof column.dynamicRefTableColName === 'string' && column.dynamicRefTableColName.length > 0) {
          const dynamicRefTableColumnPropertyName = getColumnPropertyName(
            referencingTable,
            column.dynamicRefTableColName
          );
          if (!dynamicRefTableColumnPropertyName) {
            continue;
          }

          this.dynamicEdges.push({
            referencingTable,
            columnPropertyName,
            refKind: 'dynamicReference',
            dynamicRefTableColumnPropertyName,
            order: order++,
          });
          continue;
        }

        if (typeof column.referenceTable !== 'string') {
          continue;
        }

        const ctorName = column.constructor?.name;
        const refKind =
          ctorName === 'ReferenceColumn'
            ? 'reference'
            : ctorName === 'ReferenceArrayColumn'
              ? 'referenceArray'
              : undefined;
        if (!refKind) {
          continue;
        }

        let targetEdges = this.edgesByTargetTable.get(column.referenceTable);
        if (!targetEdges) {
          targetEdges = [];
          this.edgesByTargetTable.set(column.referenceTable, targetEdges);
        }

        targetEdges.push({ referencingTable, columnPropertyName, refKind, order: order++ });
      }
    }
  }
}
