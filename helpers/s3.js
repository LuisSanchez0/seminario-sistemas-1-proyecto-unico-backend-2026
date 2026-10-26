const fs = require('fs');
const path = require('path');

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');

//! Inicializamos cliente de S3
const s3 = new S3Client({
  region: process.env.AWS_REGION,

});

//? Generamos un nombre aleatorio para el archivo manteniendo la extensión
const generateFileName = (originalName) => {
  const ext = path.extname(originalName);
  return crypto.randomBytes(16).toString('hex') + ext;
};

//! Subimos un archivo a S3
const uploadFile = async (file, folder) => {
  const fileName = generateFileName(file.name);
  const key = `${folder}/${fileName}`;

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: fs.createReadStream(file.tempFilePath),
    ContentType: file.mimetype,
  });

  await s3.send(command);

  return { key };
};

//? Obtenemos una URL firmada temporal para un archivo en S3
const getFileUrl = async (key) => {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
  });

  return await getSignedUrl(s3, command, { expiresIn: 3600 });
};

//! Eliminamos un archivo en S3
const deleteFile = async (key) => {
  const command = new DeleteObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
  });
  await s3.send(command);
};

const getFileStream = async (key) => {
  const command = new GetObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
  });
  const data = await s3.send(command);
  return {
    body:          data.Body,
    contentType:   data.ContentType,
    contentLength: data.ContentLength,
  };
};

module.exports = {
  uploadFile,
  getFileUrl,
  getFileStream,
  deleteFile,
};
