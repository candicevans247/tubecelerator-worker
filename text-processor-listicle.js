// text-processor-listicle.js - DEDICATED CAST/LISTICLE PROCESSOR
require("dotenv").config();

const { openai, genAI } = require('./ai-clients');
// -------------------
// ✅ NEW: Gemini 3 helper (PRIMARY)
// -------------------
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
    return response.text.trim();
  } catch (error) {
    console.error('❌ Gemini 3 API error:', error.message);
    throw error;
  }
}

// -------------------
// ✅ NEW: OpenAI helper (FALLBACK ONLY)
// -------------------
async function generateWithOpenAI(systemPrompt, userPrompt) {
  console.warn('⚠️ Using OpenAI as fallback...');
  
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
  });
  return response.choices[0].message.content.trim();
}

// -------------------
// ✅ NEW: Unified AI generator - ALWAYS Gemini first
// -------------------
async function generateWithAI(systemPrompt, userPrompt) {
  try {
    console.log('🤖 Using Gemini 3 Flash (PRIMARY) for listicle segmentation...');
    return await generateWithGemini(systemPrompt, userPrompt);
  } catch (geminiError) {
    console.error('❌ Gemini failed:', geminiError.message);
    console.log('🔄 Falling back to OpenAI...');
    
    try {
      const result = await generateWithOpenAI(systemPrompt, userPrompt);
      console.log('✅ OpenAI fallback successful');
      return result;
    } catch (openaiError) {
      console.error('❌ OpenAI fallback also failed:', openaiError.message);
      throw new Error(`Both AI providers failed. Gemini: ${geminiError.message} | OpenAI: ${openaiError.message}`);
    }
  }
}

// -------------------
// Listicle Content Detection 
// -------------------
function detectListicleStructure(scriptText) {
  const celebNames = [];
  const celebMatch = scriptText.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g
  );
  if (celebMatch) celebNames.push(...new Set(celebMatch));

  // Detect list patterns
  const listIndicators = [
    /\b(cast|stars?|actors?|celebrities)\b/gi,
    /\b(top\s+\d+|best\s+\d+|worst\s+\d+|\d+\s+best|\d+\s+worst)\b/gi,
    /\b(let's\s+meet|introducing|here\s+are|these\s+are)\b/gi,
    /\b(first|second|third|fourth|fifth|next\s+up|moving\s+on)\b/gi,
    /\bas\s+[A-Z][a-z]+\b/g, // "as Character" pattern
    /\b(who\s+plays?|portrays?|stars?\s+as)\b/gi,
    /\b(number\s+\d+|\d+\.|#\d+)\b/gi,
  ];

  const transitionPhrases = [
    /\b(next\s+up|moving\s+on\s+to|now\s+let's\s+talk\s+about|up\s+next)\b/gi,
    /\b(another|also|additionally|furthermore)\b/gi,
    /\b(born\s+on|age\s+\d+|years?\s+old)\b/gi,
  ];

  const listScore = listIndicators.reduce((score, pattern) => 
    score + (scriptText.match(pattern) || []).length, 0);
  
  const transitionScore = transitionPhrases.reduce((score, pattern) => 
    score + (scriptText.match(pattern) || []).length, 0);

  // Determine if this is listicle content
  const isListicle = listScore >= 2 || transitionScore >= 3;
  const isCastBreakdown = celebNames.length > 2 && isListicle;

  return {
    celebNames,
    isListicle,
    isCastBreakdown,
    listScore,
    transitionScore
  };
}

// -------------------
// ✅ UPDATED: processListicleContent with new segmentation rules
// -------------------
async function processListicleContent(scriptText, listInfo) {
  try {
    let contentType = 'general listicle';
    let segmentationStrategy = '';
    let imageStrategy = '';

    if (listInfo.isCastBreakdown) {
      contentType = 'cast breakdown';
      segmentationStrategy = `This is a CAST BREAKDOWN script featuring ${listInfo.celebNames.length} celebrities.

SEGMENTATION RULES:
- NEVER modify, rewrite, or add words to the original script
- ONLY split the existing text into segments at natural break points
- Start NEW segments when the script introduces each actor/celebrity 
- Each person should get 2-4 segments based on the existing text structure
- Group related sentences about the same person together
- Look for natural breaks where the script switches to a new actor/celebrity
- Split at existing transition phrases like "Next up", "Moving on to", etc.
- Keep all original wording exactly as written

🎬 PACING & SUSPENSE RULES:
- Break at emotional beats or revelations about each celebrity
- Create suspense by splitting before major reveals
- Each segment should feel complete but leave anticipation for the next
- Prefer shorter, punchier segments for maximum engagement
- Think cinematically - each segment is a scene transition`;

      imageStrategy = `CAST BREAKDOWN IMAGE STRATEGY:
- Each actor needs multiple diverse images (headshots, character photos, red carpet, behind-scenes)
- ALWAYS include the specific actor's name in queries for accuracy
- Focus on: professional headshots, character stills, event photos, candid shots
- Avoid generic "actor photo" - use "ActorName headshot" instead
- Mix individual photos with cast group photos when appropriate`;

    } else if (listInfo.isListicle) {
      contentType = 'structured listicle';
      segmentationStrategy = `This is a LISTICLE/RANKED LIST script.

SEGMENTATION RULES:
- Start NEW segments for each list item or main point
- Each item should get dedicated segment(s) explaining it
- Group related information about the same item together  
- Use clear transitions between different list items
- Keep explanations about the same item together
- Break when moving to the next list item

🎬 PACING & SUSPENSE RULES:
- Build suspense before revealing each list item
- Break at moments of revelation or surprise
- Create anticipation for the next item in the ranking
- Each segment should engage viewer curiosity
- Prefer shorter segments that build momentum`;

      imageStrategy = `LISTICLE IMAGE STRATEGY:
- Each list item needs specific, relevant imagery
- Use descriptive, searchable queries for each topic
- Focus on: item-specific photos, relevant context images, illustrative content
- Make queries specific to avoid generic stock photos
- Consider what viewers need to see for each point`;
    }

    const systemPrompt = `You are an expert at splitting scripts into segments for video content.

CRITICAL RULE: NEVER modify, rewrite, or change ANY words from the original script. Your job is ONLY to split the existing text at appropriate points.

CONTENT TYPE: ${contentType.toUpperCase()}
DETECTED CELEBRITIES: ${listInfo.celebNames.length > 0 ? listInfo.celebNames.slice(0, 5).join(', ') : 'None'}

${segmentationStrategy}

${imageStrategy}

Your task:
1. Split the original script text into segments at natural break points - DO NOT change any words
2. Each segment should be 1-2 sentences from the original script
3. Find where the script naturally transitions between people/topics
4. Generate appropriate image queries for each segment
5. Keep all original text exactly as written

SPLITTING GUIDELINES:
- Look for existing phrases like "Next up", "Moving on", actor introductions
- Split when the script starts talking about a new person
- Group sentences about the same person/topic together
- Use the script's existing structure and transitions
- DO NOT add, remove, or modify any words from the original text
- Break at emotional beats, revelations, or shifts in tone for maximum suspense

CRITICAL RULES:
- For celebrity content: ALWAYS include the celebrity's name in queries ("Gabriel Guevara headshot" not "actor headshot")
- Start new segments for each person/item in the list
- Group related info about the same person/item together
- Create diverse image queries to avoid repetition
- Make queries specific and searchable

Return ONLY a JSON array (no markdown, no code blocks):
[
  {
    "segment": "First segment about item/person 1.",
    "query": "Specific image query with names/details"
  },
  {
    "segment": "More details about item/person 1.",
    "query": "Different specific image query for visual variety"
  },
  {
    "segment": "Introduction to item/person 2.",
    "query": "New specific image query for item/person 2"
  }
]

Remember: This is ${contentType} content, so structure it accordingly with clear breaks between items/people.`;

    const userPrompt = `Create structured ${contentType} segments with image queries for this script:

${scriptText}

Apply the segmentation rules:
- Each person/item gets dedicated segments
- Include celebrity names in image queries
- Ensure visual variety and accurate image matching
- Group related information together per person/item
- Focus on suspense and pacing`;

    // ✅ UPDATED: Use new AI generator (Gemini primary, OpenAI fallback)
    const rawResult = await generateWithAI(systemPrompt, userPrompt);
    
    // Parse JSON response
    let segmentsWithQueries;
    try {
      // Clean the response if it has markdown formatting
      const cleanedResult = rawResult.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      segmentsWithQueries = JSON.parse(cleanedResult);
    } catch (parseError) {
      console.error('❌ Failed to parse JSON response:', parseError.message);
      console.error('Raw response:', rawResult.slice(0, 500));
      throw new Error('Invalid JSON response from AI');
    }

    // Validate response structure
    if (!Array.isArray(segmentsWithQueries) || segmentsWithQueries.length === 0) {
      throw new Error('AI returned invalid segment structure');
    }

    // Convert to standard format
    const segments = segmentsWithQueries.map((item, index) => {
      if (!item.segment || !item.query) {
        console.warn(`⚠️ Segment ${index + 1} missing text or query, using fallback`);
        return {
          text: item.segment || `Segment ${index + 1}`,
          duration: 0,
          mediaQuery: item.query || (listInfo.celebNames.length > 0 
            ? `${listInfo.celebNames[0]} photos`
            : 'relevant content photo')
        };
      }
      
      return {
        text: item.segment,
        duration: 0, // Will be set by audio-robot
        mediaQuery: item.query
      };
    });

    console.log(`✅ Gemini generated ${segments.length} ${contentType} segments with strategic pacing`);
    console.log(`📊 Content analysis: ${listInfo.isCastBreakdown ? 'Cast breakdown' : 'General listicle'} (${listInfo.celebNames.length} celebrities)`);
    
    return segments;

  } catch (error) {
    console.error('❌ Failed to generate listicle segments:', error.message);
    throw error;
  }
}

// -------------------
// FALLBACK: Basic listicle segmentation (unchanged)
// -------------------
async function generateListicleFallback(scriptText, listInfo) {
  console.warn('⚠️ Using listicle fallback segmentation...');
  
  try {
    // Look for common transition words and celebrity names to break segments
    const sentences = scriptText.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const segments = [];
    
    let currentSegment = '';
    let wordCount = 0;
    
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i].trim();
      const sentenceWords = sentence.split(/\s+/).length;
      
      // Check if this sentence starts a new person/item
      const isNewItem = /\b(next\s+up|moving\s+on|now\s+let's|born\s+on|\bas\s+[A-Z])/i.test(sentence) ||
                       listInfo.celebNames.some(name => sentence.includes(name.split(' ')[0]));
      
      if ((wordCount + sentenceWords > 30 || isNewItem) && currentSegment) {
        segments.push({ 
          text: currentSegment.trim(), 
          duration: 0,
          mediaQuery: listInfo.celebNames.length > 0 
            ? `${listInfo.celebNames[0]} photos`
            : 'relevant content photo'
        });
        currentSegment = sentence;
        wordCount = sentenceWords;
      } else {
        currentSegment += (currentSegment ? '. ' : '') + sentence;
        wordCount += sentenceWords;
      }
    }
    
    if (currentSegment) {
      segments.push({ 
        text: currentSegment.trim(), 
        duration: 0,
        mediaQuery: listInfo.celebNames.length > 0 
          ? `${listInfo.celebNames[0]} photos`
          : 'relevant content photo'
      });
    }

    console.log(`✅ Fallback generated ${segments.length} segments`);
    return segments;

  } catch (fallbackError) {
    console.error('❌ Listicle fallback failed:', fallbackError.message);
    
    // Last resort: split by sentences with basic queries
    const basicSegments = scriptText.split(/[.!?]+/)
      .filter(s => s.trim().length > 0)
      .slice(0, 15) // Limit to reasonable number
      .map((text, index) => ({
        text: text.trim(),
        duration: 0,
        mediaQuery: listInfo.celebNames.length > 0 
          ? `${listInfo.celebNames[Math.min(index, listInfo.celebNames.length - 1)]} photos`
          : 'relevant listicle content'
      }));
    
    return basicSegments;
  }
}

// -------------------
// Main entry point (unchanged)
// -------------------
async function generateListicleSegments(scriptText) {
  console.log('🎬 Starting listicle/cast breakdown segment generation (GEMINI PRIMARY)...');
  
  // Step 1: Analyze listicle structure
  const listInfo = detectListicleStructure(scriptText);
  console.log(`📊 Listicle analysis:`, {
    isListicle: listInfo.isListicle,
    isCastBreakdown: listInfo.isCastBreakdown,
    celebrities: listInfo.celebNames.length,
    listScore: listInfo.listScore,
    names: listInfo.celebNames.slice(0, 3)
  });

  try {
    const segments = await processListicleContent(scriptText, listInfo);
    
    // Validation
    const validSegments = segments.filter(seg => seg.text && seg.mediaQuery);
    if (validSegments.length < segments.length) {
      console.warn(`⚠️ ${segments.length - validSegments.length} segments had invalid data`);
    }
    
    console.log(`✅ Successfully generated ${validSegments.length} listicle segments`);
    return validSegments;
    
  } catch (unifiedError) {
    console.error('❌ Listicle AI approach failed:', unifiedError.message);
    console.log('🔄 Falling back to basic listicle approach...');
    
    try {
      const fallbackSegments = await generateListicleFallback(scriptText, listInfo);
      console.log('✅ Listicle fallback approach successful');
      return fallbackSegments;
      
    } catch (fallbackError) {
      console.error('❌ All listicle approaches failed:', fallbackError.message);
      
      // Final fallback
      return [{
        text: scriptText.slice(0, 200) + '...',
        duration: 0,
        mediaQuery: listInfo.celebNames.length > 0 
          ? `${listInfo.celebNames[0]} photos`
          : 'relevant listicle content'
      }];
    }
  }
}

module.exports = { generateListicleSegments };
