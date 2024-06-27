import { Route } from '@proteinjs/server-api';
import { getFileStorage } from '../FileStorage';

export const getFile: Route = {
  path: '/file/:id',
  method: 'get',
  onRequest: async (request, response): Promise<void> => {
    const fileId = request.params.id;
    const fileStorage = getFileStorage();
    try {
      const file = await fileStorage.getFile(fileId);
      const fileDataBase64 = await fileStorage.getFileData(fileId);
      if (!file || !fileDataBase64) {
        response.status(404).send('File not found');
      } else {
        const safeFilename = encodeURIComponent(file.name);
        const fileData = file.type.startsWith('image/') ? Buffer.from(fileDataBase64, 'base64') : fileDataBase64;
        response.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
        response.setHeader('Content-Type', file.type);
        response.send(fileData);
      }
    } catch (error) {
      console.error(`Error fetching file (${fileId}):`, error);
      response.status(500).send('Internal Server Error');
    }
  },
};
