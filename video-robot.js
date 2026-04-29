// video-robot.js - Ken Burns with native FFmpeg
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');
const axios = require('axios');
const { uploadFile, getFileUrl } = require('./storage');
const pool = require('./db');
require('dotenv').config();

// Video format configurations
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
    `video-job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  );
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function cleanupTempDir(tempDir) {
  try {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      console.log(`🧹 Cleaned up temp directory: ${tempDir}`);
    }
  } catch (error) {
    console.error(`⚠️ Failed to cleanup temp directory ${tempDir}:`, error.message);
  }
}

async function downloadToBuffer(url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 200 * 1024 * 1024,
      });
      return Buffer.from(response.data);
    } catch (error) {
      console.warn(`⏳ Download attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

function saveBufferToTemp(buffer, tempDir, filename) {
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ============================================
// 🎬 VIDEO SEGMENT PATH
// Downloads celebrity video clip from R2
// Trims to exact segment duration
// Adds blurred background for aspect ratio mismatch
// Loops seamlessly if clip is shorter than needed
// ============================================

async function processVideoSegment(segment, format, tempDir, index) {
  const { width, height } = videoFormats[format];
  const outputPath = path.join(tempDir, `video_clip_${index}.mp4`);

  // ✅ Use exact audio duration (no padding)
  const clipDuration = segment.duration;

  console.log(
    `🎬 Processing video segment ${index + 1} ` +
    `(${segment.duration}s)`
  );

  try {
    // Download video clip from R2
    const videoBuffer = await downloadToBuffer(segment.videoUrl);
    const inputPath = saveBufferToTemp(
      videoBuffer,
      tempDir,
      `stock_input_${index}.mp4`
    );

    // Blur background handles any aspect ratio mismatch
    // stream_loop -1 seamlessly loops clips shorter than clipDuration
    const filter =
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=20[bg];` +
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p`;

    const cmd =
      `ffmpeg -y -stream_loop -1 -i "${inputPath}" ` +
      `-t ${clipDuration} ` +
      `-filter_complex "${filter}" ` +
      `-c:v libx264 -preset fast -crf 23 -r 25 -an "${outputPath}"`;

    execSync(cmd, { stdio: 'pipe' });

    console.log(
      `✅ Video segment ${index + 1} processed ` +
      `(${clipDuration.toFixed(2)}s with blur background)`
    );

    // isVideo flag tells the clip generation loop to skip Ken Burns
    return { path: outputPath, isVideo: true };

  } catch (error) {
    console.error(`❌ Failed to process video segment ${index}:`, error.message);
    throw error;
  }
}

// ============================================
// 🖼️ IMAGE SEGMENT PATH: Sharp preprocessing
// Smart scaling that preserves faces and important content
// Handles orientation mismatch with blurred backgrounds
// ============================================

async function preprocessImage(imageBuffer, format, tempDir, index) {
  const { width, height } = videoFormats[format];
  const outputPath = path.join(tempDir, `processed_${index}.jpg`);

  const img = sharp(imageBuffer);
  const metadata = await img.metadata();
  const isPortrait = metadata.width < metadata.height;

  try {
    if (format === 'longform') {
      if (isPortrait) {
        // Portrait image on landscape canvas - use blurred background
        const blurredBg = await img.clone()
          .resize(width, height, { fit: 'cover', position: 'center' })
          .blur(70)
          .jpeg()
          .toBuffer();

        const foreground = await img.clone()
          .resize(width, height, {
            fit: 'contain',  // Fit entire image, don't crop
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png()
          .toBuffer();

        await sharp(blurredBg)
          .composite([{ input: foreground, gravity: 'center' }])
          .jpeg()
          .toFile(outputPath);
      } else {
        // ✅ Landscape - smart scaling to avoid cropping
        const aspectRatio = metadata.width / metadata.height;
        const targetAspect = width / height;

        // If aspect ratios are very close, just resize with cover
        if (Math.abs(aspectRatio - targetAspect) < 0.1) {
          await img
            .resize(width, height, { fit: 'cover', position: 'center' })
            .jpeg()
            .toFile(outputPath);
        } else {
          // Different aspect ratio - use blurred background to avoid cropping
          const blurredBg = await img.clone()
            .resize(width, height, { fit: 'cover', position: 'center' })
            .blur(70)
            .jpeg()
            .toBuffer();

          const foreground = await img.clone()
            .resize(width, height, {
              fit: 'contain',
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toBuffer();

          await sharp(blurredBg)
            .composite([{ input: foreground, gravity: 'center' }])
            .jpeg()
            .toFile(outputPath);
        }
      }
    } else if (format === 'shorts' || format === 'reels') {
      const portraitHeight = 2200;
      const portraitWidth = 1350;

      if (isPortrait) {
        // Portrait image in portrait video: use contain to avoid cropping faces
        await img
          .resize(portraitWidth, portraitHeight, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0 }
          })
          .jpeg()
          .toFile(outputPath);
      } else {
        // Landscape image in portrait video:
        // blur background + contain foreground
        const blurredBg = await img.clone()
          .resize(portraitWidth, portraitHeight, { fit: 'cover' })
          .blur(70)
          .jpeg()
          .toBuffer();

        const foreground = await img.clone()
          .resize(portraitWidth, portraitHeight, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .png()
          .toBuffer();

        await sharp(blurredBg)
          .composite([{ input: foreground, gravity: 'center' }])
          .jpeg()
          .toFile(outputPath);
      }
    }

    return { path: outputPath, isPortrait };

  } catch (error) {
    console.error(`❌ Failed to preprocess image ${index}:`, error.message);
    throw error;
  }
}

// ============================================
// 🖼️ IMAGE SEGMENT PATH: Ken Burns motion clip
// Takes preprocessed image → animated video clip
// ✅ EXACT duration (no padding)
// ============================================

function generateMotionClip(imagePath, isPortrait, format, segment, index, tempDir) {
  const { width, height } = videoFormats[format];
  const outputPath = path.join(tempDir, `clip_${index}.mp4`);
  const fps = 25;

  // ✅ Use exact audio duration (no padding)
  const duration = segment.duration;
  const totalFrames = Math.ceil(duration * fps);

  const targetZoom = format === 'longform' ? 1.2 : 1.35;
  const panAmount = format === 'longform' ? 0.05 : 0.08;

  // Lock to zoom-in for problematic orientation combos
  let kenBurnsPreset;

  if ((format === 'shorts' || format === 'reels') && !isPortrait) {
    kenBurnsPreset = 'zoom-in';
    console.log(`🔒 Landscape image in ${format} → forced zoom-in`);
  } else if (format === 'longform' && isPortrait) {
    kenBurnsPreset = 'zoom-in';
    console.log(`🔒 Portrait image in longform → forced zoom-in`);
  } else {
    const presets = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
    kenBurnsPreset = presets[Math.floor(Math.random() * presets.length)];
    console.log(`🎲 Segment ${index + 1} Ken Burns: ${kenBurnsPreset}`);
  }

  let zoomExpr, xExpr, yExpr;

  switch (kenBurnsPreset) {
    case 'zoom-in':
      zoomExpr = `1+((${targetZoom}-1)*on/${totalFrames})`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `ih/2-(ih/zoom/2)`;
      break;
    case 'zoom-out':
      zoomExpr = `${targetZoom}-((${targetZoom}-1)*on/${totalFrames})`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `ih/2-(ih/zoom/2)`;
      break;
    case 'pan-left':
      zoomExpr = `1.1`;
      xExpr = `(iw/2-(iw/zoom/2))+(iw*${panAmount}/2)-(iw*${panAmount}*on/${totalFrames})`;
      yExpr = `ih/2-(ih/zoom/2)`;
      break;
    case 'pan-right':
      zoomExpr = `1.1`;
      xExpr = `(iw/2-(iw/zoom/2))-(iw*${panAmount}/2)+(iw*${panAmount}*on/${totalFrames})`;
      yExpr = `ih/2-(ih/zoom/2)`;
      break;
    case 'pan-up':
      zoomExpr = `1.1`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `(ih/2-(ih/zoom/2))+(ih*${panAmount}/2)-(ih*${panAmount}*on/${totalFrames})`;
      break;
    case 'pan-down':
      zoomExpr = `1.1`;
      xExpr = `iw/2-(iw/zoom/2)`;
      yExpr = `(ih/2-(ih/zoom/2))-(ih*${panAmount}/2)+(ih*${panAmount}*on/${totalFrames})`;
      break;
  }

  const filter =
    `scale=8000:-1,` +
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
    `d=${totalFrames}:s=${width}x${height}:fps=${fps},` +
    `format=yuv420p`;

  const cmd =
    `ffmpeg -y -loop 1 -i "${imagePath}" ` +
    `-vf "${filter}" -pix_fmt yuv420p -r ${fps} ` +
    `-t ${duration} "${outputPath}"`;

  execSync(cmd, { stdio: 'pipe' });

  return outputPath;
}

// ============================================
// 🔀 MERGE ALL CLIPS (simple concat, no transitions)
// Works identically for image clips and video clips
// ============================================

function mergeVideoClips(clipPaths, tempDir) {
  const mergedVideoPath = path.join(tempDir, 'merged.mp4');
  const concatFilePath = path.join(tempDir, 'concat.txt');

  try {
    const concatContent = clipPaths.map(clip => `file '${clip}'`).join('\n');
    fs.writeFileSync(concatFilePath, concatContent);

    console.log(`🔗 Merging ${clipPaths.length} clips...`);

    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatFilePath}" -c:v libx264 -preset fast -crf 18 "${mergedVideoPath}"`;

    execSync(cmd, { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024 });
    fs.unlinkSync(concatFilePath);

    return mergedVideoPath;
  } catch (error) {
    console.error('❌ Failed to merge video clips:', error.message);
    throw error;
  }
}

// ============================================
// 🔊 ADD NARRATION AUDIO
// ============================================

function addAudioToVideo(videoPath, audioPath, tempDir) {
  const outputPath = path.join(tempDir, 'video_with_audio.mp4');

  const cmd =
    `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ` +
    `-map 0:v:0 -map 1:a:0 ` +
    `-c:v libx264 -c:a aac "${outputPath}"`;

  try {
    execSync(cmd, { stdio: 'pipe' });
    return outputPath;
  } catch (error) {
    console.error('❌ Failed to add audio to video:', error.message);
    throw error;
  }
}

// ============================================
// 🎬 MAIN RENDER FUNCTION
// Handles images-only and mixed jobs
// Per-segment routing:
//   segment.videoUrl → processVideoSegment() → trim/scale/blur clip
//   segment.imageUrl → preprocessImage() → generateMotionClip() → Ken Burns clip
// Both clip types then go through the same merge + audio pipeline
// ✅ NO TRANSITIONS, NO PADDING
// ============================================

async function renderVideo(jobId) {
  let tempDir;
  console.log(`🎬 [video-robot] Starting video render for job ${jobId}`);

  try {
    tempDir = createTempDir();
    console.log(`📁 Created temp directory: ${tempDir}`);

    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE id = $1',
      [jobId]
    );
    if (rows.length === 0) throw new Error(`Job ${jobId} not found`);

    const job = rows[0];
    const segments = job.segments || [];
    const format = job.videotype;
    const mediaType = job.media_type || 'images';

    if (!segments.length) throw new Error(`Job ${jobId} has no segments`);
    if (!job.result_audio) throw new Error(`Job ${jobId} has no audio file`);

    const audioDuration = segments.reduce(
      (total, seg) => total + (seg.duration || 0),
      0
    );

    console.log(
      `📊 Job details: ${segments.length} segments, ` +
      `format: ${format}, media: ${mediaType}, ` +
      `total duration: ${audioDuration.toFixed(1)}s`
    );

    // ============================================
    // STEP 1: Process each segment into a raw clip
    // Video segments → processVideoSegment (trim/scale/blur)
    // Image segments → preprocessImage (Sharp)
    // ============================================
    const processedMedia = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];

      if (segment.videoUrl) {
        console.log(
          `🎬 Processing video segment ${i + 1}/${segments.length} ` +
          `[${segment.videoPlatform || 'celebrity video'}] ` +
          `(${segment.duration}s)`
        );
        const processed = await processVideoSegment(segment, format, tempDir, i);
        processedMedia.push(processed);

      } else if (segment.imageUrl) {
        console.log(
          `🖼️ Processing image segment ${i + 1}/${segments.length} ` +
          `(${segment.duration}s)`
        );
        const imageBuffer = await downloadToBuffer(segment.imageUrl);
        const processed = await preprocessImage(imageBuffer, format, tempDir, i);
        processedMedia.push(processed);

      } else {
        throw new Error(
          `Segment ${i + 1} has no imageUrl or videoUrl — ` +
          `check the media fetching pipeline`
        );
      }
    }

    // ============================================
    // STEP 2: Generate final clips
    // Video segments → already a clip (isVideo: true), use directly
    // Image segments → Ken Burns motion effect
    // ✅ NO PADDING - exact duration
    // ============================================
    const clipPaths = [];

    for (let i = 0; i < segments.length; i++) {
      if (processedMedia[i].isVideo) {
        console.log(`✅ Using pre-processed video clip ${i + 1}/${segments.length}`);
        clipPaths.push(processedMedia[i].path);
      } else {
        console.log(
          `🎥 Generating Ken Burns clip ${i + 1}/${segments.length} ` +
          `(${segments[i].duration}s exact)`
        );
        const clipPath = generateMotionClip(
          processedMedia[i].path,
          processedMedia[i].isPortrait,
          format,
          segments[i],
          i,
          tempDir
        );
        clipPaths.push(clipPath);
      }
    }

    // ============================================
    // STEP 3: Merge all clips (simple concat, no transitions)
    // ============================================
    console.log(
      `🔄 Merging ${clipPaths.length} clips ` +
      `(${processedMedia.filter(m => m.isVideo).length} video, ` +
      `${processedMedia.filter(m => !m.isVideo).length} image)...`
    );
    const mergedVideoPath = mergeVideoClips(clipPaths, tempDir);

    // ============================================
    // STEP 4: Add narration audio
    // ============================================
    console.log('🎵 Downloading narration audio...');
    const audioBuffer = await downloadToBuffer(job.result_audio);
    const audioPath = saveBufferToTemp(audioBuffer, tempDir, 'narration.mp3');

    console.log('🔊 Adding audio to video...');
    const finalVideoPath = addAudioToVideo(mergedVideoPath, audioPath, tempDir);

    // ============================================
    // STEP 5: Upload final video to R2
    // ============================================
    console.log('☁️ Uploading final video to R2...');
    const finalVideoBuffer = fs.readFileSync(finalVideoPath);
    const videoKey = `jobs/${jobId}/final-video.mp4`;
    const videoUrl = await uploadFile(videoKey, finalVideoBuffer, 'video/mp4');

    // Save result to database
    await pool.query(
      'UPDATE jobs SET result_video = $1 WHERE id = $2',
      [videoUrl, jobId]
    );

    console.log(`✅ [video-robot] Video render complete for job ${jobId}`);
    return videoUrl;

  } catch (error) {
    console.error(
      `❌ [video-robot] Error rendering video for job ${jobId}:`,
      error.message
    );
    throw error;

  } finally {
    if (tempDir) cleanupTempDir(tempDir);
    if (global.gc) {
      global.gc();
      console.log(`🗑️ [video-robot] GC after job ${jobId}`);
    }
  }
}

module.exports = { renderVideo };
