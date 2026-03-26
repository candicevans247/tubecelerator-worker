// audio-robot.js 
const ffmpeg = require("fluent-ffmpeg");
const axios = require("axios");
const { uploadFile } = require("./storage");
const pool = require('./db');
const fs = require("fs");
const path = require("path");
const os = require("os");
require("dotenv").config();
const { openai, googleTTSClient, elevenLabsApiKey } = require('./ai-clients');

// ✅ COMPLETE: All 30 Chirp 3 HD Voices
const voiceMap = {
  // OpenAI Voices (Basic)
  Max: { type: "openai", id: "ash" },
  Ashley: { type: "openai", id: "nova" },
  Ava: { type: "openai", id: "coral" },
  Roger: { type: "openai", id: "fable" },
  Lora: { type: "openai", id: "shimmer" },
  
  // ElevenLabs Voices (Premium)
  Cassie: { type: "elevenlabs", id: "56AoDkrOh6qfVPDXZ7Pt" },
  Ryan: { type: "elevenlabs", id: "UgBBYS2sOqTuMpoF3BR0" },
  Rachel: { type: "elevenlabs", id: "zGjIP4SZlMnY9m93k97r" },
  Missy: { type: "elevenlabs", id: "rfkTsdZrVWEVhDycUYn9" },
  Amy: { type: "elevenlabs", id: "WtA85syCrJwasGeHGH2p" },
  Patrick: { type: "elevenlabs", id: "IoYPiP0wwoQzmraBbiju" },
  Andre: { type: "elevenlabs", id: "6OzrBCQf8cjERkYgzSg8" },
  Stan: { type: "elevenlabs", id: "x8xv0H8Ako6Iw3cKXLoC" },
  Lance: { type: "elevenlabs", id: "Fahco4VZzobUeiPqni1S" },
  Alice: { type: "elevenlabs", id: "uYXf8XasLslADfZ2MB4u" },
  
  // ✅ Google Chirp 3 HD Voices
  Liz: { type: "google", voiceId: "Achernar", languageCode: "en-US", gender: "Female" },
  Dave: { type: "google", voiceId: "Algieba", languageCode: "en-US", gender: "Male" },
  Candice: { type: "google", voiceId: "Aoede", languageCode: "en-US", gender: "Female" },
  Autumn: { type: "google", voiceId: "Autonoe", languageCode: "en-US", gender: "Female" },
  Desmond: { type: "google", voiceId: "Charon", languageCode: "en-US", gender: "Male" },
  Charlotte: { type: "google", voiceId: "Despina", languageCode: "en-US", gender: "Female" },
  Ace: { type: "google", voiceId: "Enceladus", languageCode: "en-US", gender: "Male" },
  Liam: { type: "google", voiceId: "Fenrir", languageCode: "en-US", gender: "Male" },
  Keisha: { type: "google", voiceId: "Gacrux", languageCode: "en-US", gender: "Female" },
  Kent: { type: "google", voiceId: "Iapetus", languageCode: "en-US", gender: "Male" },
  Daisy: { type: "google", voiceId: "Kore", languageCode: "en-US", gender: "Female" },
  Lucy: { type: "google", voiceId: "Laomedeia", languageCode: "en-US", gender: "Female" },
  Linda: { type: "google", voiceId: "Leda", languageCode: "en-US", gender: "Female" },
  Jamal: { type: "google", voiceId: "Sadachbia", languageCode: "en-US", gender: "Male" },
  Sydney: { type: "google", voiceId: "Schedar", languageCode: "en-US", gender: "Male" },
  Sally: { type: "google", voiceId: "Sulafat", languageCode: "en-US", gender: "Female" },
  Violet: { type: "google", voiceId: "Vindemiatrix", languageCode: "en-US", gender: "Female" },
  Rhihanon: { type: "google", voiceId: "Zephyr", languageCode: "en-US", gender: "Female" },
  Mark: { type: "google", voiceId: "Zubenelgenubi", languageCode: "en-US", gender: "Male" },
};

// ✅ Generate audio with Google Cloud TTS Chirp 3 HD
async function generateGoogleAudio(text, voiceInfo) {
  if (!googleTTSClient) {
    throw new Error('Google TTS client not initialized. Check credentials.');
  }

  // Format: <locale>-Chirp3-HD-<voice>
  const voiceName = `${voiceInfo.languageCode}-Chirp3-HD-${voiceInfo.voiceId}`;
  
  const request = {
    input: { text: text },
    voice: {
      languageCode: voiceInfo.languageCode,
      name: voiceName
    },
    audioConfig: {
      audioEncoding: 'LINEAR16',
      speakingRate: 1.0,
      pitch: 0,
    },
  };

  console.log(`🎤 Using Chirp 3 HD voice: ${voiceName}`);
  
  const [response] = await googleTTSClient.synthesizeSpeech(request);
  return Buffer.from(response.audioContent);
}

// Generate audio buffer
async function generateSegmentAudio(text, voiceInfo) {
  if (!text || text.trim().length === 0) return null;

  let audioBuffer;
  
  if (voiceInfo.type === "openai") {
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: voiceInfo.id,
      input: text,
    });
    audioBuffer = Buffer.from(await response.arrayBuffer());
    
  } else if (voiceInfo.type === "elevenlabs") {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceInfo.id}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.4, similarity_boost: 0.75 }
      },
      {
        headers: {
          "xi-api-key": elevenLabsApiKey,  // ✅ USE SHARED KEY
          "Content-Type": "application/json"
        },
        responseType: "arraybuffer"
      }
    );
    audioBuffer = Buffer.from(response.data);
    
  } else if (voiceInfo.type === "google") {
    audioBuffer = await generateGoogleAudio(text, voiceInfo);
  }
  
  return audioBuffer;
}

// ---------------------------
// 🔥 FIXED: Get audio duration using temporary file
// ---------------------------
function getAudioDuration(buffer) {
  return new Promise((resolve, reject) => {
    // Create temporary file
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `temp_audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`);
    
    try {
      // Write buffer to temp file
      fs.writeFileSync(tempFile, buffer);
      
      // Use ffprobe on the file
      ffmpeg.ffprobe(tempFile, (err, metadata) => {
        // Clean up temp file
        try {
          fs.unlinkSync(tempFile);
        } catch (cleanupErr) {
          console.warn('Failed to cleanup temp file:', cleanupErr.message);
        }
        
        if (err) {
          reject(err);
        } else {
          const duration = Number(metadata.format.duration) || 0;
          resolve(duration);
        }
      });
    } catch (error) {
      // Clean up temp file on error
      try {
        fs.unlinkSync(tempFile);
      } catch (cleanupErr) {
        // Ignore cleanup errors
      }
      reject(error);
    }
  });
}

// ---------------------------
// 🔥 FIXED: Merge multiple audio buffers using file-based approach
// ---------------------------
function mergeAudioBuffers(buffers) {
  return new Promise((resolve, reject) => {
    if (!buffers || buffers.length === 0) {
      return reject(new Error('No audio buffers to merge'));
    }

    // Handle single buffer case
    if (buffers.length === 1) {
      return resolve(buffers[0]);
    }

    const tempDir = os.tmpdir();
    const tempFiles = [];
    const outputFile = path.join(tempDir, `merged_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`);

    try {
      // Write all buffers to temporary files
      buffers.forEach((buffer, index) => {
        const tempFile = path.join(tempDir, `segment_${Date.now()}_${index}.mp3`);
        fs.writeFileSync(tempFile, buffer);
        tempFiles.push(tempFile);
      });

      // Create ffmpeg command with multiple inputs
      const command = ffmpeg();
      
      // Add all input files
      tempFiles.forEach(file => {
        command.input(file);
      });

      // Build filter complex for concatenation
      const inputs = tempFiles.map((_, i) => `[${i}:a]`).join('');
      const filterComplex = `${inputs}concat=n=${tempFiles.length}:v=0:a=1[out]`;

      command
        .complexFilter(filterComplex)
        .outputOptions('-map', '[out]')
        .format('mp3')
        .output(outputFile)
        .on('end', () => {
          try {
            // Read the merged file
            const mergedBuffer = fs.readFileSync(outputFile);
            
            // Cleanup all temp files
            tempFiles.forEach(file => {
              try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
            });
            try { fs.unlinkSync(outputFile); } catch (e) { /* ignore */ }
            
            resolve(mergedBuffer);
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err) => {
          // Cleanup on error
          tempFiles.forEach(file => {
            try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
          });
          try { fs.unlinkSync(outputFile); } catch (e) { /* ignore */ }
          reject(err);
        })
        .run();

    } catch (error) {
      // Cleanup on immediate error
      tempFiles.forEach(file => {
        try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
      });
      reject(error);
    }
  });
}

// ---------------------------
// Public API - FIXED: Correct function signature and return value
// ---------------------------
async function generateAudio(jobId, voice = null) {
  console.log(`🎙️ [audio-robot] Starting job ${jobId}`);

  // 1. Load job
  const { rows } = await pool.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  if (rows.length === 0) throw new Error(`Job ${jobId} not found`);
  const job = rows[0];

  // FIXED: Parse JSONB properly and use voice parameter
  const segments = job.segments || [];
  if (!segments.length) throw new Error(`Job ${jobId} has no segments`);

  const voiceToUse = voice || job.voice || "Ava";
  const voiceInfo = voiceMap[voiceToUse];
  if (!voiceInfo) throw new Error(`Unknown voice "${voiceToUse}"`);

  const segmentsAudio = [];
  let totalDuration = 0;

  // 2. Loop through segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.text) continue;

    console.log(`🎧 Segment ${i + 1}: "${seg.text.slice(0, 40)}..."`);
    try {
      const buffer = await generateSegmentAudio(seg.text, voiceInfo);
      if (!buffer) continue;

      const duration = await getAudioDuration(buffer);

      // Upload to R2
      const key = `jobs/${jobId}/narration-${i}.mp3`;
      const url = await uploadFile(key, buffer, "audio/mpeg");

      segmentsAudio.push({ index: i, file: url, duration });
      segments[i].audioUrl = url;
      const safeDuration = Number(duration) || 0;
      segments[i].duration = safeDuration;
      totalDuration += safeDuration;

      console.log(`✅ Uploaded narration-${i}.mp3 (${safeDuration.toFixed(2)}s)`);
    } catch (err) {
      console.error(`❌ Error in segment ${i}:`, err.message);
    }
  }

  // 🔥 FIXED: Handle empty segmentsAudio array
  if (segmentsAudio.length === 0) {
    throw new Error('No valid audio segments were generated');
  }

  // 3. Merge into one MP3 (in memory)
  console.log(`🔄 Merging ${segmentsAudio.length} audio segments...`);
  const buffers = await Promise.all(
    segmentsAudio.map(async (seg) => {
      const res = await axios.get(seg.file, { responseType: "arraybuffer" });
      return Buffer.from(res.data);
    })
  );
  
  const mergedBuffer = await mergeAudioBuffers(buffers);

  const mergedKey = `jobs/${jobId}/narration.mp3`;
  const mergedUrl = await uploadFile(mergedKey, mergedBuffer, "audio/mpeg");
  console.log(`🎼 Full narration uploaded to ${mergedUrl} (${totalDuration.toFixed(2)}s total)`);

  // 4. Persist results
  await pool.query(
    "UPDATE jobs SET segments = $1, segments_audio = $2, result_audio = $3 WHERE id = $4",
    [
      JSON.stringify(segments),
      JSON.stringify(segmentsAudio),
      mergedUrl,
      jobId,
    ]
  );

  console.log(`[audio-robot] ✅ Updated DB for job ${jobId}`);
  if (global.gc) {
  global.gc();
  console.log(`🗑️ [audio-robot] GC after job ${jobId}`);
}
  // FIXED: Return only the merged URL to match worker expectations
  return mergedUrl;
}

module.exports = { generateAudio };
