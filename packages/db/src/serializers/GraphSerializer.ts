import { ThirdPartyLibCustomSerializer, Serializer } from '@proteinjs/serializer';
import { graphSerializer, Graph, isInstanceOf } from '@proteinjs/util';

type SerializedGraph = { value: string };

const WRAP_MARKER = '@proteinjs/db/GraphSerializer_Wrapped';

function wrap(value: any): any {
  if (
    value === null ||
    typeof value === 'undefined' ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'object' && value[WRAP_MARKER]) {
    return value;
  }

  return { [WRAP_MARKER]: true, payload: Serializer.serialize(value) };
}

function unwrap(value: any): any {
  if (value && typeof value === 'object' && (value as any)[WRAP_MARKER] && typeof (value as any).payload === 'string') {
    return Serializer.deserialize((value as any).payload);
  }
  return value;
}

export class GraphSerializer implements ThirdPartyLibCustomSerializer {
  id = '@proteinjs/serializer/GraphSerializer';

  matches(obj: any) {
    return isInstanceOf(obj, Graph);
  }

  serialize(input: Graph): SerializedGraph {
    // Create a fresh graph
    const output = new Graph({
      directed: input.isDirected ? input.isDirected() : true,
      multigraph: input.isMultigraph ? input.isMultigraph() : false,
      compound: input.isCompound ? input.isCompound() : false,
    });

    // Wrap graph label
    if (input.graph) {
      const label = input.graph();
      if (typeof label !== 'undefined') {
        output.setGraph(wrap(label));
      }
    }

    // Wrap node labels
    ((input.nodes?.() as string[]) || []).forEach((v) => {
      output.setNode(v, wrap(input.node(v)));
    });

    // Wrap edge labels
    ((input.edges?.() as any[]) || []).forEach((e) => {
      output.setEdge(e, wrap(input.edge(e)));
    });

    return { value: graphSerializer.serialize(output) };
  }

  deserialize(serialized: SerializedGraph): Graph {
    const graph = graphSerializer.deserialize(serialized.value);

    // Unwrap graph label
    if (graph.graph) {
      const label = graph.graph();
      if (typeof label !== 'undefined') {
        graph.setGraph(unwrap(label));
      }
    }

    // Unwrap node labels
    ((graph.nodes?.() as string[]) || []).forEach((v) => {
      graph.setNode(v, unwrap(graph.node(v)));
    });

    // Unwrap edge labels
    ((graph.edges?.() as any[]) || []).forEach((e) => {
      graph.setEdge(e, unwrap(graph.edge(e)));
    });

    return graph;
  }
}
