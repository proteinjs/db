import type { FileVariantKind } from '../FileVariantMaker';

/** The URL a surface asks a file's variant of a kind by — served by `GET /file/:id/variant/:kind` (the variant, or the file itself when none applies). */
export const getFileVariantRoute = {
  path: (fileId: string, kind: FileVariantKind) => `/file/${fileId}/variant/${kind}`,
  method: 'get',
};
