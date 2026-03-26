// storage.js - Improved version with error handling
require("dotenv").config();
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Validate environment variables on startup
const requiredEnvVars = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
}

// Setup S3 client for Cloudflare R2
const s3 = new S3Client({
  region: "auto", // R2 doesn't use regions, but required by SDK
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

// ------------------
// Upload buffer/file with error handling
// ------------------
async function uploadFile(key, data, contentType = "application/octet-stream") {
  try {
    if (!key || !data) {
      throw new Error('Missing required parameters: key and data');
    }

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
    }));

    // If bucket has public domain mapped:
    if (process.env.R2_PUBLIC_URL) {
      return `${process.env.R2_PUBLIC_URL}/${key}`;
    }
    
    // Otherwise, return signed URL (valid for 7 days)
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { 
      expiresIn: 60 * 60 * 24 * 7 
    });
  } catch (error) {
    console.error(`Failed to upload file ${key}:`, error);
    throw new Error(`Upload failed: ${error.message}`);
  }
}

async function deleteFile(key) {
  try {
    if (!key) {
      throw new Error('Missing required parameter: key');
    }

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch (error) {
    console.error(`Failed to delete file ${key}:`, error);
    throw new Error(`Delete failed: ${error.message}`);
  }
}

// ------------------
// Get signed URL with error handling
// ------------------
async function getFileUrl(key, expiresIn = 3600) {
  try {
    if (!key) {
      throw new Error('Missing required parameter: key');
    }

    if (process.env.R2_PUBLIC_URL) {
      return `${process.env.R2_PUBLIC_URL}/${key}`;
    }
    
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { 
      expiresIn 
    });
  } catch (error) {
    console.error(`Failed to get URL for file ${key}:`, error);
    throw new Error(`Get URL failed: ${error.message}`);
  }
}

module.exports = { uploadFile, deleteFile, getFileUrl };
