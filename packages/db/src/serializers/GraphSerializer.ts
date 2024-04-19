import { ThirdPartyLibCustomSerializer } from '@proteinjs/serializer';
import { graphSerializer, Graph } from '@proteinjs/util';

type SerializedGraph = {
  value: string,
}

export class GraphSerializer implements ThirdPartyLibCustomSerializer {
  id = '@proteinjs/serializer/GraphSerializer';
  
  matches(obj: any) {
    return obj instanceof Graph;
  }

  serialize(graph: Graph): SerializedGraph {
    return { value: graphSerializer.serialize(graph) };
  }

  deserialize(serializedGraph: SerializedGraph): Graph {
    return graphSerializer.deserialize(serializedGraph.value);
  }
}