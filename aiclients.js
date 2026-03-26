// ai-clients.js - ALL shared AI/TTS client instances
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const textToSpeech = require('@google-cloud/text-to-speech');
require("dotenv").config();

// Text generation clients
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Google TTS client (voice generation)
let googleTTSClient = null;
try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    googleTTSClient = new textToSpeech.TextToSpeechClient();
    console.log('✅ Google TTS client initialized (credentials file)');
  } else if (process.env.GOOGLE_TTS_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);
    googleTTSClient = new textToSpeech.TextToSpeechClient({ credentials });
    console.log('✅ Google TTS client initialized (env JSON)');
  } else {
    console.warn('⚠️ Google TTS credentials not found. Google voices unavailable.');
  }
} catch (error) {
  console.error('❌ Failed to initialize Google TTS client:', error.message);
}

// ElevenLabs doesn't have an SDK client — it's just axios calls with an API key
// So we just export the key availability check
const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || null;
if (!elevenLabsApiKey) {
  console.warn('⚠️ ELEVENLABS_API_KEY not found. ElevenLabs voices unavailable.');
}

module.exports = {
  openai,
  genAI,
  googleTTSClient,
  elevenLabsApiKey
};
