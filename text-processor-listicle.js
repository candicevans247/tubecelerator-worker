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

// ✅ OpenAI helper
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

// ✅ Build content type block with NATURAL BREAK POINT RULES
function buildContentTypeBlock(listInfo) {
  const { celebNames, isCastBreakdown, isRankedList } = listInfo;

  if (isCastBreakdown) {
    return `CONTENT TYPE: CAST BREAKDOWN
This script introduces multiple celebrities one by one.

🎬 CRITICAL SEGMENTATION RULES (HIGHEST PRIORITY):

1. **NATURAL BREAK POINTS ONLY** - You may ONLY split the script at these locations:
   - End of complete sentences (. ! ?)
   - After commas followed by conjunctions (", and" ", but" ", while" ", so")
   - At paragraph breaks or clear topic transitions
   - When the script introduces a new celebrity
   - At transition phrases ("Next up", "Moving on to", "Coming in at")

2. **NEVER SPLIT MID-SENTENCE** - FORBIDDEN breaks:
   ❌ Breaking a single sentence in the middle without a comma
   ❌ Creating fragments that start with "..." or end with "..."
   ❌ Splitting before words like "before", "after", "when", "while" without a comma
   
   Example of WRONG split:
   ❌ "Robert Townsend and Cheri Jones were married for 11 years..."
   ❌ "...before splitting in 2001."
   
   Example of CORRECT approach:
   ✅ "Robert Townsend and Cheri Jones were married for 11 years before splitting in 2001."

3. **MINIMUM SEGMENT LENGTH** - Each segment MUST have:
   - At least 10-15 words (aim for 12+ words)
   - At least one complete sentence
   - Natural beginning and ending
   - Estimated 3-5 seconds of narration time

4. **GROUPING RULES**:
   - Each person should get 2-4 segments based on natural sentence breaks
   - Group related sentences about the same person together
   - Only start a new segment when introducing a new celebrity OR at a natural sentence break
   - Prefer complete sentences over mid-sentence dramatic breaks

5. **PRESERVE ORIGINAL TEXT**:
   - NEVER modify, rewrite, or add words to the original script
   - ONLY split the existing text at appropriate points
   - Keep all original wording exactly as written`;
  }

  if (isRankedList) {
    return `CONTENT TYPE: RANKED GOSSIP LIST
This script counts down or ranks celebrity moments, scandals, or events.

🎬 CRITICAL SEGMENTATION RULES (HIGHEST PRIORITY):

1. **NATURAL BREAK POINTS ONLY** - You may ONLY split the script at these locations:
   - End of complete sentences (. ! ?)
   - After commas followed by conjunctions (", and" ", but" ", while")
   - At paragraph breaks or clear topic transitions
   - When introducing each new list item/rank
   - At transition phrases ("But number 3...", "Coming in at", "Next up")

2. **NEVER SPLIT MID-SENTENCE** - FORBIDDEN breaks:
   ❌ Breaking a single sentence without a natural pause point
   ❌ Creating fragments that start with "..." or end with "..."
   ❌ Splitting compound sentences at conjunctions without commas

3. **MINIMUM SEGMENT LENGTH** - Each segment MUST have:
   - At least 10-15 words (aim for 12+ words)
   - At least one complete sentence
   - Natural beginning and ending

4. **GROUPING RULES**:
   - Each list item should get dedicated segment(s)
   - Split the setup and the reveal only if there's a natural sentence break
   - Prefer complete sentences that build suspense over mid-sentence breaks

5. **PRESERVE ORIGINAL TEXT**:
   - NEVER modify or rewrite the original script
   - ONLY choose where to split the existing text`;
  }

  return `CONTENT TYPE: CELEBRITY GOSSIP LISTICLE
This script covers multiple celebrity topics or moments in sequence.

🎬 CRITICAL SEGMENTATION RULES (HIGHEST PRIORITY):

1. **NATURAL BREAK POINTS ONLY** - You may ONLY split the script at these locations:
   - End of complete sentences (. ! ?)
   - After commas followed by conjunctions (", and" ", but" ", while")
   - At paragraph breaks or clear topic transitions
   - When the script shifts from one celebrity/topic to another

2. **NEVER SPLIT MID-SENTENCE** - FORBIDDEN breaks:
   ❌ Breaking a single sentence without a natural pause point
   ❌ Creating fragments that start with "..." or end with "..."

3. **MINIMUM SEGMENT LENGTH** - Each segment MUST have:
   - At least 10-15 words (aim for 12+ words)
   - At least one complete sentence

4. **GROUPING RULES**:
   - Group related sentences about the same topic together
   - Create suspense through content, not awkward sentence breaks

5. **PRESERVE ORIGINAL TEXT**:
   - DO NOT rewrite or rephrase any words
   - ONLY split at natural break points`;
}

// ✅ Main listicle segmentation with NATURAL BREAK POINT RULES
async function processListicleContent(scriptText, listInfo, mediaType, mixedAssignments) {
  const contentTypeBlock = buildContentTypeBlock(listInfo);
  const queryInstructions = buildQueryInstructions(mediaType, listInfo.celebNames);
  const jsonFormat = buildJsonFormat(mediaType);

  const mixedContext = mediaType === 'mixed' && mixedAssignments
    ? `\nSEGMENT MEDIA ASSIGNMENTS (follow exactly):\n` +
      mixedAssignments.map((type, i) => `Segment ${i + 1}: ${type}`).join('\n')
    : '';

  const systemPrompt = `You are an expert celebrity gossip video producer splitting narration scripts into visual segments.

This is ALWAYS celebrity gossip content.

${contentTypeBlock}

${queryInstructions}

CRITICAL RULE: Do NOT modify, rewrite, or add any words to the original script. Only split at natural break points and generate queries.
${mixedContext}

Return ONLY a JSON array in this exact format (no markdown, no code blocks):
${jsonFormat}`;

  const userPrompt = `Split this celebrity gossip listicle script into segments with ${mediaType === 'mixed' ? 'image and video' : mediaType} queries.

Rules:
- Only split at sentence endings, commas with conjunctions, or when introducing new people/topics
- NEVER split a single sentence in the middle without a comma
- Each segment must be at least 10-15 words
- Each person or list item gets dedicated segment(s) with natural breaks
- Include celebrity names in every query
- Ensure visual variety across all queries
- Do NOT change any words from the script
${mediaType === 'mixed' ? '- Follow the segment media assignments exactly' : ''}

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
    if (wordCount < 8) {
      console.warn(`⚠️ Segment ${index + 1} is too short (${wordCount} words): "${base.text.substring(0, 50)}..."`);
    }

    // Validation: Check for ellipsis fragments
    if (base.text.trim().startsWith('...') || base.text.trim().endsWith('...')) {
      console.warn(`⚠️ Segment ${index + 1} appears to be a fragment: "${base.text.substring(0, 50)}..."`);
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

// ✅ Fallback segmentation
function generateListicleFallback(scriptText, listInfo, mediaType, mixedAssignments) {
  console.warn('⚠️ Using listicle fallback segmentation...');

  const { celebNames } = listInfo;
  const sentences = scriptText.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const segments = [];
  let current = '';
  let wordCount = 0;

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).length;
    const isNewItem =
      /\b(next\s+up|moving\s+on|number\s+\d+|#\d+)\b/i.test(sentence) ||
      celebNames.some(name => sentence.includes(name.split(' ')[0]));

    if ((wordCount + words > 30 || isNewItem) && current) {
      segments.push({ text: current.trim(), duration: 0 });
      current = sentence.trim();
      wordCount = words;
    } else {
      current += (current ? '. ' : '') + sentence.trim();
      wordCount += words;
    }
  }

  if (current) segments.push({ text: current.trim(), duration: 0 });

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
  console.log(`🎬 Starting celebrity gossip listicle segmentation with natural break points (media: ${mediaType})...`);

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

    console.log(`✅ Generated ${validSegments.length} valid listicle segments with natural pacing`);
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
