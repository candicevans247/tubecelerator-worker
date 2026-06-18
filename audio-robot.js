// audio-robot.js
const ffmpeg = require("fluent-ffmpeg");
const axios  = require("axios");
const { uploadFile }      = require("./storage");
const pool                = require('./db');
const fs                  = require("fs");
const path                = require("path");
const os                  = require("os");
require("dotenv").config();
const { googleTTSClient } = require('./ai-clients');

// ─────────────────────────────────────────────
// DashScope config
// ─────────────────────────────────────────────
const DASHSCOPE_API_KEY   = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_WORKSPACE = process.env.DASHSCOPE_WORKSPACE_ID;
const DASHSCOPE_BASE_URL  = `https://${DASHSCOPE_WORKSPACE}.ap-southeast-1.maas.aliyuncs.com/api/v1`;

const QWEN_MODEL_STANDARD = "qwen3-tts-flash";          // no instructions
const QWEN_MODEL_INSTRUCT = "qwen3-tts-instruct-flash"; // with instructions

// ─────────────────────────────────────────────
// Voices that support qwen3-tts-instruct-flash
// All others fall back to qwen3-tts-flash
// even if a style instruction is provided
// ─────────────────────────────────────────────
const QWEN_INSTRUCT_SUPPORTED = new Set([
  'Cherry', 'Serena', 'Ethan', 'Chelsie', 'Momo', 'Vivian',
  'Moon', 'Maia', 'Kai', 'Nofish', 'Bella', 'EldricSage',
  'Mia', 'Mochi', 'Bellona', 'Vincent', 'Bunny', 'Neil',
  'Elias', 'Arthur', 'Nini', 'Seren', 'Pip', 'Stella',
]);

// ─────────────────────────────────────────────
// Voice Map
// ─────────────────────────────────────────────
const voiceMap = {
  // ── Google Chirp 3 HD Voices ───────────────
  Liz:       { type: "google", voiceId: "Achernar",      languageCode: "en-US" },
  Dave:      { type: "google", voiceId: "Algieba",       languageCode: "en-US" },
  Candice:   { type: "google", voiceId: "Aoede",         languageCode: "en-US" },
  Autumn:    { type: "google", voiceId: "Autonoe",       languageCode: "en-US" },
  Desmond:   { type: "google", voiceId: "Charon",        languageCode: "en-US" },
  Charlotte: { type: "google", voiceId: "Despina",       languageCode: "en-US" },
  Ace:       { type: "google", voiceId: "Enceladus",     languageCode: "en-US" },
  Liam:      { type: "google", voiceId: "Fenrir",        languageCode: "en-US" },
  Keisha:    { type: "google", voiceId: "Gacrux",        languageCode: "en-US" },
  Kent:      { type: "google", voiceId: "Iapetus",       languageCode: "en-US" },
  Daisy:     { type: "google", voiceId: "Kore",          languageCode: "en-US" },
  Lucy:      { type: "google", voiceId: "Laomedeia",     languageCode: "en-US" },
  Linda:     { type: "google", voiceId: "Leda",          languageCode: "en-US" },
  Jamal:     { type: "google", voiceId: "Sadachbia",     languageCode: "en-US" },
  Sydney:    { type: "google", voiceId: "Schedar",       languageCode: "en-US" },
  Sally:     { type: "google", voiceId: "Sulafat",       languageCode: "en-US" },
  Violet:    { type: "google", voiceId: "Vindemiatrix",  languageCode: "en-US" },
  Rhihanon:  { type: "google", voiceId: "Zephyr",        languageCode: "en-US" },
  Mark:      { type: "google", voiceId: "Zubenelgenubi", languageCode: "en-US" },

  // ── Qwen3-TTS Voices (DashScope) ───────────
  // Instruct-compatible female
  Cherry:   { type: "qwen", voice: "Cherry"  },
  Serena:   { type: "qwen", voice: "Serena"  },
  Chelsie:  { type: "qwen", voice: "Chelsie" },
  Momo:     { type: "qwen", voice: "Momo"    },
  Vivian:   { type: "qwen", voice: "Vivian"  },
  Maia:     { type: "qwen", voice: "Maia"    },
  Bella:    { type: "qwen", voice: "Bella"   },
  Mia:      { type: "qwen", voice: "Mia"     },
  Bellona:  { type: "qwen", voice: "Bellona" },
  Bunny:    { type: "qwen", voice: "Bunny"   },
  Elias:    { type: "qwen", voice: "Elias"   },
  Nini:     { type: "qwen", voice: "Nini"    },
  Seren:    { type: "qwen", voice: "Seren"   },
  Stella:   { type: "qwen", voice: "Stella"  },
  // Instruct-compatible male
  Ethan:      { type: "qwen", voice: "Ethan"       },
  Moon:       { type: "qwen", voice: "Moon"         },
  Kai:        { type: "qwen", voice: "Kai"          },
  Nofish:     { type: "qwen", voice: "Nofish"       },
  EldricSage: { type: "qwen", voice: "Eldric Sage"  },
  Mochi:      { type: "qwen", voice: "Mochi"        },
  Vincent:    { type: "qwen", voice: "Vincent"      },
  Neil:       { type: "qwen", voice: "Neil"         },
  Arthur:     { type: "qwen", voice: "Arthur"       },
  Pip:        { type: "qwen", voice: "Pip"          },
  // Flash-only female
  Jennifer: { type: "qwen", voice: "Jennifer" },
  Katerina: { type: "qwen", voice: "Katerina" },
  Sonrisa:  { type: "qwen", voice: "Sonrisa"  },
  Sohee:    { type: "qwen", voice: "Sohee"    },
  OnoAnna:  { type: "qwen", voice: "Ono Anna" },
  // Flash-only male
  QwenRyan:  { type: "qwen", voice: "Ryan"      },
  Aiden:     { type: "qwen", voice: "Aiden"     },
  Bodega:    { type: "qwen", voice: "Bodega"    },
  Alek:      { type: "qwen", voice: "Alek"      },
  Dolce:     { type: "qwen", voice: "Dolce"     },
  Lenn:      { type: "qwen", voice: "Lenn"      },
  Emilien:   { type: "qwen", voice: "Emilien"   },
  QwenAndre: { type: "qwen", voice: "Andre"     },
  RadioGol:  { type: "qwen", voice: "Radio Gol" },
  // Dialect
  Dylan:  { type: "qwen", voice: "Dylan"  },
  Eric:   { type: "qwen", voice: "Eric"   },
  Jada:   { type: "qwen", voice: "Jada"   },
  Li:     { type: "qwen", voice: "Li"     },
  Marcus: { type: "qwen", voice: "Marcus" },
  Roy:    { type: "qwen", voice: "Roy"    },
  Peter:  { type: "qwen", voice: "Peter"  },
  Sunny:  { type: "qwen", voice: "Sunny"  },
  Rocky:  { type: "qwen", voice: "Rocky"  },
  Kiki:   { type: "qwen", voice: "Kiki"   },
};

// ─────────────────────────────────────────────
// Google Chirp 3 HD helper
// ─────────────────────────────────────────────
async function generateGoogleAudio(text, voiceInfo) {
  if (!googleTTSClient) {
    throw new Error('Google TTS client not initialized. Check credentials.');
  }
  const voiceName = `${voiceInfo.languageCode}-Chirp3-HD-${voiceInfo.voiceId}`;
  const request = {
    input: { text },
    voice: { languageCode: voiceInfo.languageCode, name: voiceName },
    audioConfig: { audioEncoding: 'LINEAR16', speakingRate: 1.0, pitch: 0 },
  };
  console.log(`🎤 Google Chirp 3 HD: ${voiceName}`);
  const [response] = await googleTTSClient.synthesizeSpeech(request);
  return Buffer.from(response.audioContent);
}

// ─────────────────────────────────────────────
// DashScope Qwen3-TTS helper
// Dynamically picks model based on whether a
// style instruction is present AND the voice
// supports the instruct model
// ─────────────────────────────────────────────
async function generateQwenAudio(text, voiceInfo, styleInstruction = null) {
  if (!DASHSCOPE_API_KEY) {
    throw new Error('DASHSCOPE_API_KEY is not set in environment variables');
  }
  if (!DASHSCOPE_WORKSPACE) {
    throw new Error('DASHSCOPE_WORKSPACE_ID is not set in environment variables');
  }

  const hasInstruction      = styleInstruction && styleInstruction.trim().length > 0;
  const voiceSupportsInstruct = QWEN_INSTRUCT_SUPPORTED.has(voiceInfo.voice);
  const useInstructModel    = hasInstruction && voiceSupportsInstruct;

  if (hasInstruction && !voiceSupportsInstruct) {
    console.warn(
      `⚠️ Voice "${voiceInfo.voice}" does not support qwen3-tts-instruct-flash. ` +
      `Falling back to qwen3-tts-flash and ignoring style instruction.`
    );
  }

  const model = useInstructModel ? QWEN_MODEL_INSTRUCT : QWEN_MODEL_STANDARD;

  console.log(
    `🤖 Qwen3-TTS | model: ${model} | voice: ${voiceInfo.voice}` +
    (useInstructModel
      ? ` | instruction: "${styleInstruction.slice(0, 60)}..."`
      : hasInstruction
        ? ` | instruction ignored (voice not supported)`
        : ` | no instruction`)
  );

  const input = {
    text,
    voice:         voiceInfo.voice,
    language_type: "English",
  };

  if (useInstructModel) {
    input.instructions           = styleInstruction.trim();
    input.optimize_instructions  = true;
  }

  const body     = { model, input };
  const endpoint = `${DASHSCOPE_BASE_URL}/services/aigc/multimodal-generation/generation`;

  let response;
  try {
    response = await axios.post(endpoint, body, {
      headers: {
        "Authorization": `Bearer ${DASHSCOPE_API_KEY}`,
        "Content-Type":  "application/json",
      },
      timeout: 90000,
    });
  } catch (err) {
    const detail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    throw new Error(`DashScope TTS request failed: ${detail}`);
  }

  const audioObj = response.data?.output?.audio;
  if (!audioObj?.url) {
    throw new Error(
      `DashScope TTS returned no audio URL. Response: ${JSON.stringify(response.data)}`
    );
  }

  console.log(`📥 Qwen3-TTS audio ready (expires 24h): ${audioObj.url}`);

  const wavResponse = await axios.get(audioObj.url, {
    responseType: "arraybuffer",
    timeout:      60000,
  });
  const wavBuffer = Buffer.from(wavResponse.data);

  console.log(`🔄 Converting WAV → MP3...`);
  return await convertWavToMp3(wavBuffer);
}

// ─────────────────────────────────────────────
// WAV → MP3 conversion helper
// ─────────────────────────────────────────────
function convertWavToMp3(wavBuffer) {
  return new Promise((resolve, reject) => {
    const tempDir = os.tmpdir();
    const uid     = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const wavFile = path.join(tempDir, `qwen_in_${uid}.wav`);
    const mp3File = path.join(tempDir, `qwen_out_${uid}.mp3`);

    try {
      fs.writeFileSync(wavFile, wavBuffer);

      ffmpeg(wavFile)
        .toFormat("mp3")
        .audioCodec("libmp3lame")
        .audioQuality(2)
        .output(mp3File)
        .on("end", () => {
          try {
            const mp3Buffer = fs.readFileSync(mp3File);
            fs.unlinkSync(wavFile);
            fs.unlinkSync(mp3File);
            resolve(mp3Buffer);
          } catch (err) {
            reject(err);
          }
        })
        .on("error", (err) => {
          try { fs.unlinkSync(wavFile); } catch (_) {}
          try { fs.unlinkSync(mp3File); } catch (_) {}
          reject(err);
        })
        .run();
    } catch (err) {
      try { fs.unlinkSync(wavFile); } catch (_) {}
      reject(err);
    }
  });
}

// ─────────────────────────────────────────────
// Unified segment audio generator
// ─────────────────────────────────────────────
async function generateSegmentAudio(text, voiceInfo, styleInstruction = null) {
  if (!text || text.trim().length === 0) return null;

  if (voiceInfo.type === "google") {
    return await generateGoogleAudio(text, voiceInfo);

  } else if (voiceInfo.type === "qwen") {
    return await generateQwenAudio(text, voiceInfo, styleInstruction);
  }

  throw new Error(`Unknown voice type: ${voiceInfo.type}`);
}

// ─────────────────────────────────────────────
// Get audio duration
// ─────────────────────────────────────────────
function getAudioDuration(buffer) {
  return new Promise((resolve, reject) => {
    const tempDir  = os.tmpdir();
    const tempFile = path.join(
      tempDir,
      `temp_audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`
    );
    try {
      fs.writeFileSync(tempFile, buffer);
      ffmpeg.ffprobe(tempFile, (err, metadata) => {
        try { fs.unlinkSync(tempFile); } catch (_) {}
        if (err) return reject(err);
        resolve(Number(metadata.format.duration) || 0);
      });
    } catch (error) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
      reject(error);
    }
  });
}

// ─────────────────────────────────────────────
// Merge audio buffers
// ─────────────────────────────────────────────
function mergeAudioBuffers(buffers) {
  return new Promise((resolve, reject) => {
    if (!buffers || buffers.length === 0) {
      return reject(new Error('No audio buffers to merge'));
    }
    if (buffers.length === 1) return resolve(buffers[0]);

    const tempDir    = os.tmpdir();
    const tempFiles  = [];
    const outputFile = path.join(
      tempDir,
      `merged_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`
    );

    try {
      buffers.forEach((buffer, index) => {
        const tempFile = path.join(tempDir, `segment_${Date.now()}_${index}.mp3`);
        fs.writeFileSync(tempFile, buffer);
        tempFiles.push(tempFile);
      });

      const command       = ffmpeg();
      tempFiles.forEach(file => command.input(file));

      const inputs        = tempFiles.map((_, i) => `[${i}:a]`).join('');
      const filterComplex = `${inputs}concat=n=${tempFiles.length}:v=0:a=1[out]`;

      command
        .complexFilter(filterComplex)
        .outputOptions('-map', '[out]')
        .format('mp3')
        .output(outputFile)
        .on('end', () => {
          try {
            const mergedBuffer = fs.readFileSync(outputFile);
            tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
            try { fs.unlinkSync(outputFile); } catch (_) {}
            resolve(mergedBuffer);
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (err) => {
          tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
          try { fs.unlinkSync(outputFile); } catch (_) {}
          reject(err);
        })
        .run();
    } catch (error) {
      tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
      reject(error);
    }
  });
}

// ─────────────────────────────────────────────
// Main public API
// ─────────────────────────────────────────────
async function generateAudio(jobId, voice = null) {
  console.log(`🎙️ [audio-robot] Starting job ${jobId}`);

  // 1. Load job
  const { rows } = await pool.query("SELECT * FROM jobs WHERE id = $1", [jobId]);
  if (rows.length === 0) throw new Error(`Job ${jobId} not found`);
  const job = rows[0];

  const segments = job.segments || [];
  if (!segments.length) throw new Error(`Job ${jobId} has no segments`);

  const voiceToUse = voice || job.voice || "Cherry";
  const voiceInfo  = voiceMap[voiceToUse];
  if (!voiceInfo) throw new Error(`Unknown voice "${voiceToUse}"`);

  const styleInstruction = job.qwen_style_instruction || null;

  console.log(
    `🎤 Voice: ${voiceToUse} | Provider: ${voiceInfo.type}` +
    (voiceInfo.voice ? ` | DashScope voice: ${voiceInfo.voice}` : '') +
    (styleInstruction ? ` | Style: "${styleInstruction.slice(0, 50)}..."` : '')
  );

  const segmentsAudio = [];
  let   totalDuration = 0;

  // 2. Loop through segments
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.text) continue;

    console.log(`🎧 Segment ${i + 1}/${segments.length}: "${seg.text.slice(0, 40)}..."`);

    try {
      const buffer = await generateSegmentAudio(seg.text, voiceInfo, styleInstruction);
      if (!buffer) continue;

      const duration = await getAudioDuration(buffer);

      const key = `jobs/${jobId}/narration-${i}.mp3`;
      const url = await uploadFile(key, buffer, "audio/mpeg");

      segmentsAudio.push({ index: i, file: url, duration });
      segments[i].audioUrl = url;
      segments[i].duration = Number(duration) || 0;
      totalDuration       += segments[i].duration;

      console.log(`✅ Uploaded narration-${i}.mp3 (${segments[i].duration.toFixed(2)}s)`);
    } catch (err) {
      console.error(`❌ Error in segment ${i}:`, err.message);
    }
  }

  if (segmentsAudio.length === 0) {
    throw new Error('No valid audio segments were generated');
  }

  // 3. Merge into one MP3
  console.log(`🔄 Merging ${segmentsAudio.length} audio segments...`);
  const buffers = await Promise.all(
    segmentsAudio.map(async (seg) => {
      const res = await axios.get(seg.file, { responseType: "arraybuffer" });
      return Buffer.from(res.data);
    })
  );

  const mergedBuffer = await mergeAudioBuffers(buffers);
  const mergedKey    = `jobs/${jobId}/narration.mp3`;
  const mergedUrl    = await uploadFile(mergedKey, mergedBuffer, "audio/mpeg");

  console.log(`🎼 Full narration uploaded: ${mergedUrl} (${totalDuration.toFixed(2)}s total)`);

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

  console.log(`[audio-robot] ✅ DB updated for job ${jobId}`);

  if (global.gc) {
    global.gc();
    console.log(`🗑️ [audio-robot] GC after job ${jobId}`);
  }

  return mergedUrl;
}

module.exports = { generateAudio };
