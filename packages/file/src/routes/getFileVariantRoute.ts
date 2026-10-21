import type { FileVariantKind } from '../FileVariantMaker';
import { fileBytesRoute } from './getFileRoute';

/** The URL a surface asks a file's variant of a kind by — served by `GET /file/:id/variant/:kind` (the variant, or the file itself when none applies). */
export const getFileVariantRoute = {
  path: (fileId: string, kind: FileVariantKind) => `/file/${fileId}/variant/${kind}`,
  method: 'get',
};

/** The same-origin bytes of a file's variant — served by `GET /file/:id/variant/:kind/bytes` (never a redirect; see `FileResponder.serveBytes`). */
export const getFileVariantBytesRoute = {
  path: (fileId: string, kind: FileVariantKind) => fileBytesRoute.of(getFileVariantRoute.path(fileId, kind)),
  method: 'get',
};
