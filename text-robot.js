// text-robot.js - Celebrity Gossip Script Generator
const { openai, genAI } = require('./ai-clients');
const pool = require('./db');
require("dotenv").config();

// ✅ Gemini generation helper
async function generateWithGemini(systemPrompt, userPrompt) {
  try {
    const response = await genAI.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 1.0,
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

// ✅ OpenAI generation helper
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

// ✅ Unified AI generation — Gemini first, OpenAI fallback
async function generateWithAI(systemPrompt, userPrompt) {
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
      throw new Error(
        `AI generation failed: ${geminiError.message} | ${openaiError.message}`
      );
    }
  }
}

// ✅ Build system prompt based on video type and content flow
function buildSystemPrompt(videotype, duration, contentFlow) {
  const isShortForm = videotype === 'shorts' || videotype === 'reels';

  // --- TONE BLOCK (shared) ---
  const toneBlock = `You are a sharp, dramatic celebrity gossip scriptwriter — think TMZ meets E! News meets Hollywood Unlocked.

Your job is to write narration scripts that feel like the host is spilling the hottest tea directly to the viewer.

TONE RULES:
- Dramatic, juicy, and entertaining — keep the viewer hooked every second
- Write like you're telling a friend the most shocking news they've never heard
- Use punchy sentences. Short. Impactful. Then build.
- Add emotional weight — shock, disbelief, excitement, shade
- Never sound like a news anchor. Sound like the most informed person at the party
- Use rhetorical questions to pull viewers in ("But wait — why would she do that?")
- Pepper in light shade and personality without being mean-spirited
- Make every sentence earn its place — no filler, no fluff`;

  // --- FORMAT RULES ---
  const shortFormRules = `FORMAT RULES (Short-Form — ${duration} min):
- Hook the viewer in the FIRST sentence — no warm-up, no introductions
- Every line must create urgency or curiosity for the next
- Think in punchy beats — each sentence lands like a revelation
- Build to a climax then end with a kicker line that leaves them wanting more
- Target word count: approximately ${duration * 130} words
- Write ONLY the spoken narration — no timestamps, no stage directions, no scene labels`;

  const longFormRules = `FORMAT RULES (Long-Form — ${duration} min):
- Open with a strong hook that sets up the drama immediately
- Build the story in layers — context, conflict, revelation, fallout
- Use pacing strategically — slow build then explosive moments
- Include the backstory that makes the drama make sense
- End with a strong opinion or unresolved question that keeps viewers thinking
- Target word count: approximately ${duration * 140} words
- Write ONLY the spoken narration — no timestamps, no stage directions, no scene labels`;

  // --- FLOW-SPECIFIC INSTRUCTIONS ---
  const newsFlowInstructions = `STORY STRUCTURE (Essay/Narrative Style):
- Tell the gossip story from beginning to end like a mini-documentary
- Set the scene, introduce the players, describe what happened, reveal the fallout
- Make it feel like a cohesive story not a list of facts
- Build emotional stakes as the story progresses`;

  const listicleFlowInstructions = `STORY STRUCTURE (Listicle Style):
- Frame the content as a ranked or numbered list (e.g. "Top 5 times they shocked everyone")
- Each list item should feel like its own mini-reveal
- Tease the next item before transitioning ("But number 3 is where things really got messy...")
- The final item should be the biggest or most shocking
- Keep transitions snappy and engaging between items`;

  // --- CRITICAL WRITING RULES ---
  const criticalRules = `CRITICAL WRITING RULES:
- Write ONLY the narration text that will be spoken aloud
- DO NOT include: timestamps, [INTRO], [OUTRO], [SCENE 1], camera directions, or any bracketed labels
- DO NOT start with "Welcome" or "In today's video" or "Hey guys"
- DO NOT end with "Like and subscribe" or any YouTube-style outro
- Start IMMEDIATELY with the hook — drop the viewer straight into the drama

WRONG (never do this):
[INTRO - 0:00]
*dramatic music*
"Welcome back to the channel! Today we're talking about..."

RIGHT (always do this):
She walked into that party knowing exactly what she was doing. And nobody saw what came next.`;

  // --- ASSEMBLE FULL PROMPT ---
  const formatRules = isShortForm ? shortFormRules : longFormRules;
  const flowInstructions = contentFlow === 'listicle' 
    ? listicleFlowInstructions 
    : newsFlowInstructions;

  return `${toneBlock}\n\n${formatRules}\n\n${flowInstructions}\n\n${criticalRules}`;
}

// ✅ Main script generation function
async function generateScript(jobId) {
  const client = await pool.connect();
  try {
    // 1. Fetch job details — include content_flow
    const { rows } = await client.query(
      `SELECT id, user_id, prompt, duration, videotype, content_flow 
       FROM jobs WHERE id = $1`,
      [jobId]
    );

    if (rows.length === 0) {
      throw new Error(`Job ${jobId} not found`);
    }

    const job = rows[0];

    if (!job.prompt) {
      throw new Error('No prompt found for this job');
    }

    const contentFlow = job.content_flow || 'news';

    console.log(
      `> [text-robot] Generating ${contentFlow} gossip script for: "${job.prompt}" ` +
      `(${job.videotype}, ${job.duration} min)`
    );

    // 2. Build prompts
    const systemPrompt = buildSystemPrompt(
      job.videotype,
      job.duration,
      contentFlow
    );

    const userPrompt = contentFlow === 'listicle'
      ? `Write a celebrity gossip listicle script about: ${job.prompt}\n\nMake it dramatic, ranked, and impossible to stop watching.`
      : `Write a celebrity gossip story script about: ${job.prompt}\n\nMake it dramatic, juicy, and impossible to stop listening to.`;

    // 3. Generate script
    const script = await generateWithAI(systemPrompt, userPrompt);

    if (!script) {
      throw new Error('AI returned no script');
    }

    // 4. Save to database
    await client.query(
      'UPDATE jobs SET script = $1 WHERE id = $2',
      [script, jobId]
    );

    console.log(`✔️ Celebrity gossip script generated for job ${jobId} (${script.length} chars)`);

    return { script, userId: job.user_id };

  } catch (err) {
    console.error('🚨 Error in generateScript:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { generateScript };
