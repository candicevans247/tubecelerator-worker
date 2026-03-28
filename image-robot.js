// image-robot.js - MOST EFFICIENT VERSION: Using API dimensions and Modified for individual segment processing
const { google } = require("googleapis");
const axios = require("axios");
const { uploadFile } = require("./storage");
const pool = require('./db');
require("dotenv").config();

const customSearch = google.customsearch("v1");

// ---------------------
// Allowed image types
// ---------------------
const allowedMimeTypes = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

const downloadedUrls = new Set();

// ---------------------
// UPDATED: Search APIs with dimensions extraction
// ---------------------
async function fetchFromGoogle(query, maxResults = 10) {
  try {
    const res = await customSearch.cse.list({
      auth: process.env.GOOGLE_API_KEY,
      cx: process.env.GOOGLE_CSE_ID,
      q: query,
      searchType: "image",
      num: Math.min(maxResults, 10),
    });
    
    // Extract URL AND dimensions from API response
    return res.data.items?.map((item) => ({
      url: item.link,
      width: item.image?.width || null,
      height: item.image?.height || null,
      source: 'google',
      title: item.title || ''
    })).filter(img => img.width && img.height && img.width > 100 && img.height > 100) || [];
    
  } catch (err) {
    console.error("❌ Google API error:", err.response?.data || err.message);
    return [];
  }
}

async function fetchFromSerper(query, maxResults = 15) {
  try {
    const res = await axios.post(
      "https://google.serper.dev/images",
      { q: query, num: Math.min(maxResults, 20) },
      {
        headers: {
          "X-API-KEY": process.env.SERPER_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );
    
    // Extract URL AND dimensions from API response
    return res.data.images?.map((item) => ({
      url: item.imageUrl,
      width: item.imageWidth || null,
      height: item.imageHeight || null,
      source: 'serper',
      title: item.title || ''
    })).filter(img => img.width && img.height && img.width > 100 && img.height > 100) || [];
    
  } catch (err) {
    console.error("❌ Serper API error:", err.response?.data || err.message);
    return [];
  }
}

// ---------------------
// Upload downloaded image buffer
// ---------------------
async function uploadImageBuffer(buffer, contentType, jobId, segIndex) {
  try {
    if (!allowedMimeTypes[contentType]) {
      console.warn(`⚠️ Unsupported content type: ${contentType}`);
      return null;
    }

    const ext = allowedMimeTypes[contentType];
    const filename = `jobs/${jobId}/images/query-${segIndex}.${ext}`;
    
    const uploadedUrl = await uploadFile(filename, buffer, contentType);
    console.log(`✅ Uploaded ${filename} to R2`);
    return uploadedUrl;
  } catch (error) {
    console.error(`❌ Failed to upload image buffer:`, error.message);
    return null;
  }
}

// ---------------------
// Sort images by orientation preference
// ---------------------
function sortImagesByPreference(imageDataList, preferredOrientation) {
  if (!preferredOrientation) {
    // No preference, sort by size (larger images first)
    return imageDataList.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  }

  const perfectMatches = [];
  const goodMatches = [];
  const otherImages = [];

  imageDataList.forEach(img => {
    // Calculate aspect ratio and orientation
    const aspectRatio = img.width / img.height;
    const isPortrait = img.height > img.width;
    const isLandscape = img.width > img.height;
    const isSquare = Math.abs(aspectRatio - 1) < 0.1;

    // Add calculated properties
    img.aspectRatio = aspectRatio;
    img.isPortrait = isPortrait;
    img.isLandscape = isLandscape;
    img.isSquare = isSquare;

    if (preferredOrientation === 'portrait') {
      if (isPortrait && aspectRatio <= 0.8) {
        perfectMatches.push(img); // Very portrait (9:16 or taller)
      } else if (isPortrait) {
        goodMatches.push(img); // Moderately portrait
      } else {
        otherImages.push(img);
      }
    } else if (preferredOrientation === 'landscape') {
      if (isLandscape && aspectRatio >= 1.5) {
        perfectMatches.push(img); // Very landscape (16:9 or wider)
      } else if (isLandscape) {
        goodMatches.push(img); // Moderately landscape
      } else {
        otherImages.push(img);
      }
    }
  });

  // Sort each category by image size (larger images first)
  const sortBySize = (a, b) => (b.width * b.height) - (a.width * a.height);
  
  perfectMatches.sort(sortBySize);
  goodMatches.sort(sortBySize);
  otherImages.sort(sortBySize);

  return [...perfectMatches, ...goodMatches, ...otherImages];
}

// ---------------------
// SUPER EFFICIENT: Orientation-aware image fetching
// ---------------------
async function fetchImageForQuery(query, jobId, segIndex, preferredOrientation = null) {
  console.log(`🔍 Fetching images for query: "${query}" (preferred: ${preferredOrientation || 'any'})`);
  
  const sources = [
    { fetch: fetchFromGoogle, name: "Google" },
    { fetch: fetchFromSerper, name: "Serper" },
  ];

  for (const source of sources) {
    console.log(`📡 Checking ${source.name} API...`);
    
    // Get URLs WITH dimensions from API (FREE!)
    const imagesWithDimensions = await source.fetch(query);
    
    if (imagesWithDimensions.length === 0) {
      console.log(`⚠️ No images with dimensions from ${source.name}`);
      continue;
    }

    // Sort by orientation preference (NO DOWNLOADS YET!)
    const sortedImages = sortImagesByPreference(imagesWithDimensions, preferredOrientation);
    
    console.log(`📊 Found ${imagesWithDimensions.length} images from ${source.name}, trying in preference order...`);

    // Now download ONLY the best candidates (1-3 downloads max)
    for (const imageInfo of sortedImages) {
      if (downloadedUrls.has(imageInfo.url)) {
        console.log(`⏭️ Skipping already downloaded image`);
        continue;
      }
      
      try {
        const orientationLabel = imageInfo.isPortrait ? 'portrait' : 
                                imageInfo.isLandscape ? 'landscape' : 'square';
        console.log(`⬇️ Downloading ${orientationLabel} image (${imageInfo.width}x${imageInfo.height}) from ${imageInfo.source}...`);
        
        // Download the full image
        const response = await axios.get(imageInfo.url, {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxContentLength: 10 * 1024 * 1024 // 10MB limit
        });

        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || 'image/jpeg';
        
        // Upload to R2
        const uploadedUrl = await uploadImageBuffer(buffer, contentType, jobId, segIndex);
        
        if (uploadedUrl) {
          downloadedUrls.add(imageInfo.url);
          console.log(`✅ Successfully uploaded ${orientationLabel} image (${imageInfo.width}x${imageInfo.height}) from ${imageInfo.source}`);
          return uploadedUrl;
        }
      } catch (error) {
        console.warn(`⚠️ Failed to download/upload from ${imageInfo.source} (${imageInfo.width}x${imageInfo.height}):`, error.message);
        // Continue to next image
      }
    }
  }

  console.log(`❌ No valid images found for query: "${query}"`);
  return null;
}

// ---------------------
// Orientation-specific placeholder
// ---------------------
async function getPlaceholderImage(jobId, segmentIndex, preferredOrientation = null) {
  try {
    let placeholderKey;
    
    // Use orientation-specific placeholders if available
    if (preferredOrientation === 'portrait') {
      placeholderKey = `placeholders/placeholder.png`;
    } else if (preferredOrientation === 'landscape') {
      placeholderKey = `placeholders/placeholder.png`;
    } else {
      placeholderKey = `placeholders/placeholder.png`;
    }
    
    const { getFileUrl } = require('./storage');
    const placeholderUrl = await getFileUrl(placeholderKey);
    
    console.log(`📷 Using ${preferredOrientation || 'default'} placeholder for job ${jobId}, segment ${segmentIndex + 1}`);
    return placeholderUrl;
  } catch (error) {
    console.error(`❌ Failed to get placeholder image:`, error);
    // Fallback to online placeholder with appropriate dimensions
    const dimensions = preferredOrientation === 'portrait' ? '1080x1920' : 
                     preferredOrientation === 'landscape' ? '1920x1080' : '1080x1080';
    return `https://via.placeholder.com/${dimensions}/cccccc/666666?text=No+Image+Found`;
  }
}

// ---------------------
// MAIN: Individual segment processing with orientation preference
// ---------------------
async function fetchImageForSingleSegment(jobId, segmentIndex) {
  try {
    // Get current job data INCLUDING videotype
    const jobResult = await pool.query(
      'SELECT segments, image_queries, videotype FROM jobs WHERE id = $1', 
      [jobId]
    );
    
    if (jobResult.rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const segments = jobResult.rows[0].segments || [];
    const imageQueries = jobResult.rows[0].image_queries || [];
    const videotype = jobResult.rows[0].videotype;

    if (segmentIndex >= segments.length || segmentIndex >= mediaQueries.length) {
      throw new Error(`Invalid segment index ${segmentIndex} for job ${jobId}`);
    }

    const query = mediaQueries[segmentIndex];
    if (!query) {
      throw new Error(`No media query found for segment ${segmentIndex}`);
    }

    // Determine preferred orientation based on video type
    const preferredOrientation = (videotype === 'reels' || videotype === 'shorts') 
      ? 'portrait'     // Want tall images for vertical videos
      : videotype === 'longform' 
        ? 'landscape'  // Want wide images for horizontal videos
        : null;        // No preference for other types

    console.log(`🎯 Job ${jobId} (${videotype}) - seeking ${preferredOrientation || 'any orientation'} image for segment ${segmentIndex + 1}`);
    console.log(`🔍 Search query: "${query}"`);
    
    // Fetch image with orientation preference
    const imageUrl = await fetchImageForQuery(query, jobId, segmentIndex, preferredOrientation);

    let finalImageUrl = imageUrl;
    let usedFallback = false;

    // Use placeholder if no image found
    if (!imageUrl) {
      console.warn(`⚠️ No image found for query "${query}", using placeholder for segment ${segmentIndex + 1}`);
      finalImageUrl = await getPlaceholderImage(jobId, segmentIndex, preferredOrientation);
      usedFallback = true;
    }

    // Update only this specific segment
    const updatedSegments = [...segments];
    updatedSegments[segmentIndex] = {
      ...updatedSegments[segmentIndex],
      imageUrl: finalImageUrl,
      imageQuery: query,
      usedFallback: usedFallback,
      preferredOrientation: preferredOrientation
    };

    // Save updated segments to database
    await pool.query(
      "UPDATE jobs SET segments = $1 WHERE id = $2",
      [JSON.stringify(updatedSegments), jobId]
    );

    const orientationNote = preferredOrientation ? ` (${preferredOrientation} preferred)` : '';
    if (usedFallback) {
      console.log(`📷 Used placeholder image for segment ${segmentIndex + 1} in job ${jobId}${orientationNote}`);
    } else {
      console.log(`✅ Updated segment ${segmentIndex + 1} for job ${jobId} with fetched image${orientationNote}`);
    }

    return {
      segmentIndex,
      imageUrl: finalImageUrl,
      segmentText: segments[segmentIndex].text,
      query,
      usedFallback,
      preferredOrientation
    };
  } catch (error) {
    console.error(`❌ Error fetching image for segment ${segmentIndex}:`, error);
    throw error;
  }
}

// ---------------------
// NEW: Get next pending segment
// ---------------------
async function getNextPendingSegment(jobId) {
  try {
    const jobResult = await pool.query('SELECT segments, image_queries FROM jobs WHERE id = $1', [jobId]);
    if (jobResult.rows.length === 0) {
      return null;
    }

    const segments = jobResult.rows[0].segments || [];
    const mediaQueries = jobResult.rows[0].image_queries || [];

    // Find first segment without an imageUrl
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i].imageUrl && mediaQueries[i]) {
        return {
          segmentIndex: i,
          totalSegments: segments.length,
          segmentText: segments[i].text,
          imageQuery: mediaQueries[i]
        };
      }
    }

    return null; // All segments have images
  } catch (error) {
    console.error(`❌ Error getting next pending segment for job ${jobId}:`, error);
    return null;
  }
}

// ---------------------
// NEW: Check if all segments have images
// ---------------------
async function areAllSegmentsComplete(jobId) {
  try {
    const jobResult = await pool.query('SELECT segments FROM jobs WHERE id = $1', [jobId]);
    if (jobResult.rows.length === 0) {
      return false;
    }

    const segments = jobResult.rows[0].segments || [];
    return segments.every(segment => segment.imageUrl);
  } catch (error) {
    console.error(`❌ Error checking segment completion for job ${jobId}:`, error);
    return false;
  }
}

function clearDownloadedUrls() {
  downloadedUrls.clear();
  console.log('🧹 Cleared downloaded URLs cache');
}

module.exports = { 
  fetchImageForSingleSegment,
  getNextPendingSegment,
  areAllSegmentsComplete,
  clearDownloadedUrls 
};
