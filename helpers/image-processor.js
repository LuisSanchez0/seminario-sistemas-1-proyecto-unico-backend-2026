const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const processImageToWebp = async (file) => {
  if (!file.mimetype.startsWith('image/')) {
    throw new Error('El archivo no es una imagen válida');
  }

  const tempDir = path.join(__dirname, '../tmp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const baseName = path.parse(file.name).name.replace(/\s+/g, '-').toLowerCase();
  const fileName = `${Date.now()}-${baseName}.webp`;
  const tempPath = path.join(tempDir, fileName);

  await sharp(file.tempFilePath)
    .resize({ width: 1200, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(tempPath);

  file.tempFilePath = tempPath;
  file.name = fileName;

  return file;
};

module.exports = { processImageToWebp };
