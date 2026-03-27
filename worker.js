// worker.js - PHASE 1: Celebrity Gossip (Images Only with Manual/Auto)
const pool = require('./db');
const { Client } = require('pg');
const axios = require('axios');
const express = require('express');
const app = express();
app.use(express.json());

// Step functions (robots)
const { generateScript } = require('./text-robot');
const { generateSegments } = require('./text-processor');
const { generateListicleSegments } = require('./text-processor-listicle');
const { generateAudio } = require('./audio-robot');
const { fetchImageForSingleSegment, getNextPendingSegment, areAllSegmentsComplete, clearDownloadedUrls } = require('./image-robot');
const { renderVideo } = require('./video-robot');
const { generateCaptions, burnCaptionsViaService } = require('./caption-robot'); 

// HTTP notification configuration
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'https://your-frontend.railway.app';

// Retry configuration
const MAX_RETRIES = 3;
const STUCK_JOB_TIMEOUT_MINUTES = 30;

// Concurrency control
const MAX_CONCURRENT_JOBS = 3;
let activeJobs = 0;

// ============================================
// 📊 DATABASE SETUP (Including Triggers)
// ============================================

async function initJobsTable() {
  try {
    // Check if table exists first
    const tableExists = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'jobs'
      );
    `);

    if (!tableExists.rows[0].exists) {
      // Create table with ALL columns
      await pool.query(`
        CREATE TABLE jobs (
          id SERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          prompt TEXT,
          script TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          videotype TEXT,
          duration INT,
          voice TEXT,
          content_flow TEXT DEFAULT 'news',
          media_type TEXT DEFAULT 'images',
          media_mode TEXT DEFAULT 'auto',
          add_captions BOOLEAN DEFAULT FALSE,      
          caption_style TEXT,                     
          transcript JSONB,                        
          caption_file TEXT,
          caption_data JSONB,                       
          segments JSONB,
          segments_audio JSONB,
          media_queries JSONB,
          result_audio TEXT,
          result_video TEXT,
          error_message TEXT,
          retry_count INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );
      `);

    } else {
      // Add missing columns for existing tables
      const columns = ['content_flow', 'media_type', 'media_mode'];
      for (const col of columns) {
        try {
          const defaultVal = col === 'content_flow' ? 'news' : col === 'media_type' ? 'images' : 'auto';
          await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ${col} TEXT DEFAULT '${defaultVal}';`);
        } catch (e) {
          // Column likely exists
        }
      }
      
      // Add caption columns
      try {
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS add_captions BOOLEAN DEFAULT FALSE`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS caption_style TEXT`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS transcript JSONB`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS caption_file TEXT`);
        await pool.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS caption_data JSONB`);
        console.log('✅ Caption columns added/verified');
      } catch (error) {
        console.log('ℹ️ Caption columns already exist');
      }
      
      console.log('✅ Jobs table verified');
    }

    // Create updated_at trigger function
    await pool.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create updated_at trigger (if not exists)
    await pool.query(`
      DROP TRIGGER IF EXISTS trg_update_jobs_updated_at ON jobs;
      CREATE TRIGGER trg_update_jobs_updated_at
      BEFORE UPDATE ON jobs
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at();
    `);

    // ============================================
    // 🔔 LISTEN/NOTIFY TRIGGER SETUP
    // ============================================

    // Create notification function
    await pool.query(`
      CREATE OR REPLACE FUNCTION notify_job_changes()
      RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_notify(
          'job_updates',
          json_build_object(
            'id', NEW.id,
            'status', NEW.status,
            'user_id', NEW.user_id,
            'operation', TG_OP,
            'timestamp', EXTRACT(EPOCH FROM NOW())
          )::text
        );
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Trigger on INSERT
    await pool.query(`
      DROP TRIGGER IF EXISTS job_insert_notify ON jobs;
      CREATE TRIGGER job_insert_notify
      AFTER INSERT ON jobs
      FOR EACH ROW
      EXECUTE FUNCTION notify_job_changes();
    `);

    // Trigger on UPDATE (only when status changes)
    await pool.query(`
      DROP TRIGGER IF EXISTS job_update_notify ON jobs;
      CREATE TRIGGER job_update_notify
      AFTER UPDATE ON jobs
      FOR EACH ROW
      WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION notify_job_changes();
    `);

    console.log('✅ LISTEN/NOTIFY triggers created successfully');

  } catch (error) {
    console.error('❌ Error setting up database:', error.message);
    // Don't throw - let the app continue
  }
}

// ============================================
// 🔔 EVENT-DRIVEN JOB LISTENER
// ============================================

let listenerClient = null;
let isProcessing = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY_MS = 5000;

// Statuses that need processing
const ACTIONABLE_STATUSES = [
  'pending',
  'text_approved',
  'segments_ready',
  'image_segment_approved',
  'images_approved',
  'audio_approved',
  'captions_ready'
];

async function setupJobListener() {
  try {
    // Create dedicated connection for LISTEN (separate from pool)
    listenerClient = new Client({
      connectionString: process.env.DATABASE_URL,
      // Keep connection alive
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    listenerClient.on('error', async (err) => {
      console.error('❌ Listener client error:', err.message);
      await reconnectListener();
    });

    listenerClient.on('end', async () => {
      console.log('⚠️ Listener connection ended unexpectedly');
      await reconnectListener();
    });

    await listenerClient.connect();
    console.log('✅ Connected to PostgreSQL for LISTEN');

    // Subscribe to job notifications
    await listenerClient.query('LISTEN job_updates');
    console.log('👂 Listening for job_updates channel...');

    // Handle incoming notifications
    listenerClient.on('notification', async (msg) => {
      if (msg.channel !== 'job_updates') return;

      try {
        const payload = JSON.parse(msg.payload);
        console.log(`📬 Notification: Job ${payload.id} → ${payload.status} (${payload.operation})`);

        // Only process actionable statuses
        if (ACTIONABLE_STATUSES.includes(payload.status)) {
          // Small delay to let transaction commit
          setTimeout(() => processJobQueue(), 100);
        }
      } catch (err) {
        console.error('❌ Error parsing notification:', err.message);
      }
    });

    reconnectAttempts = 0; // Reset on successful connection

    // Process any existing pending jobs on startup
    console.log('🔍 Checking for existing pending jobs on startup...');
    await processJobQueue();

  } catch (err) {
    console.error('❌ Failed to setup job listener:', err.message);
    await reconnectListener();
  }
}

async function reconnectListener() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnection attempts reached. Worker needs restart.');
    return;
  }

  reconnectAttempts++;
  console.log(`🔄 Reconnecting listener (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

  // Clean up old connection
  if (listenerClient) {
    try {
      await listenerClient.end();
    } catch (e) {
      // Ignore cleanup errors
    }
    listenerClient = null;
  }

  // Wait before reconnecting (exponential backoff)
  const delay = RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1);
  await new Promise(resolve => setTimeout(resolve, delay));
  await setupJobListener();
}

// ============================================
// 🔄 JOB QUEUE PROCESSING
// ============================================

async function processJobQueue() {
  // Prevent concurrent queue processing
  if (isProcessing) {
    return;
  }

  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    console.log(`⏳ At max capacity (${activeJobs}/${MAX_CONCURRENT_JOBS}), will process when slot opens`);
    return;
  }

  isProcessing = true;

  try {
    const availableSlots = MAX_CONCURRENT_JOBS - activeJobs;

    // Fetch jobs that need processing
    const result = await pool.query(
      `SELECT * FROM jobs 
       WHERE status = ANY($1)
       AND status NOT LIKE '%_processing'
       ORDER BY created_at ASC 
       LIMIT $2 
       FOR UPDATE SKIP LOCKED`,
      [ACTIONABLE_STATUSES, availableSlots]
    );

    if (result.rows.length === 0) {
      console.log('😴 No jobs to process, sleeping until next notification...');
      isProcessing = false;
      return;
    }

    console.log(`📋 Processing ${result.rows.length} job(s)...`);

    // Process jobs concurrently
    const promises = result.rows.map(job => processJob(job));
    await Promise.allSettled(promises);

  } catch (err) {
    console.error('❌ Error processing job queue:', err.message);
  } finally {
    isProcessing = false;
  }
}

// ============================================
// 📨 HTTP NOTIFICATION FUNCTIONS
// ============================================

async function notifyScriptForReview(jobData) {
  try {
    await axios.post(`${FRONTEND_BASE_URL}/notify/script-review`, jobData, { timeout: 10000 });
    console.log(`> [worker] Script review notification sent for job ${jobData.id}`);
  } catch (error) {
    console.error(`> [worker] Failed to send script review notification:`, error.message);
  }
}

async function notifySegmentImageForReview(jobData) {
  try {
    await axios.post(`${FRONTEND_BASE_URL}/notify/segment-image-review`, jobData, { timeout: 10000 });
    console.log(`> [worker] Segment image review notification sent for job ${jobData.id}`);
  } catch (error) {
    console.error(`> [worker] Failed to send segment image notification:`, error.message);
  }
}

async function notifyAllImagesComplete(jobData) {
  try {
    await axios.post(`${FRONTEND_BASE_URL}/notify/images-complete`, jobData, { timeout: 10000 });
    console.log(`> [worker] Images complete notification sent for job ${jobData.id}`);
  } catch (error) {
    console.error(`> [worker] Failed to send images complete notification:`, error.message);
  }
}

async function notifyAudioForReview(jobData) {
  try {
    await axios.post(`${FRONTEND_BASE_URL}/notify/audio-review`, jobData, { timeout: 10000 });
    console.log(`> [worker] Audio review notification sent for job ${jobData.id}`);
  } catch (error) {
    console.error(`> [worker] Failed to send audio review notification:`, error.message);
  }
}

async function notifyVideoComplete(jobData) {
  try {
    await axios.post(`${FRONTEND_BASE_URL}/notify/video-complete`, jobData, { timeout: 10000 });
    console.log(`> [worker] Video complete notification sent for job ${jobData.id}`);
  } catch (error) {
    console.error(`> [worker] Failed to send video complete notification:`, error.message);
  }
}

// ============================================
// 🛠️ INDIVIDUAL JOB PROCESSING
// ============================================

async function processJob(job) {
  activeJobs++;
  console.log(`> [worker] Processing job ${job.id} (status: ${job.status}, flow: ${job.content_flow || 'news'}, media: ${job.media_type || 'images'}, mode: ${job.media_mode || 'auto'})`);

  // Atomic lock: Set status to "processing" to prevent race conditions
  let originalStatus = job.status;
  try {
    const lockResult = await pool.query(
      `UPDATE jobs SET status = $1, updated_at = NOW() 
       WHERE id = $2 AND status = $3 
       RETURNING id`,
      [`${job.status}_processing`, job.id, job.status]
    );

    if (lockResult.rows.length === 0) {
      console.log(`> [worker] Job ${job.id} already being processed, skipping`);
      activeJobs--;
      return;
    }

    console.log(`> [worker] Locked job ${job.id} with status ${job.status}_processing`);

  } catch (lockError) {
    console.log(`> [worker] Failed to lock job ${job.id}:`, lockError.message);
    activeJobs--;
    return;
  }

  try {
    switch (originalStatus) {
      case 'pending':
        if (job.prompt && !job.script) {
          console.log(`> [worker] Generating script for job ${job.id}...`);
          const { script, userId } = await generateScript(job.id);

          await pool.query(
            `UPDATE jobs SET script = $1, status = 'text_review', updated_at = NOW() WHERE id = $2`,
            [script, job.id]
          );

          console.log(`> [worker] Job ${job.id} draft script ready, waiting for text approval`);

          await notifyScriptForReview({
            id: job.id,
            user_id: job.user_id,
            script,
          });

        } else if (job.script) {
          await pool.query(
            `UPDATE jobs SET status = 'text_approved', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          console.log(`> [worker] Job ${job.id} script provided, marked as approved`);
        }
        break;

      case 'text_approved':
        console.log(`> [worker] Processing segments for job ${job.id} using ${job.content_flow || 'news'} flow...`);

        let segments;
        const contentFlow = job.content_flow || 'news';

        if (contentFlow === 'listicle') {
          console.log(`> [worker] Using listicle text processor for job ${job.id}`);
          segments = await generateListicleSegments(job.script);
        } else {
          console.log(`> [worker] Using news text processor for job ${job.id}`);
          segments = await generateSegments(job.script);
        }

        const mappedSegments = segments.map(s => ({
          text: s.text,
          duration: 0,
        }));
        const mediaQueries = segments.map(s => s.mediaQuery);  // ✅ RENAMED

        await pool.query(
          `UPDATE jobs 
           SET segments = $1, media_queries = $2, status = 'segments_ready', updated_at = NOW()
           WHERE id = $3`,
          [JSON.stringify(mappedSegments), JSON.stringify(mediaQueries), job.id]
        );

        console.log(`> [worker] Job ${job.id} segments ready (${contentFlow} flow)`);
        break;

      case 'segments_ready':
        console.log(`> [worker] Starting media processing for job ${job.id} (type: ${job.media_type || 'images'}, mode: ${job.media_mode || 'auto'})...`);

        try {
          // Estimate durations if not set
          const jobSegments = job.segments || [];
          let segmentsUpdated = false;

          jobSegments.forEach(seg => {
            if (!seg.duration || seg.duration === 0) {
              const words = seg.text.trim().split(/\s+/).length;
              const estimatedSeconds = Math.ceil(words / 2.5) + 0.5;
              seg.duration = Math.max(2, Math.min(60, estimatedSeconds));
              segmentsUpdated = true;
            }
          });

          if (segmentsUpdated) {
            await pool.query(
              'UPDATE jobs SET segments = $1 WHERE id = $2',
              [JSON.stringify(jobSegments), job.id]
            );
          }

          // ✅ PHASE 1: Block Videos Only and Mixed modes
          if (job.media_type === 'videos' || job.media_type === 'mixed') {
            await pool.query(
              `UPDATE jobs SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
              ['UNDER MAINTENANCE, CHECK BACK LATER - Videos Only and Mixed modes are currently being developed', job.id]
            );
            break;
          }

          // ✅ PHASE 1: Only handle Images Only mode
          if (job.media_type === 'images') {
            const nextSegment = await getNextPendingSegment(job.id);

            if (nextSegment) {
              await pool.query(
                `UPDATE jobs SET status = 'image_segment_review', updated_at = NOW() WHERE id = $1`,
                [job.id]
              );

              // ✅ Check mode: manual or auto
              if (job.media_mode === 'manual') {
                // Request user to upload image
                console.log(`> [worker] Job ${job.id} - manual mode, requesting upload for segment ${nextSegment.segmentIndex + 1}`);
                
                await axios.post(`${FRONTEND_BASE_URL}/notify/segment-upload-request`, {
                  id: job.id,
                  user_id: job.user_id,
                  segmentIndex: nextSegment.segmentIndex,
                  totalSegments: nextSegment.totalSegments,
                  segmentText: nextSegment.segmentText,
                  query: nextSegment.mediaQuery
                });
              } else {
                // Auto-fetch celebrity image
                console.log(`> [worker] Job ${job.id} - auto mode, fetching image for segment ${nextSegment.segmentIndex + 1}`);
                
                const segmentResult = await fetchImageForSingleSegment(job.id, nextSegment.segmentIndex);

                await axios.post(`${FRONTEND_BASE_URL}/notify/segment-image-review`, {
                  id: job.id,
                  user_id: job.user_id,
                  segmentIndex: nextSegment.segmentIndex,
                  totalSegments: nextSegment.totalSegments,
                  segmentText: segmentResult.segmentText,
                  imageUrl: segmentResult.imageUrl,
                  query: nextSegment.mediaQuery
                });
              }
            }
          }
        } catch (error) {
          console.error(`> [worker] Error in segments_ready for job ${job.id}:`, error);
          await pool.query(
            `UPDATE jobs SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
            [error.message, job.id]
          );
        }
        break;

      case 'image_segment_approved':
        // ✅ SIMPLIFIED: Only handle Images Only mode
        const nextPendingSegment = await getNextPendingSegment(job.id);

        if (nextPendingSegment) {
          console.log(`> [worker] Processing next celebrity image ${nextPendingSegment.segmentIndex + 1} for job ${job.id} (mode: ${job.media_mode})...`);

          await pool.query(
            `UPDATE jobs SET status = 'image_segment_review', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );

          // ✅ Check mode: manual or auto
          if (job.media_mode === 'manual') {
            // Request user upload
            await axios.post(`${FRONTEND_BASE_URL}/notify/segment-upload-request`, {
              id: job.id,
              user_id: job.user_id,
              segmentIndex: nextPendingSegment.segmentIndex,
              totalSegments: nextPendingSegment.totalSegments,
              segmentText: nextPendingSegment.segmentText,
              query: nextPendingSegment.mediaQuery
            });
          } else {
            // Auto-fetch
            const nextSegmentResult = await fetchImageForSingleSegment(job.id, nextPendingSegment.segmentIndex);

            await notifySegmentImageForReview({
              id: job.id,
              user_id: job.user_id,
              segmentIndex: nextPendingSegment.segmentIndex,
              totalSegments: nextPendingSegment.totalSegments,
              segmentText: nextSegmentResult.segmentText,
              imageUrl: nextSegmentResult.imageUrl,
              query: nextPendingSegment.mediaQuery
            });
          }
        } else {
          console.log(`> [worker] All celebrity images completed for job ${job.id}`);

          await pool.query(
            `UPDATE jobs SET status = 'images_approved', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );

          await notifyAllImagesComplete({
            id: job.id,
            user_id: job.user_id
          });
        }
        break;

      case 'images_approved':
        console.log(`> [worker] Generating audio for job ${job.id}...`);

        const mergedUrl = await generateAudio(job.id, job.voice);
        await pool.query(
          `UPDATE jobs SET result_audio = $1, status = 'audio_review', updated_at = NOW() WHERE id = $2`,
          [mergedUrl, job.id]
        );

        console.log(`> [worker] Job ${job.id} audio ready, waiting for approval`);

        await notifyAudioForReview({
          id: job.id,
          user_id: job.user_id,
          result_audio: mergedUrl
        });
        break;

      case 'audio_approved':
        console.log(`> [worker] Rendering celebrity video for job ${job.id}...`);

        // ✅ ALWAYS use regular video-robot (image-based)
        const baseVideoUrl = await renderVideo(job.id);

        console.log(`> [worker] Base video completed for job ${job.id}`);

        // Check if captions requested
        if (job.add_captions && job.caption_style) {
          console.log(`> [worker] Captions requested for job ${job.id}, generating transcription...`);
          
          try {
            const captionResult = await generateCaptions(job.id);
            
            if (captionResult) {
              await pool.query(
                `UPDATE jobs 
                 SET transcript = $1, 
                     caption_file = $2,
                     caption_data = $3,
                     status = 'captions_ready',
                     updated_at = NOW() 
                 WHERE id = $4`,
                [
                  JSON.stringify(captionResult.transcriptData),
                  captionResult.captionsFileUrl,
                  JSON.stringify(captionResult.captionsJsData),
                  job.id
                ]
              );
               
              if (global.gc) {
                console.log(`🗑️ Pre-caption-service GC for job ${job.id}`);
                global.gc();
              }
              
              console.log(`> [worker] Job ${job.id} captions ready, proceeding to burn`);
            } else {
              // No captions, mark completed
              await pool.query(
                'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
                ['completed', job.id]
              );
            }
          } catch (captionError) {
            console.error(`> [worker] Caption generation failed for job ${job.id}:`, captionError.message);
            console.warn(`> [worker] Continuing without captions...`);
            
            await pool.query(
              'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
              ['completed', job.id]
            );
          }
        } else {
          // No captions requested
          await pool.query(
            'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
            ['completed', job.id]
          );
          
          console.log(`> [worker] Job ${job.id} completed (no captions) 🎉`);
          
          await notifyVideoComplete({
            id: job.id,
            user_id: job.user_id,
            result_video: baseVideoUrl
          });
        }
        break;

      case 'captions_ready':
        console.log(`> [worker] Burning captions for job ${job.id}...`);
        
        try {
          // Get current video and caption data
          const jobData = await pool.query(
            'SELECT result_video, caption_style, caption_data FROM jobs WHERE id = $1', 
            [job.id]
          );
          
          if (jobData.rows.length === 0) {
            throw new Error('Job not found');
          }
          
          const currentJob = jobData.rows[0];
          
          if (!currentJob.result_video) {
            throw new Error('No base video found');
          }
          
          if (!currentJob.caption_data) {
            throw new Error('No transformed caption data found');
          }
          
          // ✅ Use pre-transformed data
          const captionsJsData = typeof currentJob.caption_data === 'string' 
            ? JSON.parse(currentJob.caption_data) 
            : currentJob.caption_data;
          
          console.log(`✅ Using stored captions data: ${captionsJsData.length} words`);
          console.log(`📝 Sample caption:`, captionsJsData[0]);
          
          // Burn captions via Railway service
          const captionedVideoUrl = await burnCaptionsViaService(
            currentJob.result_video,
            captionsJsData,
            currentJob.caption_style,
            job.id
          );
          
          // Update with captioned video
          await pool.query(
            `UPDATE jobs 
             SET result_video = $1, 
                 status = 'completed',
                 updated_at = NOW() 
             WHERE id = $2`,
            [captionedVideoUrl, job.id]
          );
          
          console.log(`> [worker] Job ${job.id} completed with captions 🎉`);
          
          await notifyVideoComplete({
            id: job.id,
            user_id: job.user_id,
            result_video: captionedVideoUrl
          });
          
        } catch (captionError) {
          console.error(`> [worker] Caption burning failed for job ${job.id}:`, captionError.message);
          console.warn(`> [worker] Falling back to video without captions...`);
          
          await pool.query(
            'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
            ['completed', job.id]
          );
          
          const jobData = await pool.query('SELECT result_video FROM jobs WHERE id = $1', [job.id]);
          await notifyVideoComplete({
            id: job.id,
            user_id: job.user_id,
            result_video: jobData.rows[0].result_video
          });
        }
        break;
        
      case 'text_review':
      case 'image_segment_review':
      case 'audio_review':
        // These are waiting states - reset to non-processing
        await pool.query(
          `UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2`,
          [originalStatus, job.id]
        );
        console.log(`> [worker] Job ${job.id} waiting for ${originalStatus.replace('_', ' ')}`);
        break;

      case 'completed':
        console.log(`> [worker] Job ${job.id} is already completed`);
        break;

      case 'error':
        console.log(`> [worker] Job ${job.id} has error status: ${job.error_message}`);
        break;

      default:
        console.log(`> [worker] Unknown status '${originalStatus}' for job ${job.id}`);
        // Reset to original status
        await pool.query(
          `UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2`,
          [originalStatus, job.id]
        );
        break;
    }
  } catch (err) {
    console.error(`> [worker] Error processing job ${job.id}:`, err);

    // Reset to original status on error (remove _processing suffix)
    await pool.query(
      `UPDATE jobs SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3`,
      [originalStatus, err.message, job.id]
    );

  } finally {
    if (global.gc) {
      const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;
      global.gc();
      const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
      const freed = memBefore - memAfter;
      console.log(`🗑️ Job ${job.id} GC freed ${freed.toFixed(0)}MB (${memBefore.toFixed(0)}MB → ${memAfter.toFixed(0)}MB)`);
    }
    activeJobs--;

    // After completing a job, check if there are more waiting
    if (activeJobs < MAX_CONCURRENT_JOBS) {
      setImmediate(() => processJobQueue());
    }
  }
}

// ============================================
// 🏥 STUCK JOB RECOVERY
// ============================================

async function resetStuckJobs() {
  try {
    // Reset jobs stuck in processing state
    const result = await pool.query(
      `UPDATE jobs 
       SET status = REPLACE(status, '_processing', ''),
           retry_count = COALESCE(retry_count, 0) + 1,
           error_message = 'Job was stuck in processing state, reset for retry',
           updated_at = NOW()
       WHERE status LIKE '%_processing'
       AND updated_at < NOW() - INTERVAL '${STUCK_JOB_TIMEOUT_MINUTES} minutes'
       AND COALESCE(retry_count, 0) < $1
       RETURNING id, status`,
      [MAX_RETRIES]
    );

    if (result.rows.length > 0) {
      console.log(`> [worker] Reset ${result.rows.length} stuck jobs:`, result.rows.map(r => `Job ${r.id}`));
    }

    // Mark permanently stuck jobs as failed
    const failedResult = await pool.query(
      `UPDATE jobs 
       SET status = 'error',
           error_message = 'Job exceeded max retries (${MAX_RETRIES})',
           updated_at = NOW()
       WHERE status LIKE '%_processing'
       AND updated_at < NOW() - INTERVAL '${STUCK_JOB_TIMEOUT_MINUTES} minutes'
       AND COALESCE(retry_count, 0) >= $1
       RETURNING id`,
      [MAX_RETRIES]
    );

    if (failedResult.rows.length > 0) {
      console.log(`> [worker] Marked ${failedResult.rows.length} permanently stuck jobs as failed`);
    }

  } catch (err) {
    console.error('> [worker] Error resetting stuck jobs:', err.message);
  }
}

// ============================================
// 📊 PERIODIC HEALTH CHECK
// ============================================

async function periodicHealthCheck() {
  try {
    // Check listener is alive
    const listenerAlive = listenerClient && 
                         !listenerClient.connection?.stream?.destroyed &&
                         listenerClient._connected;

    if (!listenerAlive) {
      console.log('⚠️ Listener connection appears dead, reconnecting...');
      await reconnectListener();
    }

    // Reset stuck jobs
    await resetStuckJobs();

    // Log memory usage
    const used = process.memoryUsage();
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

    if (global.gc) {
      const beforeGC = used.heapUsed;
      global.gc();
      const afterGC = process.memoryUsage().heapUsed;
      const freed = (beforeGC - afterGC) / 1024 / 1024;
      console.log(`🗑️ Health check GC freed ${freed.toFixed(0)}MB`);
    }
    console.log(`📊 Health: RSS=${mb(used.rss)}MB, Heap=${mb(used.heapUsed)}/${mb(used.heapTotal)}MB, Active=${activeJobs}, Listener=${listenerAlive ? 'OK' : 'DEAD'}`);

  } catch (err) {
    console.error('❌ Health check error:', err.message);
  }
}

// Run health check every 5 MINUTES
setInterval(periodicHealthCheck, 5 * 60 * 1000);

// ============================================
// 🌐 HTTP API ENDPOINTS
// ============================================

app.post('/approve-script', async (req, res) => {
  try {
    const { jobId } = req.body;
    await pool.query('UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', ['text_approved', jobId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/regenerate-script', async (req, res) => {
  try {
    const { jobId } = req.body;
    console.log(`> [worker] REGENERATE-SCRIPT called for job ${jobId}`);
    await pool.query(
      'UPDATE jobs SET status = $1, script = NULL, updated_at = NOW() WHERE id = $2',
      ['pending', jobId]
    );
    console.log(`> [worker] Job ${jobId} reset to pending for script regeneration`);
    res.json({ success: true });
  } catch (error) {
    console.error(`> [worker] Error in regenerate-script:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/update-script', async (req, res) => {
  try {
    const { jobId, script } = req.body;
    await pool.query('UPDATE jobs SET script = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [script, 'text_approved', jobId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/test-captions-service', async (req, res) => {
  try {
    const { testCaptionsService } = require('./caption-robot');
    const result = await testCaptionsService();
    
    res.json({
      success: result,
      service: 'captions-service-test'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/approve-segment', async (req, res) => {
  try {
    const { jobId } = req.body;
    await pool.query('UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', ['image_segment_approved', jobId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/refetch-segment', async (req, res) => {
  console.log('> [worker] Refetch request received:', req.body);

  try {
    const { jobId, segmentIndex } = req.body;

    if (!jobId) {
      return res.status(400).json({ success: false, error: 'Missing jobId' });
    }

    if (segmentIndex === undefined || segmentIndex === null) {
      return res.status(400).json({ success: false, error: 'Missing segmentIndex' });
    }

    console.log(`> [worker] Refetching job ${jobId}, segment ${segmentIndex}`);

    const jobResult = await pool.query('SELECT segments FROM jobs WHERE id = $1', [jobId]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const segments = jobResult.rows[0].segments || [];

    if (segmentIndex < 0 || segmentIndex >= segments.length) {
      return res.status(400).json({ success: false, error: `Invalid segment index ${segmentIndex}` });
    }

    segments[segmentIndex].imageUrl = null;

    await pool.query(
      'UPDATE jobs SET segments = $1, status = $2, updated_at = NOW() WHERE id = $3',
      [JSON.stringify(segments), 'segments_ready', jobId]
    );

    console.log(`> [worker] Successfully marked segment ${segmentIndex} for refetch in job ${jobId}`);
    res.json({ success: true });

  } catch (error) {
    console.error('> [worker] Refetch segment error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/upload-segment-image', async (req, res) => {
  try {
    const { jobId, segmentIndex, imageUrl, fileName, source } = req.body;

    const jobResult = await pool.query('SELECT segments FROM jobs WHERE id = $1', [jobId]);
    const segments = jobResult.rows[0].segments || [];

    if (segmentIndex >= 0 && segmentIndex < segments.length) {
      segments[segmentIndex] = {
        ...segments[segmentIndex],
        imageUrl: imageUrl,
        imageFileName: fileName || 'uploaded-image',
        imageSource: source || 'manual-upload',
        uploadedAt: new Date().toISOString()
      };

      await pool.query(
        'UPDATE jobs SET segments = $1, status = $2, updated_at = NOW() WHERE id = $3',
        [JSON.stringify(segments), 'image_segment_approved', jobId]
      );

      res.json({ success: true });
    } else {
      res.status(400).json({ success: false, error: 'Invalid segment index' });
    }
  } catch (error) {
    console.error('Upload segment image error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/approve-audio', async (req, res) => {
  try {
    const { jobId } = req.body;
    await pool.query('UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', ['audio_approved', jobId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/regenerate-audio', async (req, res) => {
  try {
    const { jobId } = req.body;
    await pool.query('UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2', ['images_approved', jobId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/trigger-segment-refetch', async (req, res) => {
  try {
    const { jobId, segmentIndex } = req.body;

    const jobResult = await pool.query('SELECT segments FROM jobs WHERE id = $1', [jobId]);
    if (jobResult.rows.length === 0) {
      return res.json({ success: false, error: 'Job not found' });
    }

    const segments = jobResult.rows[0].segments || [];
    if (segmentIndex >= 0 && segmentIndex < segments.length) {
      segments[segmentIndex].imageUrl = null;

      await pool.query(
        'UPDATE jobs SET segments = $1, status = $2, updated_at = NOW() WHERE id = $3',
        [JSON.stringify(segments), 'segments_ready', jobId]
      );

      res.json({ success: true });
    } else {
      res.json({ success: false, error: 'Invalid segment index' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/trigger-regeneration', async (req, res) => {
  try {
    const { jobId, newStatus } = req.body;
    await pool.query(
      `UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, jobId]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/job-info/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({ success: true, job: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/approve-job', async (req, res) => {
  try {
    const { jobId } = req.body;

    const jobResult = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const job = jobResult.rows[0];

    await pool.query(
      'UPDATE jobs SET status = $1, updated_at = NOW() WHERE id = $2',
      ['pending', jobId]
    );

    console.log(`> [worker] Job ${jobId} approved by admin, status changed to pending`);

    res.json({
      success: true,
      job: job,
      username: job.user_id
    });
  } catch (error) {
    console.error('> [worker] Error approving job:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  const listenerStatus = listenerClient && !listenerClient.connection?.stream?.destroyed;

  res.json({
    status: 'healthy',
    service: 'worker',
    mode: 'event-driven',
    activeJobs,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    listenerConnected: listenerStatus,
    reconnectAttempts,
    uptime: process.uptime()
  });
});

// ============================================
// 🚀 STARTUP
// ============================================

async function startWorker() {
  console.log('🚀 Starting event-driven worker (PostgreSQL LISTEN/NOTIFY)...');
  console.log('💡 PHASE 1: Celebrity Gossip - Images Only (Manual/Auto)');

  await initJobsTable();
  await setupJobListener();

  console.log('✅ Worker is now event-driven');
  console.log('😴 Sleeping until database notifications arrive...');
}

// Start HTTP server
const WORKER_PORT = process.env.WORKER_PORT || 4000;
app.listen(WORKER_PORT, () => {
  console.log(`🌐 Worker API listening on port ${WORKER_PORT}`);
  startWorker();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');

  if (listenerClient) {
    try {
      await listenerClient.query('UNLISTEN job_updates');
      await listenerClient.end();
    } catch (e) {
      // Ignore errors during shutdown
    }
  }

  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');

  if (listenerClient) {
    try {
      await listenerClient.query('UNLISTEN job_updates');
      await listenerClient.end();
    } catch (e) {
      // Ignore errors during shutdown
    }
  }

  await pool.end();
  process.exit(0);
});
