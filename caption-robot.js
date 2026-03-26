// caption-robot.js - Google Speech-to-Text primary, AssemblyAI fallback
const axios = require('axios');
const pool = require('./db');
const { uploadFile } = require('./storage');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Configuration
const CAPTIONS_SERVICE_URL = process.env.CAPTIONS_SERVICE_URL || 'http://localhost:3000';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const TRANSCRIPTION_PROVIDER = process.env.TRANSCRIPTION_PROVIDER || 'google';

// Available captions.js presets
const AVAILABLE_PRESETS = [
  "Karaoke", "Banger", "Acid", "Lovly", "Marvel", "Marker", "Neon Pulse", 
  "Beasty", "Crazy", "Safari", "Popline", "Desert", "Hook", "Sky", 
  "Flamingo", "Deep Diver B&W", "New", "Catchy", "From", "Classic", 
  "Classic Big", "Old Money", "Cinema", "Midnight Serif", "Aurora Ink"
];

/**
 * Test captions service connectivity
 */
async function testCaptionsService() {
  try {
    console.log(`🔍 Testing captions service at ${CAPTIONS_SERVICE_URL}/health`);
    const response = await axios.get(`${CAPTIONS_SERVICE_URL}/health`, { timeout: 10000 });
    console.log('✅ Captions service is responding:', response.data);
    return true;
  } catch (error) {
    console.error('❌ Captions service test failed:', error.message);
    return false;
  }
}

/**
 * Parse Google's duration format into seconds
 * Handles both string format ("1.500s") and object format ({seconds: "1", nanos: 500000000})
 */
function parseGoogleDuration(duration) {
  if (!duration) return 0;
  
  if (typeof duration === 'string') {
    return parseFloat(duration.replace('s', '')) || 0;
  }
  
  if (typeof duration === 'object') {
    const seconds = parseInt(duration.seconds || '0', 10);
    const nanos = parseInt(duration.nanos || '0', 10);
    return seconds + nanos / 1e9;
  }
  
  return 0;
}

/**
 * 🎯 PRIMARY: Google Cloud Speech-to-Text transcription
 */
async function getGoogleTranscription(audioPath) {
  console.log('🎤 Using Google Cloud Speech-to-Text for transcription (primary)...');
  
  try {
    const audioBuffer = fs.readFileSync(audioPath);
    const audioBase64 = audioBuffer.toString('base64');
    
    const fileSizeMB = audioBuffer.length / (1024 * 1024);
    console.log(`📊 Audio file size: ${fileSizeMB.toFixed(2)} MB`);
    
    if (fileSizeMB > 10) {
      throw new Error(`Audio file too large for inline content (${fileSizeMB.toFixed(1)}MB). Max 10MB supported.`);
    }
    
    // Use longrunningrecognize to support any audio length
    console.log('🔄 Requesting word-level transcription from Google Speech-to-Text...');
    
    const requestBody = {
      config: {
        encoding: 'MP3',
        languageCode: 'en-US',
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true,
        model: 'latest_long',
        useEnhanced: true,
        alternativeLanguageCodes: ['es-US', 'fr-FR', 'de-DE', 'pt-BR']
      },
      audio: {
        content: audioBase64
      }
    };
    
    const response = await axios.post(
      `https://speech.googleapis.com/v1/speech:longrunningrecognize?key=${GOOGLE_API_KEY}`,
      requestBody,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 600000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    const operationName = response.data.name;
    console.log(`⏳ Google Speech operation started: ${operationName}`);
    
    // Poll for completion
    let operationResult;
    let attempts = 0;
    const maxAttempts = 90;
    let delay = 3000;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delay));
      
      const statusResponse = await axios.get(
        `https://speech.googleapis.com/v1/operations/${operationName}?key=${GOOGLE_API_KEY}`,
        { timeout: 15000 }
      );
      
      operationResult = statusResponse.data;
      
      if (operationResult.done) {
        if (operationResult.error) {
          throw new Error(`Google Speech-to-Text error: ${JSON.stringify(operationResult.error)}`);
        }
        console.log('✅ Google Speech-to-Text transcription completed');
        break;
      }
      
      const progress = operationResult.metadata?.progressPercent || 0;
      console.log(`⏳ Google Speech status: processing ${progress}% (attempt ${attempts + 1})`);
      delay = Math.min(delay * 1.2, 10000);
      attempts++;
    }
    
    if (!operationResult || !operationResult.done) {
      throw new Error('Google Speech-to-Text transcription timed out');
    }
    
    // Extract results
    const transcriptResults = operationResult.response?.results || [];
    
    if (transcriptResults.length === 0) {
      throw new Error('Google Speech-to-Text returned no results');
    }
    
    // Combine all result segments
    let fullText = '';
    const words = [];
    let totalConfidence = 0;
    let confidenceCount = 0;
    
    transcriptResults.forEach(result => {
      const alternative = result.alternatives?.[0];
      if (!alternative) return;
      
      fullText += (fullText ? ' ' : '') + alternative.transcript;
      
      if (alternative.confidence) {
        totalConfidence += alternative.confidence;
        confidenceCount++;
      }
      
      if (alternative.words) {
        alternative.words.forEach(wordInfo => {
          const startSeconds = parseGoogleDuration(wordInfo.startTime);
          const endSeconds = parseGoogleDuration(wordInfo.endTime);
          
          words.push({
            text: wordInfo.word,
            start: Math.round(startSeconds * 1000), // Store as milliseconds (matches AssemblyAI format)
            end: Math.round(endSeconds * 1000),
            confidence: alternative.confidence || 0.9
          });
        });
      }
    });
    
    const overallConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0.9;
    const detectedLanguage = transcriptResults[0]?.languageCode || 'en-US';
    
    console.log(`✅ Google Speech-to-Text transcription completed:`);
    console.log(`   - Model: latest_long (enhanced)`);
    console.log(`   - Text length: ${fullText.length} characters`);
    console.log(`   - Word count: ${words.length} words`);
    console.log(`   - Confidence: ${(overallConfidence * 100).toFixed(1)}%`);
    console.log(`   - Language: ${detectedLanguage}`);
    
    return {
      text: fullText,
      words: words,
      confidence: overallConfidence,
      provider: 'google',
      language: detectedLanguage,
      speech_model: 'latest_long_enhanced'
    };
    
  } catch (error) {
    console.error('❌ Google Speech-to-Text transcription failed:', error.message);
    
    if (error.response) {
      console.error('Google API error:', {
        status: error.response.status,
        data: error.response.data
      });
    }
    
    throw error;
  }
}

/**
 * 🔄 FALLBACK: AssemblyAI transcription
 */
async function getAssemblyAITranscription(audioPath) {
  console.log('🎤 Using AssemblyAI for transcription (fallback)...');
  
  try {
    // Step 1: Upload audio file to AssemblyAI
    console.log('📤 Uploading audio to AssemblyAI...');
    const audioBuffer = fs.readFileSync(audioPath);
    
    const uploadResponse = await axios.post(
      'https://api.assemblyai.com/v2/upload',
      audioBuffer,
      {
        headers: {
          'Authorization': ASSEMBLYAI_API_KEY,
          'Content-Type': 'application/octet-stream'
        },
        timeout: 60000
      }
    );
    
    const audioUrl = uploadResponse.data.upload_url;
    console.log('✅ Audio uploaded to AssemblyAI successfully');
    
    // Step 2: Request transcription
    console.log('🔄 Requesting word-level transcription with universal-3-pro model...');
    const transcriptResponse = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      {
        audio_url: audioUrl,
        speech_models: ['universal-3-pro'],
        language_detection: true,
        punctuate: true,
        format_text: true,
        speaker_labels: false,
        auto_highlights: false,
        word_boost: [],
        boost_param: 'default'
      },
      {
        headers: {
          'Authorization': ASSEMBLYAI_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    const transcriptId = transcriptResponse.data.id;
    console.log(`⏳ AssemblyAI transcription job started: ${transcriptId}`);
    
    // Step 3: Poll for completion
    let transcriptResult;
    let attempts = 0;
    const maxAttempts = 60;
    let delay = 3000;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, delay));
      
      const statusResponse = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: { 'Authorization': ASSEMBLYAI_API_KEY },
          timeout: 15000
        }
      );
      
      transcriptResult = statusResponse.data;
      
      if (transcriptResult.status === 'completed') {
        console.log('✅ AssemblyAI transcription completed successfully');
        break;
      } else if (transcriptResult.status === 'error') {
        throw new Error(`AssemblyAI transcription failed: ${transcriptResult.error}`);
      } else if (transcriptResult.status === 'queued' || transcriptResult.status === 'processing') {
        console.log(`⏳ AssemblyAI status: ${transcriptResult.status} (attempt ${attempts + 1})`);
        delay = Math.min(delay * 1.2, 10000);
      }
      
      attempts++;
    }
    
    if (!transcriptResult || transcriptResult.status !== 'completed') {
      throw new Error('AssemblyAI transcription timed out or failed');
    }
    
    console.log(`✅ AssemblyAI transcription completed:`);
    console.log(`   - Models: ${transcriptResult.speech_models || 'universal-3-pro'}`);
    console.log(`   - Text length: ${transcriptResult.text?.length || 0} characters`);
    console.log(`   - Word count: ${transcriptResult.words?.length || 0} words`);
    console.log(`   - Confidence: ${(transcriptResult.confidence * 100).toFixed(1)}%`);
    
    return {
      text: transcriptResult.text,
      words: transcriptResult.words || [],
      confidence: transcriptResult.confidence,
      provider: 'assemblyai',
      language: transcriptResult.language_code,
      audio_duration: transcriptResult.audio_duration,
      speech_model: 'universal-3-pro'
    };
    
  } catch (error) {
    console.error('❌ AssemblyAI transcription failed:', error.message);
    
    if (error.response) {
      console.error('AssemblyAI API error:', {
        status: error.response.status,
        data: error.response.data
      });
    }
    
    throw error;
  }
}

/**
 * Multi-provider transcription: Google (primary) → AssemblyAI (fallback)
 */
async function generateTranscription(audioUrl) {
  console.log(`🎤 Starting transcription with provider: ${TRANSCRIPTION_PROVIDER}`);
  
  const tempDir = path.join(os.tmpdir(), `transcript-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`);
  
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    
    console.log('📥 Downloading audio file...');
    const audioResponse = await axios.get(audioUrl, { 
      responseType: 'stream',
      timeout: 30000 
    });
    
    const audioPath = path.join(tempDir, 'audio.mp3');
    const writer = fs.createWriteStream(audioPath);
    audioResponse.data.pipe(writer);
    
    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
    
    console.log('✅ Audio downloaded successfully');
    
    let transcriptionResult;
    let errors = [];
    
    // Determine provider order
    const isPrimaryGoogle = TRANSCRIPTION_PROVIDER === 'google';
    const primaryProvider = isPrimaryGoogle ? 'google' : 'assemblyai';
    const fallbackProvider = isPrimaryGoogle ? 'assemblyai' : 'google';
    
    // Try primary provider
    try {
      if (primaryProvider === 'google' && GOOGLE_API_KEY) {
        console.log('🎯 Attempting Google Speech-to-Text transcription (primary)...');
        transcriptionResult = await getGoogleTranscription(audioPath);
      } else if (primaryProvider === 'assemblyai' && ASSEMBLYAI_API_KEY) {
        console.log('🎯 Attempting AssemblyAI transcription (primary)...');
        transcriptionResult = await getAssemblyAITranscription(audioPath);
      } else {
        throw new Error(`Primary provider '${primaryProvider}' not configured (missing API key)`);
      }
    } catch (primaryError) {
      console.warn(`⚠️ Primary provider (${primaryProvider}) failed:`, primaryError.message);
      errors.push(`${primaryProvider}: ${primaryError.message}`);
      
      // Try fallback provider
      try {
        if (fallbackProvider === 'assemblyai' && ASSEMBLYAI_API_KEY) {
          console.log('🔄 Falling back to AssemblyAI...');
          transcriptionResult = await getAssemblyAITranscription(audioPath);
        } else if (fallbackProvider === 'google' && GOOGLE_API_KEY) {
          console.log('🔄 Falling back to Google Speech-to-Text...');
          transcriptionResult = await getGoogleTranscription(audioPath);
        } else {
          throw new Error(`Fallback provider '${fallbackProvider}' not configured (missing API key)`);
        }
      } catch (fallbackError) {
        console.error(`❌ Fallback provider (${fallbackProvider}) also failed:`, fallbackError.message);
        errors.push(`${fallbackProvider}: ${fallbackError.message}`);
        throw new Error(`All transcription providers failed: ${errors.join(', ')}`);
      }
    }
    
    if (!transcriptionResult || !transcriptionResult.text) {
      throw new Error('Transcription returned empty result');
    }
    
    console.log(`✅ Transcription completed with ${transcriptionResult.provider}`);
    return transcriptionResult;
    
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

/**
 * Transform multi-provider transcription to captions.js format
 */
function transformToCaptionsJsFormat(transcriptionData, segments) {
  console.log(`🔄 Transforming ${transcriptionData.provider} transcription to captions.js format...`);
  
  if (!transcriptionData.words || transcriptionData.words.length === 0) {
    console.warn('⚠️ No word-level timing available, using segment-based fallback');
    return createSegmentBasedCaptions(transcriptionData.text, segments);
  }
  
  const words = transcriptionData.words;
  const captionsData = [];
  const totalDuration = segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
  
  console.log(`📊 Processing ${words.length} words for ${totalDuration}s duration`);
  
  words.forEach((word, index) => {
    let cleanWord, startTime, endTime, confidence;
    
    if (transcriptionData.provider === 'assemblyai' || transcriptionData.provider === 'google') {
      // Both AssemblyAI and Google store words as { text, start (ms), end (ms) }
      cleanWord = word.text?.trim() || '';
      startTime = (word.start || 0) / 1000; // Convert milliseconds to seconds
      endTime = (word.end || 0) / 1000;
      confidence = word.confidence || 0.9;
    } else {
      cleanWord = word.word?.trim() || '';
      startTime = word.start || 0;
      endTime = word.end || 0;
      confidence = word.confidence || 0.9;
    }
    
    cleanWord = cleanWord.replace(/^[^\w']+/, '');
    
    if (!cleanWord || cleanWord.length === 0) {
      return;
    }
    
    startTime = parseFloat(startTime.toFixed(3));
    endTime = parseFloat(endTime.toFixed(3));
    
    if (startTime < 0) startTime = 0;
    if (endTime > totalDuration) endTime = totalDuration;
    if (endTime <= startTime) endTime = startTime + 0.1;
    
    if (endTime - startTime < 0.05) {
      endTime = startTime + 0.05;
    }
    
    captionsData.push({
      word: cleanWord,
      startTime: startTime,
      endTime: endTime,
      confidence: confidence,
      provider: transcriptionData.provider,
      originalIndex: index
    });
  });
  
  if (captionsData.length === 0) {
    console.warn('⚠️ No valid words after processing, falling back to segment-based');
    return createSegmentBasedCaptions(transcriptionData.text, segments);
  }
  
  const smoothedCaptions = smoothCaptionTiming(captionsData, totalDuration);
  
  console.log(`✅ Transformed ${smoothedCaptions.length} words with ${transcriptionData.provider}`);
  console.log(`📝 Sample captions:`, smoothedCaptions.slice(0, 3));
  
  return smoothedCaptions;
}

/**
 * Smooth caption timing for perfect karaoke highlighting
 */
function smoothCaptionTiming(captionsData, totalDuration) {
  console.log('🔧 Smoothing caption timing for seamless highlighting...');
  
  if (captionsData.length === 0) return captionsData;
  
  captionsData.sort((a, b) => a.startTime - b.startTime);
  
  for (let i = 0; i < captionsData.length; i++) {
    const current = captionsData[i];
    const next = captionsData[i + 1];
    
    const duration = current.endTime - current.startTime;
    if (duration > 3) {
      current.endTime = current.startTime + 1;
    } else if (duration < 0.05) {
      current.endTime = current.startTime + 0.05;
    }
    
    if (next) {
      const gap = next.startTime - current.endTime;
      
      if (gap > 0) {
        current.endTime = next.startTime;
      } else if (gap < 0) {
        const midPoint = (current.endTime + next.startTime) / 2;
        current.endTime = parseFloat(midPoint.toFixed(3));
        next.startTime = parseFloat(midPoint.toFixed(3));
      }
    }
    
    current.startTime = parseFloat(current.startTime.toFixed(3));
    current.endTime = parseFloat(current.endTime.toFixed(3));
  }
  
  if (captionsData.length > 0) {
    const lastWord = captionsData[captionsData.length - 1];
    if (lastWord.endTime > totalDuration) {
      lastWord.endTime = totalDuration;
    }
  }
  
  console.log('✅ Caption timing smoothed for perfect karaoke flow');
  return captionsData;
}

/**
 * Segment-based fallback
 */
function createSegmentBasedCaptions(text, segments) {
  console.log('🎯 Creating segment-based captions (fallback)...');
  
  if (!text || !segments || segments.length === 0) {
    console.error('❌ Missing text or segments for fallback captions');
    return [];
  }
  
  const allWords = text
  .split(/\s+/)          
  .map(w => w.trim())
  .filter(w => w.length > 0)
  .map(w => w.replace(/^[^\w']+/, '')) 
  .filter(w => w.length > 0);
  
  if (allWords.length === 0) {
    console.error('❌ No words found in transcript text');
    return [];
  }
  
  console.log(`📝 Distributing ${allWords.length} words across ${segments.length} segments`);
  
  const captionsData = [];
  const wordsPerSegment = Math.ceil(allWords.length / segments.length);
  let wordIndex = 0;
  let currentTime = 0;
  
  segments.forEach((segment, segIndex) => {
    const segmentDuration = segment.duration || 3;
    const segmentWordCount = Math.min(wordsPerSegment, allWords.length - wordIndex);
    
    if (segmentWordCount <= 0) {
      currentTime += segmentDuration;
      return;
    }
    
    const segmentWords = allWords.slice(wordIndex, wordIndex + segmentWordCount);
    const timePerWord = segmentDuration / segmentWordCount;
    
    segmentWords.forEach((word, wordIndexInSegment) => {
      const startTime = parseFloat((currentTime + (wordIndexInSegment * timePerWord)).toFixed(3));
      const endTime = parseFloat((currentTime + ((wordIndexInSegment + 1) * timePerWord)).toFixed(3));
      
      captionsData.push({
        word: word,
        startTime: startTime,
        endTime: endTime,
        confidence: 0.8,
        provider: 'segment-based',
        segmentIndex: segIndex
      });
    });
    
    wordIndex += segmentWordCount;
    currentTime += segmentDuration;
  });
  
  console.log(`✅ Segment-based captions: ${captionsData.length} words distributed`);
  return captionsData;
}

/**
 * Main function to generate captions for a job
 */
async function generateCaptions(jobId) {
  console.log(`🎬 [caption-robot] Generating captions for job ${jobId} with ${TRANSCRIPTION_PROVIDER}`);
  
  try {
    const { rows } = await pool.query(
      'SELECT result_audio, segments, caption_style FROM jobs WHERE id = $1',
      [jobId]
    );
    
    if (rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }
    
    const job = rows[0];
    
    if (!job.result_audio) {
      throw new Error(`No audio file found for job ${jobId}`);
    }
    
    if (!job.segments || job.segments.length === 0) {
      throw new Error(`No segments found for job ${jobId}`);
    }
    
    const segments = job.segments;
    const totalDuration = segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);
    
    console.log(`📊 Job details: ${totalDuration}s duration, ${segments.length} segments`);
    
    const transcriptionData = await generateTranscription(job.result_audio);
    
    if (!transcriptionData.text) {
      throw new Error('Failed to get transcript text');
    }
    
    console.log(`📝 Transcript preview: "${transcriptionData.text.substring(0, 100)}..."`);
    
    const captionsData = transformToCaptionsJsFormat(transcriptionData, segments);
    
    if (!captionsData || captionsData.length === 0) {
      throw new Error('Failed to generate any caption data');
    }
    
    const finalCaptions = captionsData.map(caption => ({
      word: caption.word,
      startTime: caption.startTime,
      endTime: caption.endTime
    }));
    
    console.log('☁️ Uploading caption data to R2...');
    const captionJson = JSON.stringify(finalCaptions, null, 2);
    const captionKey = `jobs/${jobId}/captions.json`;
    const captionsFileUrl = await uploadFile(captionKey, Buffer.from(captionJson), 'application/json');
    
    const debugData = {
      jobId,
      provider: transcriptionData.provider,
      speechModel: transcriptionData.speech_model,
      wordCount: finalCaptions.length,
      totalDuration,
      confidence: transcriptionData.confidence,
      language: transcriptionData.language,
      firstWord: finalCaptions[0],
      lastWord: finalCaptions[finalCaptions.length - 1],
      timestamp: new Date().toISOString()
    };
    
    const debugKey = `jobs/${jobId}/caption-debug.json`;
    await uploadFile(debugKey, Buffer.from(JSON.stringify(debugData, null, 2)), 'application/json');
    
    console.log(`✅ [caption-robot] Captions generated successfully for job ${jobId}`);
    console.log(`📊 Provider: ${transcriptionData.provider}, Words: ${finalCaptions.length}`);
    
    return {
      transcriptData: transcriptionData,
      captionsFileUrl: captionsFileUrl,
      captionsJsData: finalCaptions,
      provider: transcriptionData.provider,
      confidence: transcriptionData.confidence
    };
    
  } catch (error) {
    console.error(`❌ [caption-robot] Caption generation failed for job ${jobId}:`, error.message);
    throw error;
  }
  finally {
  // ✅ ADD THESE LINES
  if (global.gc) {
    global.gc();
    console.log(`🗑️ [caption-robot] GC after caption burning for job ${jobId}`);
  }
}
}

/**
 * Burn captions onto video using captions.js Docker service
 */
async function burnCaptionsViaService(videoUrl, captionsData, captionStyle, jobId) {
  console.log(`🔥 [caption-robot] Burning captions for job ${jobId} with style: ${captionStyle}`);
  
  try {
    if (!videoUrl || typeof videoUrl !== 'string') {
      throw new Error('Invalid video URL provided');
    }
    
    if (!Array.isArray(captionsData) || captionsData.length === 0) {
      throw new Error('Invalid or empty captions data provided');
    }
    
    if (!captionStyle || !AVAILABLE_PRESETS.includes(captionStyle)) {
      console.warn(`⚠️ Invalid preset '${captionStyle}', using 'Karaoke' as fallback`);
      captionStyle = 'Karaoke';
    }
    
    console.log(`📊 Caption details:`);
    console.log(`   - Words: ${captionsData.length}`);
    console.log(`   - Style: ${captionStyle}`);
    console.log(`   - First: "${captionsData[0]?.word}" (${captionsData[0]?.startTime}s)`);
    
    const validatedCaptions = captionsData
      .filter((caption, index) => {
        if (!caption.word || typeof caption.word !== 'string' || caption.word.trim().length === 0) {
          console.warn(`⚠️ Skipping invalid word at index ${index}:`, caption);
          return false;
        }
        return true;
      })
      .map(caption => ({
        word: caption.word.toString().trim(),
        startTime: Number(caption.startTime) || 0,
        endTime: Number(caption.endTime) || 0.1
      }));
    
    if (validatedCaptions.length === 0) {
      throw new Error('No valid captions after validation');
    }
    
    console.log(`✅ Validated ${validatedCaptions.length}/${captionsData.length} captions`);
    
    const payload = {
      videoUrl: videoUrl,
      captions: validatedCaptions,
      preset: captionStyle,
      jobId: jobId
    };
    
    console.log(`🔥 Calling captions service: ${CAPTIONS_SERVICE_URL}/burn-captions`);
    
    const response = await axios.post(
      `${CAPTIONS_SERVICE_URL}/burn-captions`,
      payload,
      {
        timeout: 1800000,
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    if (!response.data || !response.data.success) {
      throw new Error(`Captions service failed: ${response.data?.error || 'Unknown service error'}`);
    }
    
    const captionedVideoUrl = response.data.videoUrl;
    console.log(`✅ [caption-robot] Captions burned successfully for job ${jobId}`);
    
    return captionedVideoUrl;
    
  } catch (error) {
    console.error(`❌ [caption-robot] Caption burning failed for job ${jobId}:`, error.message);
    
    if (error.response) {
      console.error(`Service error:`, {
        status: error.response.status,
        data: error.response.data
      });
    }
    
    throw error;
  }
  finally {
  // ✅ ADD THESE LINES
  if (global.gc) {
    global.gc();
    console.log(`🗑️ [caption-robot] GC after caption burning for job ${jobId}`);
  }
}
}

module.exports = {
  generateCaptions,
  burnCaptionsViaService,
  testCaptionsService,
  getAvailablePresets: () => [...AVAILABLE_PRESETS],
  isValidPreset: (presetName) => AVAILABLE_PRESETS.includes(presetName)
};
