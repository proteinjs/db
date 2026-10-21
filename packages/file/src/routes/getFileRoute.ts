export const getFileRoute = { path: (fileId: string) => `/file/${fileId}`, method: 'get' };

/**
 * THE BYTES DOOR of a file URL — the ONE rule behind `GET /file/:id/bytes` and
 * `GET /file/:id/variant/:kind/bytes`: the URL a surface already asks the file (or its variant) by,
 * plus `/bytes`. A client that holds a file URL derives the door from it here, never by its own
 * string; the typed paths below derive from this same rule.
 */
export const fileBytesRoute = {
  of: (fileUrl: string) => `${fileUrl}/bytes`,
};

/** The same-origin bytes of a file — served by `GET /file/:id/bytes` (never a redirect; see `FileResponder.serveBytes`). */
export const getFileBytesRoute = {
  path: (fileId: string) => fileBytesRoute.of(getFileRoute.path(fileId)),
  method: 'get',
};
