import { CustomSerializer } from '@proteinjs/serializer';
import { Graph } from '@proteinjs/util';
import { QueryBuilder } from '@proteinjs/db-query';

type SerializedQueryBuilder = {
  tableName: string,
  graph: Graph,
  idCounter: number,
  rootId: string,
  currentContextIds: string[],
  paginationNodeId?: string,
}

export const QueryBuilderSerializerId = '@proteinjs/db/QueryBuilderSerializer';

export class QueryBuilderSerializer implements CustomSerializer {
  id = QueryBuilderSerializerId;
  
  serialize(qb: QueryBuilder<any>): SerializedQueryBuilder {
    return { 
      tableName: qb.tableName,
      graph: qb.graph,
      idCounter: qb.idCounter,
      rootId: qb.rootId,
      currentContextIds: qb.currentContextIds,
      paginationNodeId: qb.paginationNodeId,
    };
  }
  
  deserialize(serializedQb: SerializedQueryBuilder): QueryBuilder<any> {
    const qb = new QueryBuilder(serializedQb.tableName);
    qb.graph = serializedQb.graph;
    qb.idCounter = serializedQb.idCounter;
    qb.rootId = serializedQb.rootId;
    qb.currentContextIds = serializedQb.currentContextIds;
    qb.paginationNodeId = serializedQb.paginationNodeId;
    return qb;
  }
}