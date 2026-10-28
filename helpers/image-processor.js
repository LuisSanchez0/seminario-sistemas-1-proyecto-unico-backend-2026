
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');

const processImageToWebp = async (file) => {
  if (!file?.mimetype?.startsWith('image/')) {
    throw new Error('El archivo no es una imagen válida');
  }

  // En Docker, /app es de solo lectura.
  // Utilizamos el directorio temporal del sistema.
  const tempDir = os.tmpdir();

  const baseName = path.parse(file.name).name
    .replace(/\s+/g, '-')
    .toLowerCase();

  const fileName = `${Date.now()}-${crypto.randomUUID()}-${baseName}.webp`;
  const tempPath = path.join(tempDir, fileName);

  try {
    await sharp(file.tempFilePath)
      .resize({ width: 1200, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(tempPath);

    const stats = await fs.promises.stat(tempPath);

    return {
      ...file,
      name: fileName,
      tempFilePath: tempPath,
      mimetype: 'image/webp',
      size: stats.size,
    };
  } catch (error) {
    // Eliminar cualquier archivo parcial generado por Sharp.
    await fs.promises.rm(tempPath, { force: true })
      .catch(() => {});

    throw error;
  }
};

module.exports = { processImageToWebp };
