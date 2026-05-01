// text-processor-listicle.js - Celebrity Gossip Listicle Segmentation (Image/Video/Mixed aware)
require("dotenv").config();

const { openai, genAI } = require('./ai-clients');

// ✅ Gemini helper
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

// ✅ OpenAI helper with STREAMING support (handles long responses)
async function generateWithOpenAI(systemPrompt, userPrompt, retryCount = 0) {
  console.warn('⚠️ Using OpenAI as fallback...');
  
  try {
    // ✅ Use streaming to avoid truncation
    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 4096,
      stream: true, // ✅ Enable streaming
    });

    let fullResponse = '';
    let chunkCount = 0;
    
    // Collect all chunks
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      fullResponse += content;
      chunkCount++;
    }
    
    console.log(`✅ Received complete streaming response (${fullResponse.length} chars, ${chunkCount} chunks)`);
    
    // Validate the response is valid JSON
    const cleaned = fullResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    try {
      JSON.parse(cleaned);
      console.log('✅ Streaming response is valid JSON');
      return fullResponse.trim();
    } catch (parseError) {
      console.error('❌ Streaming response is invalid JSON:', parseError.message);
      console.error('Response preview:', cleaned.slice(0, 200) + '...' + cleaned.slice(-200));
      
      // Last resort: try to repair
      if (!cleaned.endsWith(']') && !cleaned.endsWith('}')) {
        console.log('🔧 Attempting to repair incomplete JSON from stream...');
        
        let repaired = cleaned;
        
        // Close any open objects
        const openBraces = (repaired.match(/{/g) || []).length;
        const closeBraces = (repaired.match(/}/g) || []).length;
        
        if (openBraces > closeBraces) {
          repaired += '}'.repeat(openBraces - closeBraces);
        }
        
        // Close array
        if (!repaired.endsWith(']')) {
          repaired += '\n]';
        }
        
        try {
          JSON.parse(repaired);
          console.log('✅ Repaired streaming JSON');
          return repaired;
        } catch (repairError) {
          console.error('❌ Could not repair streaming JSON');
        }
      }
      
      // Retry once if this is first attempt
      if (retryCount < 1) {
        console.warn('🔄 Retrying OpenAI streaming call...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        return generateWithOpenAI(systemPrompt, userPrompt, retryCount + 1);
      }
      
      throw new Error('OpenAI streaming response invalid and repair failed');
    }
    
  } catch (streamError) {
    console.error('❌ OpenAI streaming error:', streamError.message);
    
    // If streaming fails entirely, try non-streaming as last resort
    if (retryCount < 1) {
      console.warn('🔄 Streaming failed, trying non-streaming fallback...');
      
      try {
        const response = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 4096,
          stream: false,
        });
        
        const result = response.choices[0].message.content.trim();
        console.log('✅ Non-streaming fallback successful');
        return result;
        
      } catch (nonStreamError) {
        console.error('❌ Non-streaming fallback also failed:', nonStreamError.message);
      }
    }
    
    throw streamError;
  }
}

// ✅ Unified AI — Gemini first, OpenAI fallback
async function generateWithAI(systemPrompt, userPrompt) {
  try {
    console.log('🤖 Using Gemini 3 Flash for listicle segmentation...');
    return await generateWithGemini(systemPrompt, userPrompt);
  } catch (geminiError) {
    console.error('❌ Gemini failed:', geminiError.message);
    console.log('🔄 Falling back to OpenAI...');
    try {
      const result = await generateWithOpenAI(systemPrompt, userPrompt);
      console.log('✅ OpenAI fallback successful');
      return result;
    } catch (openaiError) {
      throw new Error(
        `Both AI providers failed. Gemini: ${geminiError.message} | OpenAI: ${openaiError.message}`
      );
    }
  }
}

// ✅ Extract celebrity names
function extractCelebrityNames(scriptText) {
  const matches = scriptText.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g
  );
  const names = matches ? [...new Set(matches)] : [];
  console.log(
    `🌟 Detected ${names.length} celebrity name(s): ${names.slice(0, 5).join(', ')}` +
    `${names.length > 5 ? '...' : ''}`
  );
  return names;
}

// ✅ Detect listicle structure
function detectListicleStructure(scriptText) {
  const celebNames = extractCelebrityNames(scriptText);

  const listIndicators = [
    /\b(top\s+\d+|best\s+\d+|worst\s+\d+|\d+\s+best|\d+\s+worst)\b/gi,
    /\b(number\s+\d+|\d+\.|#\d+)\b/gi,
    /\b(first|second|third|fourth|fifth)\b/gi,
    /\b(next\s+up|moving\s+on|up\s+next|coming\s+in\s+at)\b/gi,
    /\b(let's\s+meet|introducing|here\s+are|these\s+are)\b/gi,
    /\b(cast|stars?|actors?|celebrities)\b/gi,
    /\bas\s+[A-Z][a-z]+\b/g,
    /\b(who\s+plays?|portrays?|stars?\s+as)\b/gi,
  ];

  const listScore = listIndicators.reduce(
    (score, pattern) => score + (scriptText.match(pattern) || []).length,
    0
  );

  const isCastBreakdown = celebNames.length > 2 && listScore >= 2;
  const isRankedList = listScore >= 3;

  return { celebNames, isCastBreakdown, isRankedList, listScore };
}

// ✅ Fisher-Yates shuffle for mixed mode
function assignMixedMediaTypes(totalSegments) {
  const videoCount = Math.round(totalSegments * 0.6);
  const imageCount = totalSegments - videoCount;

  const assignments = [
    ...Array(videoCount).fill('video'),
    ...Array(imageCount).fill('image')
  ];

  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }

  console.log(
    `🎲 Mixed listicle: ${videoCount} videos + ${imageCount} images across ${totalSegments} segments`
  );
  return assignments;
}

// ✅ Build fallback query
function buildFallbackQuery(celebNames, index, type) {
  if (celebNames.length === 0) {
    return type === 'video'
      ? 'celebrity paparazzi walking footage'
      : 'celebrity gossip paparazzi photo';
  }
  const name = celebNames[index % celebNames.length];
  return type === 'video'
    ? `${name} paparazzi footage`
    : `${name} photos`;
}

// ✅ Build query instructions based on media type
function buildQueryInstructions(mediaType, celebNames) {
  const nameHint = celebNames.length > 0
    ? `CELEBRITIES: ${celebNames.join(', ')}\nAlways include the specific celebrity name in queries.`
    : `No specific names detected. Use descriptive gossip-relevant queries.`;

  const imageRules = `📸 IMAGE QUERY RULES:
- Search Google Images style queries
- Include celebrity full name + specific context
- Prioritize: red carpet, paparazzi, events, magazine covers, social media moments
- Example: "Zendaya Euphoria premiere red carpet 2022"`;

  const videoRules = `🎬 VIDEO QUERY RULES:
- Search Pexels video style queries
- Include celebrity full name + motion/action context
- Use words like: "footage", "walking", "interview", "performance", "arriving"
- Example: "Zendaya interview footage 2022"`;

  if (mediaType === 'images') return `${nameHint}\n\n${imageRules}\n\nReturn "imageQuery" per segment.`;
  if (mediaType === 'videos') return `${nameHint}\n\n${videoRules}\n\nReturn "videoQuery" per segment.`;
  return `${nameHint}\n\n${imageRules}\n\n${videoRules}\n\nFor MIXED mode:\n- mediaType "image" → return "imageQuery"\n- mediaType "video" → return "videoQuery"`;
}

// ✅ Build JSON format
function buildJsonFormat(mediaType) {
  if (mediaType === 'images') {
    return `[{ "segment": "Exact script text.", "imageQuery": "Celebrity Name context" }]`;
  }
  if (mediaType === 'videos') {
    return `[{ "segment": "Exact script text.", "videoQuery": "Celebrity Name footage context" }]`;
  }
  return `[
  { "segment": "Exact script text.", "mediaType": "image", "imageQuery": "Celebrity Name context" },
  { "segment": "Next beat.", "mediaType": "video", "videoQuery": "Celebrity Name footage context" }
]`;
}

// ✅ UPDATED: Build content type block with BALANCED RULES (matching working processor)
function buildContentTypeBlock(listInfo) {
  const { celebNames, isCastBreakdown, isRankedList } = listInfo;

  const baseRules = `
🎬 CRITICAL SEGMENTATION RULES (BALANCED APPROACH):

1. **LIST NUMBER SEPARATION (MANDATORY)**:
   ❌ WRONG: "Number 1: Caitlin Beadles They met in 2008, before Justin became famous."
   ✅ CORRECT:
   - Segment 1: "Number 1: Caitlin Beadles"
   - Segment 2: "They met in 2008, before Justin became the massive global superstar we know today."
   
   ALWAYS separate the list number/name from the description into different segments.

2. **SEGMENT LENGTH TARGETS**:
   - **Minimum:** 6-8 words per segment (never less than 5 unless it's a list number)
   - **Target:** 10-18 words per segment (sweet spot for pacing)
   - **Maximum:** 25 words per segment
   - **Duration target:** 4-7 seconds of narration per segment

3. **DEFAULT: COMPLETE SENTENCES**:
   - Keep sentences together as single segments by default
   - DO NOT split at every comma
   - Only split long sentences (20+ words) if needed

4. **WHEN TO SPLIT LONG SENTENCES (20+ words)**:
   - Split ONLY if the sentence has a natural break point (comma + conjunction)
   - Split ONLY if BOTH resulting parts would be 8+ words each
   - Look for conjunctions: ", and" ", but" ", which" ", so" ", while"
   
   Example of CORRECT long sentence split:
   Original (32 words): "There's literally footage of Taylor Swift making this disgusted face while watching them kiss at an awards show, which honestly says a lot."
   
   ✅ Split into:
   - Segment 1: "There's literally footage of Taylor Swift making this disgusted face while watching them kiss at an awards show,"
   - Segment 2: "which honestly says a lot."
   
   Example of sentence to KEEP TOGETHER:
   "They met in 2008, before Justin became the massive global superstar we know today." (16 words - keep as one)

5. **SENTENCE GROUPING RULES**:
   - ONLY combine two sentences if BOTH are very short (each under 7 words)
   - Otherwise, keep sentences separate
   
   Examples:
   ✅ COMBINE: "She was his first love. His song was about her." (Both short, 11 words total)
   ❌ DON'T COMBINE: "She was his first love and his very first girlfriend. His hit song 'Never Let You Go' was about her." (Both long)

6. **FORBIDDEN BREAKS**:
   ❌ Breaking sentences under 20 words at commas
   ❌ Creating fragments under 5 words (except list numbers)
   ❌ Splitting mid-sentence without a comma + conjunction
   ❌ Breaking sentences like "Before Justin got married," / "he had been in 21 relationships" (keep together!)

7. **PRESERVE ORIGINAL TEXT**:
   - NEVER modify, rewrite, or add words to the original script
   - ONLY split the existing text at appropriate points
   - Keep all original wording exactly as written`;

  if (isCastBreakdown) {
    return `CONTENT TYPE: CAST BREAKDOWN
This script introduces multiple celebrities one by one.
${baseRules}

8. **GROUPING RULES FOR CAST**:
   - Each person should get 2-4 segments based on natural sentence breaks
   - Group related sentences about the same person together
   - Only start a new segment when introducing a new celebrity OR at a natural sentence break`;
  }

  if (isRankedList) {
    return `CONTENT TYPE: RANKED GOSSIP LIST
This script counts down or ranks celebrity moments, scandals, or events.
${baseRules}

8. **GROUPING RULES FOR RANKED LISTS**:
   - Each list item should get dedicated segment(s)
   - Split the setup and the reveal only if there's a natural sentence break
   - Prefer complete sentences that build suspense over mid-sentence breaks`;
  }

  return `CONTENT TYPE: CELEBRITY GOSSIP LISTICLE
This script covers multiple celebrity topics or moments in sequence.
${baseRules}

8. **GROUPING RULES**:
   - Group related sentences about the same topic together
   - Create suspense through content, not awkward sentence breaks`;
}

// ✅ UPDATED: Main listicle segmentation with BALANCED RULES (matching working processor)
async function processListicleContent(scriptText, listInfo, mediaType, mixedAssignments) {
  const contentTypeBlock = buildContentTypeBlock(listInfo);
  const queryInstructions = buildQueryInstructions(mediaType, listInfo.celebNames);
  const jsonFormat = buildJsonFormat(mediaType);

  const mixedContext = mediaType === 'mixed' && mixedAssignments
    ? `\nSEGMENT MEDIA ASSIGNMENTS (follow exactly):\n` +
      mixedAssignments.map((type, i) => `Segment ${i + 1}: ${type}`).join('\n')
    : '';

  const systemPrompt = `You are an expert celebrity gossip video producer splitting narration scripts into BALANCED visual segments.

This is ALWAYS celebrity gossip content.

${contentTypeBlock}

${queryInstructions}

CRITICAL RULE: Do NOT modify, rewrite, or add any words to the original script. Only split at natural break points and generate queries.
${mixedContext}

CRITICAL EXAMPLES:

✅ CORRECT - Separate list numbers + keep sentences together:
- "Number 1: Caitlin Beadles" (separate segment)
- "They met in 2008, before Justin became the massive global superstar we know today." (ONE segment, 16 words)

❌ WRONG - Over-fragmentation:
- "Before Justin Bieber got married," (fragment, too short)
- "he had been in 21 solid high-profile relationships." (orphaned clause)

✅ CORRECT - Split only very long sentences:
- "There's literally footage of Taylor Swift making this disgusted face while watching them kiss at an awards show," (22 words)
- "which honestly says a lot." (5 words)

Return ONLY a JSON array in this exact format (no markdown, no code blocks):
${jsonFormat}`;

  const userPrompt = `Split this celebrity gossip listicle script into BALANCED segments with ${mediaType === 'mixed' ? 'image and video' : mediaType} queries.

Rules:
- ALWAYS separate list numbers from descriptions (e.g., "Number 1: Name" as one segment, description as next)
- DEFAULT: Keep complete sentences together (under 20 words)
- ONLY split sentences 20+ words at comma + conjunction IF both parts 8+ words
- Target 10-15 words per segment (minimum 6, maximum 25)
- Target 4-7 seconds per segment (not 2-3 seconds)
- Only combine sentences if BOTH are very short (under 7 words each)
- Include celebrity names in every query
- Ensure visual variety across all queries
- Do NOT change any words from the script
${mediaType === 'mixed' ? '- Follow the segment media assignments exactly' : ''}

Key reminders:
✅ "Number 1: Caitlin Beadles" = Separate segment
✅ "They met in 2008, before Justin became famous." = ONE segment (keep together)
❌ "Before Justin got married," + "he had been in 21 relationships." = DON'T split (keep together as one)

SCRIPT:
${scriptText}`;

  const rawResult = await generateWithAI(systemPrompt, userPrompt);

  let segmentsWithQueries;
  try {
    const cleaned = rawResult
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    segmentsWithQueries = JSON.parse(cleaned);
  } catch (parseError) {
    console.error('❌ Failed to parse JSON response:', parseError.message);
    throw new Error('Invalid JSON response from AI');
  }

  if (!Array.isArray(segmentsWithQueries) || segmentsWithQueries.length === 0) {
    throw new Error('AI returned invalid segment structure');
  }

  return segmentsWithQueries.map((item, index) => {
    const base = {
      text: item.segment || `Segment ${index + 1}`,
      duration: 0,
    };

    // Validation: Check word count
    const wordCount = base.text.trim().split(/\s+/).length;
    const isListNumber = /^(Number\s+\d+|#\d+):/i.test(base.text.trim());
    
    if (wordCount < 5 && !isListNumber) {
      console.warn(`⚠️ Segment ${index + 1} is too short (${wordCount} words): "${base.text.substring(0, 50)}..." - May be over-fragmented`);
    }
    if (wordCount > 25) {
      console.warn(`⚠️ Segment ${index + 1} is too long (${wordCount} words): "${base.text.substring(0, 50)}..." - Consider splitting`);
    }

    // Validation: Check for ellipsis fragments
    if (base.text.trim().startsWith('...') || base.text.trim().endsWith('...')) {
      console.warn(`⚠️ Segment ${index + 1} appears to be a fragment: "${base.text.substring(0, 50)}..."`);
    }

    // Validation: Warn about potential over-fragmentation
    if (wordCount >= 5 && wordCount <= 7 && !isListNumber) {
      const endsWithComma = base.text.trim().endsWith(',');
      const startsWithConjunction = /^(and|but|which|so|while|because)\b/i.test(base.text.trim());
      if (endsWithComma || startsWithConjunction) {
        console.warn(`⚠️ Segment ${index + 1} may be an orphaned clause (${wordCount} words): "${base.text.substring(0, 50)}..."`);
      }
    }

    if (mediaType === 'images') {
      return {
        ...base,
        imageQuery: item.imageQuery || buildFallbackQuery(listInfo.celebNames, index, 'image')
      };
    }

    if (mediaType === 'videos') {
      return {
        ...base,
        videoQuery: item.videoQuery || buildFallbackQuery(listInfo.celebNames, index, 'video')
      };
    }

    // mixed
    const assignedType = item.mediaType || mixedAssignments?.[index] || 'image';
    return {
      ...base,
      mediaType: assignedType,
      imageQuery: assignedType === 'image'
        ? (item.imageQuery || buildFallbackQuery(listInfo.celebNames, index, 'image'))
        : null,
      videoQuery: assignedType === 'video'
        ? (item.videoQuery || buildFallbackQuery(listInfo.celebNames, index, 'video'))
        : null,
    };
  });
}

// ✅ UPDATED: Balanced fallback segmentation (matching working processor)
function generateListicleFallback(scriptText, listInfo, mediaType, mixedAssignments) {
  console.warn('⚠️ Using BALANCED listicle fallback segmentation...');

  const { celebNames } = listInfo;
  const sentences = scriptText.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const segments = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    const sentenceWords = sentence.split(/\s+/).length;

    // Check if this is a list number
    const listNumberMatch = sentence.match(/^(Number\s+\d+[:\s]+[A-Z][a-z\s]+?)(?=\s+[A-Z]|$)/i);

    if (listNumberMatch) {
      // Separate list number into its own segment
      segments.push({
        text: listNumberMatch[1].trim(),
        duration: 0
      });

      // Add the rest as a new segment if it exists
      const remainder = sentence.replace(listNumberMatch[1], '').trim();
      if (remainder.length > 0 && remainder.split(/\s+/).length >= 5) {
        segments.push({
          text: remainder,
          duration: 0
        });
      }
    } else if (sentenceWords > 25) {
      // Only split very long sentences (25+ words) at comma
      const commaParts = sentence.split(/,\s+(?=and|but|which|so|while)/);
      if (commaParts.length > 1 && commaParts.every(part => part.split(/\s+/).length >= 8)) {
        // Both parts are substantial, split them
        commaParts.forEach((part, idx) => {
          segments.push({
            text: idx < commaParts.length - 1 ? part.trim() + ',' : part.trim(),
            duration: 0
          });
        });
      } else {
        // Can't split properly, add as is
        segments.push({ text: sentence, duration: 0 });
      }
    } else {
      // Normal sentence (under 25 words), keep together
      segments.push({ text: sentence, duration: 0 });
    }
  }

  return segments.map((seg, index) => {
    if (mediaType === 'images') {
      return { ...seg, imageQuery: buildFallbackQuery(celebNames, index, 'image') };
    }
    if (mediaType === 'videos') {
      return { ...seg, videoQuery: buildFallbackQuery(celebNames, index, 'video') };
    }
    const assignedType = mixedAssignments?.[index] || 'image';
    return {
      ...seg,
      mediaType: assignedType,
      imageQuery: assignedType === 'image' ? buildFallbackQuery(celebNames, index, 'image') : null,
      videoQuery: assignedType === 'video' ? buildFallbackQuery(celebNames, index, 'video') : null,
    };
  });
}

// ✅ Main entry point
async function generateListicleSegments(scriptText, mediaType = 'images') {
  console.log(`🎬 Starting celebrity gossip listicle segmentation with BALANCED pacing (media: ${mediaType})...`);

  const listInfo = detectListicleStructure(scriptText);

  console.log('📊 Listicle analysis:', {
    isCastBreakdown: listInfo.isCastBreakdown,
    isRankedList: listInfo.isRankedList,
    listScore: listInfo.listScore,
    celebrities: listInfo.celebNames.length,
    names: listInfo.celebNames.slice(0, 3),
    mediaType
  });

  // Pre-assign mixed media types
  let mixedAssignments = null;
  if (mediaType === 'mixed') {
    const estimatedSegments = Math.max(
      3,
      Math.ceil(scriptText.trim().split(/\s+/).length / 25)
    );
    mixedAssignments = assignMixedMediaTypes(estimatedSegments);
  }

  try {
    const segments = await processListicleContent(
      scriptText, listInfo, mediaType, mixedAssignments
    );

    const validSegments = segments.filter(seg => {
      if (mediaType === 'images') return seg.text && seg.imageQuery;
      if (mediaType === 'videos') return seg.text && seg.videoQuery;
      return seg.text && (seg.imageQuery || seg.videoQuery);
    });

    console.log(`✅ Generated ${validSegments.length} BALANCED listicle segments with natural pacing`);
    return validSegments;

  } catch (aiError) {
    console.error('❌ Listicle AI segmentation failed:', aiError.message);
    console.log('🔄 Falling back to basic listicle segmentation...');

    try {
      const fallback = generateListicleFallback(
        scriptText, listInfo, mediaType, mixedAssignments
      );
      console.log(`✅ Listicle fallback successful (${fallback.length} segments)`);
      return fallback;

    } catch (fallbackError) {
      console.error('❌ All listicle approaches failed:', fallbackError.message);
      const assignedType = mixedAssignments?.[0] || 'image';
      return [{
        text: scriptText.slice(0, 200) + '...',
        duration: 0,
        mediaType: mediaType === 'mixed' ? assignedType : undefined,
        imageQuery: mediaType !== 'videos' ? buildFallbackQuery(listInfo.celebNames, 0, 'image') : null,
        videoQuery: mediaType !== 'images' ? buildFallbackQuery(listInfo.celebNames, 0, 'video') : null,
      }];
    }
  }
}

module.exports = { generateListicleSegments };
