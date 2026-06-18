// ai-clients.js - ALL shared AI/TTS client instances
const OpenAI = require("openai");
const { GoogleGenAI } = require("@google/genai");
const textToSpeech = require('@google-cloud/text-to-speech');
require("dotenv").config();

// ── Text generation clients ───────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI  = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Google Chirp 3 HD TTS client ─────────────
let googleTTSClient = null;
try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    googleTTSClient = new textToSpeech.TextToSpeechClient();
    console.log('✅ Google TTS client initialized (credentials file)');
  } else if (process.env.GOOGLE_TTS_CREDENTIALS) {
    const credentials = JSON.parse(process.env.GOOGLE_TTS_CREDENTIALS);
    googleTTSClient   = new textToSpeech.TextToSpeechClient({ credentials });
    console.log('✅ Google TTS client initialized (env JSON)');
  } else {
    console.warn('⚠️ Google TTS credentials not found. Google voices unavailable.');
  }
} catch (error) {
  console.error('❌ Failed to initialize Google TTS client:', error.message);
}

module.exports = {
  openai,         // text generation only
  genAI,          // text generation only
  googleTTSClient // TTS voice generation
};
