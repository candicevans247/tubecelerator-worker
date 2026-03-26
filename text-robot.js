const { openai, genAI } = require('./ai-clients');
const pool = require('./db');
require("dotenv").config();

// ✅ NEW: Gemini 3 generation helper
async function generateWithGemini(systemPrompt, userPrompt) {
  try {
    const response = await genAI.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 1.0, // Gemini 3 recommendation: keep at 1.0
      },
    });
    
    const text = response.text;
    
    if (!text) {
      throw new Error('Gemini returned empty response');
    }
    
    console.log('✅ Gemini 3 Flash generated script successfully');
    return text.trim();
  } catch (error) {
    console.error('❌ Gemini API error:', error.message);
    throw error;
  }
}

// ✅ OpenAI generation helper (unchanged)
async function generateWithOpenAI(systemPrompt, userPrompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 1,
  });
  
  const text = response.choices[0]?.message?.content.trim();
  
  if (!text) {
    throw new Error('OpenAI returned empty response');
  }
  
  return text;
}

// ✅ Unified AI generation with fallback
async function generateWithAI(systemPrompt, userPrompt, preferGemini = true) {
  if (preferGemini) {
    try {
      console.log('🤖 Attempting script generation with Gemini 3 Flash...');
      const result = await generateWithGemini(systemPrompt, userPrompt);
      console.log('✅ Gemini generation successful');
      return result;
    } catch (geminiError) {
      console.warn('⚠️ Gemini failed, falling back to OpenAI:', geminiError.message);
      try {
        const result = await generateWithOpenAI(systemPrompt, userPrompt);
        console.log('✅ OpenAI fallback successful');
        return result;
      } catch (openaiError) {
        console.error('❌ Both Gemini and OpenAI failed');
        throw new Error(`AI generation failed: ${geminiError.message} | ${openaiError.message}`);
      }
    }
  } else {
    // Prefer OpenAI first
    try {
      console.log('🤖 Attempting script generation with OpenAI...');
      const result = await generateWithOpenAI(systemPrompt, userPrompt);
      console.log('✅ OpenAI generation successful');
      return result;
    } catch (openaiError) {
      console.warn('⚠️ OpenAI failed, falling back to Gemini:', openaiError.message);
      try {
        const result = await generateWithGemini(systemPrompt, userPrompt);
        console.log('✅ Gemini fallback successful');
        return result;
      } catch (geminiError) {
        console.error('❌ Both OpenAI and Gemini failed');
        throw new Error(`AI generation failed: ${openaiError.message} | ${geminiError.message}`);
      }
    }
  }
}

/**
 * Generate a script for a given job.
 */
async function generateScript(jobId) {
  const client = await pool.connect();
  try {
    // 1. Fetch job details
    const { rows } = await client.query(
      "SELECT id, user_id, prompt, duration, videotype FROM jobs WHERE id=$1",
      [jobId]
    );

    if (rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = rows[0];
    if (!job.prompt) throw new Error("❌ No prompt found for this job");

    console.log(`> [text-robot] Generating script for: "${job.prompt}"`);

    // 2. Build system prompt
    const systemPrompt =
  job.videotype === "shorts" || job.videotype === "reels"
    ? `You are a professional scriptwriter for short-form video narration (TikTok, YouTube Shorts).

CRITICAL INSTRUCTIONS:
- Write ONLY the narration text that will be spoken by a voice actor
- DO NOT include timestamps, screen directions, scene descriptions, or camera instructions
- DO NOT include [INTRO], [OUTRO], [SCENE 1], or any bracketed text
- DO NOT include "0:00 - 0:15" style timestamps
- Start immediately with engaging content - no introductions
- Write as if you're telling a story directly to the viewer
- Target duration: approximately ${job.duration} minute(s)
- Keep it conversational and engaging

WRONG (DO NOT DO THIS):
[INTRO - 0:00-0:05]
*Camera zooms in*
"Welcome to our video..."

RIGHT (DO THIS):
Stop acting like the mountain in front of you is bigger than the God who made it.

Write ONLY the spoken narration text for this topic:
${job.prompt}`
    : `You are a professional scriptwriter for YouTube video narration.

CRITICAL INSTRUCTIONS:
- Write ONLY the narration text that will be spoken by a voice actor
- DO NOT include timestamps, screen directions, scene descriptions, or camera instructions  
- DO NOT include [INTRO], [OUTRO], [SCENE 1], or any bracketed text
- DO NOT include "0:00 - 0:15" style timestamps
- Write natural, conversational narration
- Target duration: approximately ${job.duration} minute(s)
- Keep it engaging and informative

WRONG (DO NOT DO THIS):
[Scene 1: 0:00-0:30]
*Background music plays*
"In today's video, we'll explore..."

RIGHT (DO THIS):
The human brain is an incredible organ. It processes thousands of thoughts every single day.

Write ONLY the spoken narration text for this topic:
${job.prompt}`;

const userPrompt = `Topic: ${job.prompt}`;

    // 3. ✅ Use new AI generation with Gemini 3 + OpenAI fallback
    const script = await generateWithAI(systemPrompt, userPrompt, true); // true = prefer Gemini

    if (!script) throw new Error("❌ AI returned no script");

    // 4. Save script (but NOT state)
    await client.query("UPDATE jobs SET script=$1 WHERE id=$2", [script, jobId]);

    console.log(`✔️ Draft script generated for job ${jobId}`);

    return { script, userId: job.user_id };
  } catch (err) {
    console.error("🚨 Error in generateScript:", err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { generateScript };
