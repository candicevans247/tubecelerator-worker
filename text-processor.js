require("dotenv").config();

const { openai, genAI } = require('./ai-clients');

// ✅ NEW: Gemini 3 helper
async function generateWithGemini(systemPrompt, userPrompt) {
  try {
    const response = await genAI.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: userPrompt,
      config: {
        systemInstruction: systemPrompt,
        temperature: 1.0, // Gemini 3 default
      },
    });
    
    return response.text.trim();
  } catch (error) {
    console.error('❌ Gemini 3 API error:', error.message);
    throw error;
  }
}

// ✅ OpenAI helper
async function generateWithOpenAI(systemPrompt, userPrompt) {
  const response = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.7,
  });
  return response.choices[0].message.content.trim();
}

// ✅ Unified AI generation
async function generateWithAI(systemPrompt, userPrompt, preferGemini = true) {
  if (preferGemini) {
    try {
      console.log('🤖 Using Gemini 3 Flash for segmentation...');
      return await generateWithGemini(systemPrompt, userPrompt);
    } catch (geminiError) {
      console.warn('⚠️ Gemini failed, falling back to OpenAI:', geminiError.message);
      return await generateWithOpenAI(systemPrompt, userPrompt);
    }
  } else {
    try {
      console.log('🤖 Using OpenAI for segmentation...');
      return await generateWithOpenAI(systemPrompt, userPrompt);
    } catch (openaiError) {
      console.warn('⚠️ OpenAI failed, falling back to Gemini:', openaiError.message);
      return await generateWithGemini(systemPrompt, userPrompt);
    }
  }
}

// Celebrity Detection (unchanged)
function detectCelebrities(scriptText) {
  const celebNames = [];
  const celebMatch = scriptText.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g
  );
  if (celebMatch) celebNames.push(...new Set(celebMatch));
  const isCelebrityNews = celebNames.length > 0;

  return {
    celebNames,
    isCelebrityNews
  };
}

// ✅ UPDATED: New segmentation with suspense/pacing focus
async function generateSegmentsWithAI(scriptText, celebInfo) {
  try {
    const biasInstruction = celebInfo.isCelebrityNews
      ? `This is a celebrity news script about ${celebInfo.celebNames.join(", ")}.
CRITICAL: When generating image queries, ALWAYS include the specific celebrity's name for accuracy.
Focus on: red carpet appearances, event photos, candid paparazzi shots, social media posts, relationship photos.
Examples: "Gabriel Guevara headshot", "Nicole Wallace red carpet", "Gabriel Guevara Maria Denady couple" - NOT generic "actor photo".`
      : `This is a general news script. Generate visually relevant image queries for each segment.`;

    const systemPrompt = `You are an expert at creating engaging video segments with strategically matched image queries for news/entertainment content.

CELEBRITY DETECTION: ${celebInfo.isCelebrityNews ? 'YES' : 'NO'}
${celebInfo.isCelebrityNews ? `CELEBRITIES FOUND: ${celebInfo.celebNames.join(', ')}` : ''}

INSTRUCTIONS:
${biasInstruction}

🎬 CRITICAL SEGMENTATION RULES (HIGHEST PRIORITY):
1. Break the script into short, natural narration segments
2. Each segment should represent ONE clear idea, beat, or emotional turn
3. Prioritize SUSPENSE and PACING over paragraph length
4. Create segments that build anticipation and keep viewers engaged
5. Break at emotional beats, revelations, cliffhangers, or shifts in tone
6. Think cinematically - each segment should feel like a scene transition
7. Use natural pauses where a narrator would take a breath or create dramatic effect
8. DO NOT REWRITE, REPHRASE, OR MODIFY ANY WORDS FROM THE ORIGINAL SCRIPT.


Your task (do this in ONE response):
1. Split the script following the SUSPENSE and PACING rules above
2. Generate diverse, specific Google image search queries
3. Match each query to the most relevant segment for visual storytelling

SEGMENTATION PRIORITIES:
- Emotional beats > Paragraph structure
- Suspense > Completeness
- Viewer engagement > Grammar rules
- Natural narration flow > Sentence boundaries

Media QUERY RULES:
- Make queries specific and searchable (for Google Images API)
- For celebrity scripts: Include celebrity names for accuracy ("Gabriel Guevara photo" not "actor photo")
- Ensure visual diversity - avoid repetitive queries
- Create queries that will return relevant, high-quality images
- Think about what viewers need to see during each segment

Return ONLY a JSON array in this exact format (no markdown, no code blocks):
[
  {
    "segment": "First beat of the story.",
    "query": "specific searchable image query"
  },
  {
    "segment": "Next emotional turn.",
    "query": "different specific image query"
  }
]`;

    const userPrompt = `Apply the segmentation and image query strategy to this script, focusing on SUSPENSE, PACING, and EMOTIONAL BEATS:

${scriptText}

Remember: 
- Break at emotional beats and revelations for maximum suspense
- Prioritize viewer engagement over traditional paragraph structure
- Each segment should create anticipation for the next
- Generate diverse image queries 
- Match queries strategically to segments
- Include celebrity names in queries when relevant`;

    const rawResult = await generateWithAI(systemPrompt, userPrompt, true);
    
    // Parse JSON response
    let segmentsWithQueries;
    try {
      const cleanedResult = rawResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      segmentsWithQueries = JSON.parse(cleanedResult);
    } catch (parseError) {
      console.error('❌ Failed to parse JSON response:', parseError.message);
      console.error('Raw response:', rawResult.substring(0, 500));
      throw new Error('Invalid JSON response from AI');
    }

    if (!Array.isArray(segmentsWithQueries) || segmentsWithQueries.length === 0) {
      throw new Error('AI returned invalid segment structure');
    }

    // Convert to existing format
    const segments = segmentsWithQueries.map((item, index) => {
      if (!item.segment || !item.query) {
        console.warn(`⚠️ Segment ${index + 1} missing text or query, using fallback`);
        return {
          text: item.segment || `Segment ${index + 1}`,
          duration: 0,
          mediaQuery: item.query || (celebInfo.isCelebrityNews 
            ? `${celebInfo.celebNames[0] || 'celebrity'} photos`
            : 'relevant stock photo')
        };
      }
      
      return {
        text: item.segment,
        duration: 0,
        mediaQuery: item.query
      };
    });

    console.log(`✅ AI generated ${segments.length} segments with strategic pacing and suspense`);
    if (celebInfo.isCelebrityNews) {
      console.log(`📊 Celebrity news detected: ${celebInfo.celebNames.length} celebrities`);
    }
    
    return segments;

  } catch (error) {
    console.error('❌ Failed to generate segments with AI:', error.message);
    throw error;
  }
}

// Fallback (unchanged)
async function generateSegmentsFallback(scriptText, celebInfo) {
  console.warn('⚠️ Using fallback segmentation approach...');
  
  try {
    const sentences = scriptText.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const segments = [];
    
    let buffer = '';
    let wordCount = 0;
    
    for (const sentence of sentences) {
      const sentenceWords = sentence.trim().split(/\s+/).length;
      
      if (wordCount + sentenceWords > 30 && buffer) {
        segments.push({ text: buffer.trim(), duration: 0 });
        buffer = sentence.trim();
        wordCount = sentenceWords;
      } else {
        buffer += (buffer ? '. ' : '') + sentence.trim();
        wordCount += sentenceWords;
      }
    }
    
    if (buffer) {
      segments.push({ text: buffer.trim(), duration: 0 });
    }

    const fallbackQuery = celebInfo.isCelebrityNews 
      ? `${celebInfo.celebNames[0] || 'celebrity'} photos`
      : 'relevant stock photo';
      
    return segments.map(seg => ({
      ...seg,
      mediaQuery: fallbackQuery
    }));

  } catch (fallbackError) {
    console.error('❌ Even fallback failed:', fallbackError.message);
    
    const basicSegments = scriptText.split(/[.!?]+/)
      .filter(s => s.trim().length > 0)
      .slice(0, 10)
      .map((text, index) => ({
        text: text.trim(),
        duration: 0,
        mediaQuery: celebInfo.isCelebrityNews 
          ? `${celebInfo.celebNames[0] || 'celebrity'} photos`
          : 'relevant stock photo'
      }));
    
    return basicSegments;
  }
}

// Main entry point (unchanged)
async function generateSegments(scriptText) {
  console.log('🚀 Starting AI segment generation with suspense/pacing focus...');
  
  const celebInfo = detectCelebrities(scriptText);
  console.log(`📊 Celebrity detection: ${celebInfo.isCelebrityNews ? 'YES' : 'NO'} (${celebInfo.celebNames.length} names found)`);
  if (celebInfo.isCelebrityNews) {
    console.log(`🌟 Celebrities: ${celebInfo.celebNames.slice(0, 5).join(', ')}${celebInfo.celebNames.length > 5 ? '...' : ''}`);
  }

  try {
    const segments = await generateSegmentsWithAI(scriptText, celebInfo);
    
    const validSegments = segments.filter(seg => seg.text && seg.mediaQuery);
    if (validSegments.length < segments.length) {
      console.warn(`⚠️ ${segments.length - validSegments.length} segments had invalid data`);
    }
    
    console.log(`✅ Successfully generated ${validSegments.length} valid segments with emotional pacing`);
    return validSegments;
    
  } catch (unifiedError) {
    console.error('❌ Unified AI approach failed:', unifiedError.message);
    console.log('🔄 Falling back to basic approach...');
    
    try {
      const fallbackSegments = await generateSegmentsFallback(scriptText, celebInfo);
      console.log('✅ Fallback approach successful');
      return fallbackSegments;
      
    } catch (fallbackError) {
      console.error('❌ All approaches failed:', fallbackError.message);
      
      return [{
        text: scriptText.slice(0, 200) + '...',
        duration: 0,
        mediaQuery: celebInfo.isCelebrityNews 
          ? `${celebInfo.celebNames[0] || 'celebrity'} photos`
          : 'relevant stock photo'
      }];
    }
  }
}

module.exports = { generateSegments };
