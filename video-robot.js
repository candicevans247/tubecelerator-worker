// video-robot.js - Ken Burns with native FFmpeg (clean, no captions)
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

// Temporary directory management
function createTempDir() {
  const tempDir = path.join(os.tmpdir(), `video-job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
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

// Download file from URL to buffer
async function downloadToBuffer(url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 30000,
        maxContentLength: 50 * 1024 * 1024,
      });
      return Buffer.from(response.data);
    } catch (error) {
      console.warn(`⏳ Download attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}

// Save buffer to temporary file
function saveBufferToTemp(buffer, tempDir, filename) {
  const filePath = path.join(tempDir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ✅ FIXED: Process video segment with transition padding
async function processVideoSegment(segment, format, tempDir, index) {
  const { width, height } = videoFormats[format];
  const outputPath = path.join(tempDir, `video_clip_${index}.mp4`);
  
  // ✅ NEW: Calculate duration WITH transition padding (like images)
  const transitionDuration = 0.5;
  const hasTransitionAfter = segment.hasTransitionAfter !== false;
  const clipDuration = hasTransitionAfter 
    ? segment.duration + transitionDuration 
    : segment.duration;
  
  console.log(`🎬 Processing stock video segment ${index + 1} (${segment.duration}s${hasTransitionAfter ? ' +0.5s padding' : ''})`);
  
  try {
    // Download video from R2
    const videoBuffer = await downloadToBuffer(segment.videoUrl);
    const inputPath = saveBufferToTemp(videoBuffer, tempDir, `stock_input_${index}.mp4`);
    
    // Trim video to duration WITH padding (if needed) and add blurred background
    const filter = 
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20[bg];` +
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
      `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p`;
    
    // ✅ CHANGED: Use clipDuration (includes padding)
    const cmd = `ffmpeg -y -stream_loop -1 -i "${inputPath}" -t ${clipDuration} -filter_complex "${filter}" -c:v libx264 -preset fast -crf 23 -r 25 -an "${outputPath}"`;
    
    execSync(cmd, { stdio: 'pipe' });
    
    console.log(`✅ Stock video segment ${index + 1} processed (${clipDuration}s with blur and padding)`);
    
    return { path: outputPath, isVideo: true };
    
  } catch (error) {
    console.error(`❌ Failed to process video segment ${index}:`, error.message);
    throw error;
  }
}

// Image preprocessing with Sharp
async function preprocessImage(imageBuffer, format, tempDir, index) {
  const { width, height } = videoFormats[format];
  const outputPath = path.join(tempDir, `processed_${index}.jpg`);
  
  const img = sharp(imageBuffer);
  const metadata = await img.metadata();
  const isPortrait = metadata.width < metadata.height;

  try {
    if (format === 'longform') {
      if (isPortrait) {
        const blurredBg = await img.clone()
          .resize(width, height, { fit: 'cover' })
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
      } else {
        await img
          .resize(width, height, { fit: 'cover' })
          .jpeg()
          .toFile(outputPath);
      }
    } else if (format === 'shorts' || format === 'reels') {
      const portraitHeight = 2200;
      const portraitWidth = 1350;

      if (isPortrait) {
        await img
          .resize(portraitWidth, portraitHeight, { fit: 'cover' })
          .jpeg()
          .toFile(outputPath);
      } else {
        const blurredBg = await img.clone()
          .resize(portraitWidth, portraitHeight, { fit: 'cover' })
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

    return { path: outputPath, isPortrait };
  } catch (error) {
    console.error(`❌ Failed to preprocess image ${index}:`, error.message);
    throw error;
  }
}

// Generate motion clips - Ken Burns presets with native FFmpeg zoompan
function generateMotionClip(imagePath, isPortrait, format, segment, index, tempDir) {
  const { width, height } = videoFormats[format];
  const outputPath = path.join(tempDir, `clip_${index}.mp4`);
  const fps = 25;
  const transitionDuration = 0.5;
  
  const hasTransitionAfter = segment.hasTransitionAfter !== false;
  const duration = hasTransitionAfter 
    ? segment.duration + transitionDuration 
    : segment.duration;
    
  const totalFrames = Math.ceil(duration * fps);

  try {
    // Settings based on format
    const targetZoom = format === 'longform' ? 1.2 : 1.35;
    const panAmount = format === 'longform' ? 0.05 : 0.08;
    
    // ✅ Ken Burns preset selection with orientation logic
    let kenBurnsPreset;
    
    if ((format === 'shorts' || format === 'reels') && !isPortrait) {
      kenBurnsPreset = 'zoom-in';
      console.log(`🔒 Landscape in ${format} → zoom-in`);
    } else if (format === 'longform' && isPortrait) {
      kenBurnsPreset = 'zoom-in';
      console.log(`🔒 Portrait in longform → zoom-in`);
    } else {
      const presets = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'];
      kenBurnsPreset = presets[Math.floor(Math.random() * presets.length)];
      console.log(`🎲 Random: ${kenBurnsPreset}`);
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
    
    const filter = `scale=8000:-1,` +
                  `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':` +
                  `d=${totalFrames}:s=${width}x${height}:fps=${fps},` +
                  `format=yuv420p`;
    
    const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -vf "${filter}" -pix_fmt yuv420p -r ${fps} -t ${duration} "${outputPath}"`;
    execSync(cmd, { stdio: 'pipe' });
    
    return outputPath;

  } catch (error) {
    console.error(`❌ Failed to generate motion clip ${index}:`, error.message);
    throw error;
  }
}

// Merge video clips with transitions
function mergeVideoClips(clipPaths, segments, format, tempDir) {
  const mergedVideoPath = path.join(tempDir, 'merged.mp4');
  const { width, height } = videoFormats[format];
  const transitionDuration = 0.5;

  const inputs = clipPaths.map(clip => `-i "${clip}"`).join(' ');
  let filter = '';

  segments.forEach((_, i) => {
    filter += `[${i}:v]scale=${width}:${height},format=yuv420p[v${i}];`;
  });

  let cumulativeAudioDuration = 0;
  
  segments.forEach((seg, i) => {
    if (i === 0) return;
    
    cumulativeAudioDuration += segments[i - 1].duration;
    const transitionOffset = cumulativeAudioDuration - transitionDuration;

    const transitions = format === 'shorts' || format === 'reels'
      ? ['fade', 'slideright', 'smoothleft']
      : ['fade', 'slideleft'];
    
    const transitionType = transitions[(i - 1) % transitions.length];
    
    let inputA, inputB;
    if (i === 1) {
      inputA = '[v0]';
      inputB = '[v1]';
    } else {
      inputA = `[vt${i-1}]`;
      inputB = `[v${i}]`;
    }
    
    const outputLabel = i === segments.length - 1 ? '[vout]' : `[vt${i}]`;
    
    filter += `${inputA}${inputB}xfade=transition=${transitionType}:duration=${transitionDuration}:offset=${transitionOffset.toFixed(2)}${outputLabel};`;
  });

  const cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[vout]" -c:v libx264 -preset fast -crf 18 "${mergedVideoPath}"`;
  
  try {
    execSync(cmd, { stdio: 'pipe' });
    return mergedVideoPath;
  } catch (error) {
    console.error('❌ Failed to merge video clips:', error.message);
    throw error;
  }
}

// Add audio to video
function addAudioToVideo(videoPath, audioPath, tempDir) {
  const outputPath = path.join(tempDir, 'video_with_audio.mp4');
  
  const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 -c:v libx264 -c:a aac "${outputPath}"`;
  
  try {
    execSync(cmd, { stdio: 'pipe' });
    return outputPath;
  } catch (error) {
    console.error('❌ Failed to add audio to video:', error.message);
    throw error;
  }
}

// ✅ CLEAN: Main rendering function (NO caption burning)
async function renderVideo(jobId) {
  let tempDir;
  console.log(`🎬 [video-robot] Starting video rendering for job ${jobId}`);
  
  try {
    tempDir = createTempDir();
    console.log(`📁 Created temp directory: ${tempDir}`);
    
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    if (rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }
    
    const job = rows[0];
    const segments = job.segments || [];
    const format = job.videotype;
    
    if (!segments.length) {
      throw new Error(`Job ${jobId} has no segments`);
    }
    
    if (!job.result_audio) {
      throw new Error(`Job ${jobId} has no audio file`);
    }
    
    const audioDuration = segments.reduce((total, segment) => total + (segment.duration || 0), 0);
    console.log(`📊 Job details: ${segments.length} segments, format: ${format}, total duration: ${audioDuration}s`);
    
   // ✅ UPDATED: Process images OR videos (for stock_mixed support)
    const processedMedia = [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      
      // ✅ NEW: Check if this segment has a video (stock_mixed mode)
      if (segment.videoUrl) {
        console.log(`🎬 Processing stock video ${i + 1}/${segments.length} (duration: ${segment.duration}s)`);
        const processed = await processVideoSegment(segment, format, tempDir, i);
        processedMedia.push(processed);
      } else if (segment.imageUrl) {
        console.log(`🖼️ Processing image ${i + 1}/${segments.length} (duration: ${segment.duration}s)`);
        const imageBuffer = await downloadToBuffer(segment.imageUrl);
        const processed = await preprocessImage(imageBuffer, format, tempDir, i);
        processedMedia.push(processed);
      } else {
        throw new Error(`Segment ${i} has no image URL or video URL`);
      }
    }
    
    // Add transition padding
    for (let i = 0; i < segments.length; i++) {
      segments[i].hasTransitionAfter = (i < segments.length - 1);
    }

  // ✅ UPDATED: Generate motion clips (skip videos, they're already processed)
    const clipPaths = [];
    for (let i = 0; i < segments.length; i++) {
      if (processedMedia[i].isVideo) {
        // ✅ NEW: Video already processed, just use it
        console.log(`✅ Using processed video clip ${i + 1}/${segments.length}`);
        clipPaths.push(processedMedia[i].path);
      } else {
        // Existing image motion logic
        console.log(`🎥 Generating motion clip ${i + 1}/${segments.length} (${segments[i].duration}s${segments[i].hasTransitionAfter ? ' +0.5s padding' : ''})`);
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
    
    // Merge clips with transitions
    console.log('🔄 Merging video clips with transitions...');
    const mergedVideoPath = mergeVideoClips(clipPaths, segments, format, tempDir);
    
    // Add audio
    console.log('🎵 Downloading audio file for merging...');
    const audioBuffer = await downloadToBuffer(job.result_audio);
    const audioPath = saveBufferToTemp(audioBuffer, tempDir, 'narration.mp3');
    
    console.log('🔊 Adding audio to video...');
    const finalVideoPath = addAudioToVideo(mergedVideoPath, audioPath, tempDir);

    // Upload final video
    console.log('☁️ Uploading final video to R2...');
    const finalVideoBuffer = fs.readFileSync(finalVideoPath);
    const videoKey = `jobs/${jobId}/final-video.mp4`;
    const videoUrl = await uploadFile(videoKey, finalVideoBuffer, 'video/mp4');
    
    // ✅ Save result_video in database
    await pool.query(
      'UPDATE jobs SET result_video = $1 WHERE id = $2',
      [videoUrl, jobId]
    );
    
    console.log(`✅ [video-robot] Video rendering completed for job ${jobId}`);
    
    return videoUrl;
    
  } catch (error) {
    console.error(`❌ [video-robot] Error rendering video for job ${jobId}:`, error.message);
    throw error;
  } finally {
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
     if (global.gc) {
    global.gc();
    console.log(`🗑️ [video-robot] GC after job ${jobId}`);
  }
  }
}

module.exports = { renderVideo };
