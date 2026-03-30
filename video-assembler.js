// video-assembler.js - Assembles celebrity video clips into final video
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const { uploadFile } = require('./storage');
const pool = require('./db');
require('dotenv').config();

const videoFormats = {
  reels: { width: 1080, height: 1920 },
  shorts: { width: 1080, height: 1920 },
  longform: { width: 1280, height: 720 }
};

// ============================================
// 🛠️ UTILITIES
// ============================================

function createTempDir() {
  const tempDir = path.join(
    os.tmpdir(),
    `assembler-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  );
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

async function downloadToFile(url, filePath) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 120000,
    maxContentLength: 200 * 1024 * 1024
  });
  fs.writeFileSync(filePath, Buffer.from(response.data));
  const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(2);
  console.log(`✅ Downloaded: ${path.basename(filePath)} (${sizeMB}MB)`);
  return filePath;
}

// ============================================
// ✂️ TRIM + SCALE VIDEO CLIP
// Trims to target duration and scales to output format
// Adds blurred background for non-matching aspect ratios
// Loops video seamlessly if shorter than needed duration
// ============================================

function trimAndScaleClip(inputPath, outputPath, targetDuration, format) {
  const { width, height } = videoFormats[format];

  console.log(`✂️ Trimming/scaling to ${targetDuration}s [${width}x${height}]`);

  // Probe actual video duration
  let actualDuration = targetDuration;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration ` +
      `-of default=noprint_wrappers=1:nokey=1 "${inputPath}"`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    actualDuration = parseFloat(probe.trim()) || targetDuration;
  } catch (e) {
    console.warn('⚠️ Could not probe duration, using target');
  }

  // Use stream_loop to seamlessly loop short clips
  // Blurred background handles aspect ratio mismatch
  const filter =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},gblur=sigma=20[bg];` +
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[out]`;

  const cmd =
    `ffmpeg -y -stream_loop -1 -i "${inputPath}" ` +
    `-t ${targetDuration} ` +
    `-filter_complex "${filter}" ` +
    `-map "[out]" ` +
    `-c:v libx264 -preset fast -crf 23 -r 25 -an "${outputPath}"`;

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 120000 });
    console.log(`✅ Clip processed: ${targetDuration}s`);
  } catch (error) {
    console.error(`❌ Failed to process clip:`, error.message);
    throw error;
  }
}

// ============================================
// 🔀 CONCATENATE VIDEO CLIPS
// Simple concat — no Ken Burns, no xfade transitions
// Clips already scaled and timed from trimAndScaleClip
// ============================================

function concatenateClips(clipPaths, segments, format, tempDir) {
  const mergedPath = path.join(tempDir, 'merged.mp4');
  const { width, height } = videoFormats[format];

  console.log(`🔄 Concatenating ${clipPaths.length} clips...`);

  const inputs = clipPaths.map(p => `-i "${p}"`).join(' ');

  // Scale each clip to ensure uniform resolution
  let filter = '';
  segments.forEach((_, i) => {
    filter += `[${i}:v]scale=${width}:${height},format=yuv420p[v${i}];`;
  });

  const concatInputs = segments.map((_, i) => `[v${i}]`).join('');
  filter += `${concatInputs}concat=n=${segments.length}:v=1:a=0[vout]`;

  const cmd =
    `ffmpeg -y ${inputs} ` +
    `-filter_complex "${filter}" ` +
    `-map "[vout]" ` +
    `-c:v libx264 -preset fast -crf 18 "${mergedPath}"`;

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 180000 });
    console.log(`✅ Concatenated ${clipPaths.length} clips`);
    return mergedPath;
  } catch (error) {
    console.error('❌ Concatenation failed:', error.message);
    throw error;
  }
}

// ============================================
// 🔊 ADD NARRATION AUDIO
// ============================================

function addAudioToVideo(videoPath, audioPath, tempDir) {
  const outputPath = path.join(tempDir, 'final.mp4');

  console.log('🔊 Merging audio with video...');

  const cmd =
    `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ` +
    `-map 0:v:0 -map 1:a:0 ` +
    `-c:v libx264 -c:a aac ` +
    `-shortest "${outputPath}"`;

  try {
    execSync(cmd, { stdio: 'pipe', timeout: 120000 });
    console.log('✅ Audio merged');
    return outputPath;
  } catch (error) {
    console.error('❌ Audio merge failed:', error.message);
    throw error;
  }
}

// ============================================
// 🎬 MAIN ASSEMBLY FUNCTION
// For video-only jobs (media_type = 'videos')
// Each segment must have a videoUrl from video-fetch-robot.js
// ============================================

async function assembleVideoOnlyJob(jobId) {
  let tempDir;
  console.log(`🎬 [video-assembler] Starting video-only assembly for job ${jobId}`);

  try {
    tempDir = createTempDir();

    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE id = $1',
      [jobId]
    );

    if (rows.length === 0) throw new Error(`Job ${jobId} not found`);

    const job = rows[0];
    const segments = job.segments || [];
    const format = job.videotype;

    if (!segments.length) throw new Error(`Job ${jobId} has no segments`);
    if (!job.result_audio) throw new Error(`Job ${jobId} has no audio`);

    const totalDuration = segments.reduce((t, s) => t + (s.duration || 0), 0);
    console.log(
      `📊 ${segments.length} segments, format: ${format}, ` +
      `total duration: ${totalDuration.toFixed(1)}s`
    );

    // Validate all segments have video URLs
    for (let i = 0; i < segments.length; i++) {
      if (!segments[i].videoUrl) {
        throw new Error(
          `Segment ${i} has no videoUrl — ` +
          `run video-fetch-robot first`
        );
      }
    }

    // Download all celebrity video clips
    console.log('📥 Downloading celebrity video clips...');
    const downloadedPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const inputPath = path.join(tempDir, `raw_${i}.mp4`);

      console.log(
        `📥 Downloading clip ${i + 1}/${segments.length} ` +
        `[${segment.videoPlatform || 'unknown'}]: ` +
        `${(segment.videoTitle || '').substring(0, 50)}`
      );

      await downloadToFile(segment.videoUrl, inputPath);
      downloadedPaths.push(inputPath);
    }

    // Trim and scale each clip to match segment duration
    console.log('✂️ Trimming and scaling clips...');
    const trimmedPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const outputPath = path.join(tempDir, `trimmed_${i}.mp4`);
      const targetDuration = segments[i].duration || 5;

      console.log(
        `✂️ Clip ${i + 1}/${segments.length}: ` +
        `${targetDuration}s target`
      );

      trimAndScaleClip(
        downloadedPaths[i],
        outputPath,
        targetDuration,
        format
      );

      trimmedPaths.push(outputPath);
    }

    // Concatenate all trimmed clips
    console.log('🔄 Concatenating clips...');
    const mergedPath = concatenateClips(
      trimmedPaths,
      segments,
      format,
      tempDir
    );

    // Download narration audio
    console.log('🎵 Downloading narration audio...');
    const audioPath = path.join(tempDir, 'narration.mp3');
    await downloadToFile(job.result_audio, audioPath);

    // Merge audio with video
    const finalPath = addAudioToVideo(mergedPath, audioPath, tempDir);

    // Upload final video to R2
    console.log('☁️ Uploading final video to R2...');
    const finalBuffer = fs.readFileSync(finalPath);
    const videoKey = `jobs/${jobId}/final-video.mp4`;
    const videoUrl = await uploadFile(videoKey, finalBuffer, 'video/mp4');

    // Save result to database
    await pool.query(
      'UPDATE jobs SET result_video = $1 WHERE id = $2',
      [videoUrl, jobId]
    );

    console.log(
      `✅ [video-assembler] Video-only assembly complete for job ${jobId}`
    );

    return videoUrl;

  } catch (error) {
    console.error(
      `❌ [video-assembler] Assembly failed for job ${jobId}:`,
      error.message
    );
    throw error;

  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        console.log('🧹 Temp directory cleaned up');
      } catch (e) {
        console.warn('⚠️ Temp cleanup failed:', e.message);
      }
    }

    if (global.gc) {
      global.gc();
      console.log(`🗑️ [video-assembler] GC after job ${jobId}`);
    }
  }
}

module.exports = { assembleVideoOnlyJob };
