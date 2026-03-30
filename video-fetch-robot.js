// video-fetch-robot.js - Celebrity Gossip Video Fetcher
// Searches via Serper, downloads via yt-dlp, uploads to R2
const axios = require('axios');
const { execSync } = require('child_process');
const { promisify } = require('util');
const { exec } = require('child_process');
const execPromise = promisify(exec);
const fs = require('fs');
const path = require('path');
const os = require('os');
const pool = require('./db');
const { uploadFile } = require('./storage');
require('dotenv').config();

// yt-dlp binary path
const YT_DLP_PATH = path.join(__dirname, 'yt-dlp');

// ============================================
// 🔧 YT-DLP SETUP
// ============================================

async function ensureYtDlp() {
  if (!fs.existsSync(YT_DLP_PATH)) {
    console.log('📦 Downloading yt-dlp binary...');
    execSync(
      `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ${YT_DLP_PATH}`
    );
    execSync(`chmod +x ${YT_DLP_PATH}`);
    console.log('✅ yt-dlp ready');
  }
}

// ============================================
// 🔍 SERPER VIDEO SEARCH
// ============================================

async function searchVideosWithSerper(query, maxResults = 10) {
  console.log(`🔍 Searching Serper for celebrity videos: "${query}"`);

  try {
    const response = await axios.post(
      'https://google.serper.dev/videos',
      {
        q: query,
        num: Math.min(maxResults, 20)
      },
      {
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    if (!response.data.videos || response.data.videos.length === 0) {
      console.log(`⚠️ No videos found for: "${query}"`);
      return [];
    }

    // Filter out YouTube — yt-dlp handles most platforms but
    // YouTube videos are often age-restricted or removed quickly
    // and are not ideal for gossip clips
    const videos = response.data.videos
      .filter(video => {
        const url = (video.link || '').toLowerCase();
        return !url.includes('youtube.com') && !url.includes('youtu.be');
      })
      .map(video => ({
        url: video.link,
        title: video.title || '',
        snippet: video.snippet || '',
        platform: extractPlatform(video.link)
      }));

    console.log(`✅ Found ${videos.length} downloadable videos from Serper`);
    return videos;

  } catch (error) {
    console.error('❌ Serper API error:', error.response?.data || error.message);
    return [];
  }
}

function extractPlatform(url = '') {
  const platforms = {
    'tiktok.com': 'TikTok',
    'instagram.com': 'Instagram',
    'twitter.com': 'Twitter/X',
    'x.com': 'Twitter/X',
    'facebook.com': 'Facebook',
    'dailymotion.com': 'Dailymotion',
    'vimeo.com': 'Vimeo',
    'reddit.com': 'Reddit',
    'streamable.com': 'Streamable',
    'twitch.tv': 'Twitch'
  };

  for (const [domain, name] of Object.entries(platforms)) {
    if (url.includes(domain)) return name;
  }
  return 'Unknown';
}

// ============================================
// 📥 YT-DLP DOWNLOAD
// ============================================

async function downloadVideoWithYtDlp(url, tempDir) {
  await ensureYtDlp();

  const outputTemplate = path.join(tempDir, '%(id)s.%(ext)s');

  console.log(`⬇️ Downloading via yt-dlp: ${url}`);

  try {
    // Download best mp4 format available
    execSync(
      `${YT_DLP_PATH} -f "best[ext=mp4]/best" --no-playlist -o "${outputTemplate}" "${url}"`,
      { stdio: 'pipe', timeout: 120000 }
    );

    // Get the actual filename
    const { stdout } = await execPromise(
      `${YT_DLP_PATH} --get-filename -o "${outputTemplate}" "${url}"`
    );

    const downloadedPath = stdout.trim();

    if (!fs.existsSync(downloadedPath)) {
      // yt-dlp might have used a different extension — find it
      const files = fs.readdirSync(tempDir);
      if (files.length === 0) {
        throw new Error('yt-dlp completed but no file was written');
      }
      return path.join(tempDir, files[0]);
    }

    console.log(`✅ Downloaded: ${path.basename(downloadedPath)}`);
    return downloadedPath;

  } catch (error) {
    console.error(`❌ yt-dlp download failed:`, error.message);
    throw error;
  }
}

// ============================================
// 🗜️ COMPRESS & UPLOAD TO R2
// ============================================

async function compressAndUpload(inputPath, jobId, segmentIndex) {
  const tempDir = path.dirname(inputPath);
  const outputPath = path.join(tempDir, `compressed_${segmentIndex}.mp4`);

  const statMB = (fs.statSync(inputPath).size / (1024 * 1024)).toFixed(2);
  console.log(`📦 Input size: ${statMB}MB`);

  // If under 15MB, skip compression
  if (fs.statSync(inputPath).size <= 15 * 1024 * 1024) {
    console.log('✅ Under 15MB — skipping compression');
    const buffer = fs.readFileSync(inputPath);
    const key = `jobs/${jobId}/celebrity-videos/segment-${segmentIndex}.mp4`;
    const uploadedUrl = await uploadFile(key, buffer, 'video/mp4');
    console.log(`☁️ Uploaded to R2: ${key}`);
    return uploadedUrl;
  }

  // Probe duration for bitrate calculation
  let duration = 10;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration ` +
      `-of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      { encoding: 'utf-8', timeout: 30000 }
    );
    duration = parseFloat(probe.trim()) || 10;
  } catch (e) {
    console.warn('⚠️ Could not probe duration, using 10s estimate');
  }

  // Calculate target bitrate to hit ~12MB
  const targetBits = 12 * 1024 * 1024 * 8;
  const audioBitrate = 128 * 1000;
  const videoBitrateK = Math.max(
    500,
    Math.floor(((targetBits / duration) - audioBitrate) / 1000)
  );

  console.log(`🔧 Compressing: duration=${duration.toFixed(1)}s, videoBitrate=${videoBitrateK}k`);

  try {
    execSync(
      `ffmpeg -y -i "${inputPath}" ` +
      `-c:v libx264 -preset fast -crf 28 ` +
      `-maxrate ${videoBitrateK}k -bufsize ${videoBitrateK * 2}k ` +
      `-c:a aac -b:a 128k -movflags +faststart "${outputPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
  } catch (err) {
    console.warn('⚠️ Normal compression failed, using ultrafast fallback...');
    execSync(
      `ffmpeg -y -i "${inputPath}" ` +
      `-c:v libx264 -crf 32 -preset ultrafast ` +
      `-c:a aac -b:a 96k "${outputPath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );
  }

  const compressedMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2);
  console.log(`✅ Compressed: ${statMB}MB → ${compressedMB}MB`);

  // Aggressive pass if still too large
  if (fs.statSync(outputPath).size > 18 * 1024 * 1024) {
    console.warn('⚠️ Still too large, applying aggressive compression...');
    const aggressivePath = path.join(tempDir, `aggressive_${segmentIndex}.mp4`);

    execSync(
      `ffmpeg -y -i "${outputPath}" ` +
      `-c:v libx264 -crf 35 -preset fast ` +
      `-vf "scale='min(720,iw)':-2" ` +
      `-c:a aac -b:a 64k "${aggressivePath}"`,
      { stdio: 'pipe', timeout: 120000 }
    );

    const aggressiveMB = (fs.statSync(aggressivePath).size / (1024 * 1024)).toFixed(2);
    console.log(`✅ Aggressive pass: ${compressedMB}MB → ${aggressiveMB}MB`);

    const buffer = fs.readFileSync(aggressivePath);
    const key = `jobs/${jobId}/celebrity-videos/segment-${segmentIndex}.mp4`;
    const uploadedUrl = await uploadFile(key, buffer, 'video/mp4');
    console.log(`☁️ Uploaded to R2: ${key}`);
    return uploadedUrl;
  }

  const buffer = fs.readFileSync(outputPath);
  const key = `jobs/${jobId}/celebrity-videos/segment-${segmentIndex}.mp4`;
  const uploadedUrl = await uploadFile(key, buffer, 'video/mp4');
  console.log(`☁️ Uploaded to R2: ${key}`);
  return uploadedUrl;
}

// ============================================
// 🎬 FETCH VIDEO FOR SINGLE SEGMENT
// ============================================

// Track already-used URLs per job in memory to avoid duplicates
const usedVideoUrls = new Map(); // jobId → Set of URLs

async function fetchVideoForSingleSegment(jobId, segmentIndex) {
  let tempDir;

  try {
    console.log(`🎬 [video-fetch-robot] Fetching video for job ${jobId}, segment ${segmentIndex}`);

    // Load job data
    const { rows } = await pool.query(
      'SELECT segments, video_queries, image_queries, videotype FROM jobs WHERE id = $1',
      [jobId]
    );

    if (rows.length === 0) throw new Error(`Job ${jobId} not found`);

    const segments = rows[0].segments || [];
    // video_queries is primary, image_queries as backwards compat fallback
    const videoQueries = rows[0].video_queries || rows[0].image_queries || [];
    const videotype = rows[0].videotype;

    if (segmentIndex >= segments.length) {
      throw new Error(`Segment index ${segmentIndex} out of range`);
    }

    const segment = segments[segmentIndex];
    const query = videoQueries[segmentIndex] || `${segment.text.substring(0, 50)} celebrity video`;

    console.log(`🔍 Video query: "${query}"`);

    // Init URL tracking for this job
    if (!usedVideoUrls.has(jobId)) {
      usedVideoUrls.set(jobId, new Set());
    }
    const usedUrls = usedVideoUrls.get(jobId);

    // Also track previously rejected video URLs from segment data
    const rejectedUrls = new Set(segment.rejectedVideoUrls || []);

    // Search for videos
    const videos = await searchVideosWithSerper(query, 15);

    if (videos.length === 0) {
      throw new Error(`No videos found for query: "${query}"`);
    }

    // Filter out already used or rejected URLs
    const availableVideos = videos.filter(
      v => !usedUrls.has(v.url) && !rejectedUrls.has(v.url)
    );

    if (availableVideos.length === 0) {
      throw new Error(`All found videos were already used for this job`);
    }

    // Create temp directory
    tempDir = path.join(
      os.tmpdir(),
      `celeb-video-${jobId}-${segmentIndex}-${Date.now()}`
    );
    fs.mkdirSync(tempDir, { recursive: true });

    // Try each video until one downloads successfully
    let downloadedPath = null;
    let successVideo = null;

    for (const video of availableVideos) {
      console.log(`📥 Trying [${video.platform}]: ${video.title.substring(0, 60)}`);

      try {
        downloadedPath = await downloadVideoWithYtDlp(video.url, tempDir);
        successVideo = video;
        usedUrls.add(video.url);
        break;
      } catch (dlError) {
        console.warn(`⚠️ Failed to download from ${video.platform}: ${dlError.message}`);
        // Continue to next video
      }
    }

    if (!downloadedPath || !successVideo) {
      throw new Error(`Could not download any video for: "${query}"`);
    }

    // Compress and upload to R2
    const uploadedUrl = await compressAndUpload(downloadedPath, jobId, segmentIndex);

    // Get video duration via ffprobe
    let videoDuration = segment.duration || 10;
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration ` +
        `-of default=noprint_wrappers=1:nokey=1 "${downloadedPath}"`,
        { encoding: 'utf-8', timeout: 15000 }
      );
      videoDuration = parseFloat(probe.trim()) || videoDuration;
    } catch (e) {
      console.warn('⚠️ Could not probe downloaded video duration');
    }

    // Update segment in database
    const updatedSegments = [...segments];
    updatedSegments[segmentIndex] = {
      ...updatedSegments[segmentIndex],
      videoUrl: uploadedUrl,
      videoDuration,
      videoSource: successVideo.url,
      videoPlatform: successVideo.platform,
      videoTitle: successVideo.title
    };

    await pool.query(
      'UPDATE jobs SET segments = $1 WHERE id = $2',
      [JSON.stringify(updatedSegments), jobId]
    );

    console.log(
      `✅ Video stored for segment ${segmentIndex} ` +
      `(${successVideo.platform}, ${videoDuration.toFixed(1)}s)`
    );

    return {
      videoUrl: uploadedUrl,
      segmentText: segment.text,
      query,
      duration: videoDuration,
      platform: successVideo.platform,
      title: successVideo.title
    };

  } catch (error) {
    console.error(
      `❌ [video-fetch-robot] Error fetching video for job ${jobId} segment ${segmentIndex}:`,
      error.message
    );
    throw error;

  } finally {
    // Cleanup temp files
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {
        console.warn('⚠️ Temp cleanup failed:', e.message);
      }
    }

    if (global.gc) {
      global.gc();
      console.log(`🗑️ [video-fetch-robot] GC after segment ${segmentIndex}`);
    }
  }
}

// ============================================
// 🔍 GET NEXT PENDING VIDEO SEGMENT
// ============================================

async function getNextPendingVideoSegment(jobId) {
  try {
    const { rows } = await pool.query(
      'SELECT segments, video_queries, image_queries FROM jobs WHERE id = $1',
      [jobId]
    );

    if (rows.length === 0) return null;

    const segments = rows[0].segments || [];
    const videoQueries = rows[0].video_queries || rows[0].image_queries || [];

    const pendingIndex = segments.findIndex(seg => !seg.videoUrl);

    if (pendingIndex === -1) return null;

    return {
      segmentIndex: pendingIndex,
      totalSegments: segments.length,
      segmentText: segments[pendingIndex].text,
      query: videoQueries[pendingIndex] || 'celebrity video',
      segmentDuration: segments[pendingIndex].duration || 0
    };

  } catch (error) {
    console.error(`❌ Error getting next pending video segment:`, error.message);
    return null;
  }
}

// ============================================
// ✅ CHECK ALL VIDEOS COMPLETE
// ============================================

async function areAllVideosComplete(jobId) {
  try {
    const { rows } = await pool.query(
      'SELECT segments FROM jobs WHERE id = $1',
      [jobId]
    );
    const segments = rows[0]?.segments || [];
    return segments.every(seg => seg.videoUrl);
  } catch (error) {
    console.error(`❌ Error checking video completion:`, error.message);
    return false;
  }
}

// ============================================
// 🧹 CLEANUP JOB URL TRACKING
// ============================================

function clearJobVideoUrls(jobId) {
  usedVideoUrls.delete(jobId);
  console.log(`🧹 Cleared video URL cache for job ${jobId}`);
}

module.exports = {
  fetchVideoForSingleSegment,
  getNextPendingVideoSegment,
  areAllVideosComplete,
  clearJobVideoUrls
};
