import * as fs from 'fs';
import * as path from 'path';
import { SourceType } from '@proteinjs/reflection';
import { graphSerializer } from '@proteinjs/util';

/**
 * `@proteinjs/db/SourceRecordLoader` is the qualified name every source-record declaration
 * implements (`class X implements SourceRecordLoader<T>`) and the name `getSourceRecordLoaders`
 * resolves through the reflection registry. The generated index keeps ONE node per qualified
 * name, so a second declaration of the name anywhere in the package's reflected sources leaves
 * which one the artifact records to the build's file order — and the loser disappears without
 * a trace. These tests read the artifacts the build wrote (`generated/index.ts` for the package
 * entry, `generated/test/index.ts` for the `./test` subpath, both built from `src/`) and assert
 * the name holds the declaration interface, not some other declaration that shares it.
 */
const QUALIFIED_NAME = '@proteinjs/db/SourceRecordLoader';
const ARTIFACTS = ['generated/index.ts', 'generated/test/index.ts'];

/** The fields of an emitted node value these tests read. */
type EmittedDeclaration = { packageName: string; name: string; qualifiedName: string; sourceType: SourceType };
type EmittedEdge = { v: string; w: string };

const readArtifact = (relativePath: string) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

/** The source graph exactly as the generated index hands it to `SourceRepository.merge`. */
const emittedGraph = (artifact: string) => {
  const literal = artifact.match(/^const sourceGraph = (".*");$/m);
  if (!literal) {
    throw new Error('generated index carries no serialized source graph');
  }
  const serialized: string = JSON.parse(literal[1]);
  return graphSerializer.deserialize(serialized.replace(/\\'/g, "'"));
};

describe.each(ARTIFACTS)('the qualified name SourceRecordLoader in %s', (relativePath) => {
  const artifact = readArtifact(relativePath);
  const graph = emittedGraph(artifact);

  it('names exactly one declaration of this package: the interface declarations implement', () => {
    const qualifiedNames: string[] = graph.nodes();
    const declarations = qualifiedNames
      .map((qualifiedName): EmittedDeclaration | undefined => graph.node(qualifiedName))
      .filter((node) => node?.packageName === '@proteinjs/db' && node.name === 'SourceRecordLoader');

    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      qualifiedName: QUALIFIED_NAME,
      sourceType: SourceType.interface,
      filePath: 'src/source/SourceRecord.ts',
    });
    const parents: EmittedEdge[] = graph.outEdges(QUALIFIED_NAME) ?? [];
    expect(parents.map((edge) => [edge.w, graph.edge(edge)])).toEqual([
      ['@proteinjs/reflection/Loadable', 'extends interface'],
    ]);
  });

  it('links no runtime value under the name (an interface has none)', () => {
    const linkedNames = (artifact.match(/^\t'[^']+': /gm) ?? []).map((line) => line.slice(2, -3));

    expect(linkedNames).toContain('@proteinjs/db/MigrationRunner');
    expect(linkedNames).not.toContain(QUALIFIED_NAME);
  });
});
