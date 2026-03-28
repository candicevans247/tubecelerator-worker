// text-processor.js - Celebrity Gossip Segmentation (Image/Video/Mixed aware)
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

// ✅ Unified AI — Gemini first, OpenAI fallback
async function generateWithAI(systemPrompt, userPrompt) {
  try {
    console.log('🤖 Using Gemini 3 Flash for segmentation...');
    return await generateWithGemini(systemPrompt, userPrompt);
  } catch (geminiError) {
    console.warn('⚠️ Gemini failed, falling back to OpenAI:', geminiError.message);
    return await generateWithOpenAI(systemPrompt, userPrompt);
  }
}

// ✅ Extract celebrity names for accurate image/video queries
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

// ✅ Fisher-Yates shuffle for mixed mode assignment
function assignMixedMediaTypes(totalSegments) {
  const videoCount = Math.round(totalSegments * 0.6);
  const imageCount = totalSegments - videoCount;

  const assignments = [
    ...Array(videoCount).fill('video'),
    ...Array(imageCount).fill('image')
  ];

  // Fisher-Yates shuffle
  for (let i = assignments.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [assignments[i], assignments[j]] = [assignments[j], assignments[i]];
  }

  console.log(
    `🎲 Mixed mode: ${videoCount} videos + ${imageCount} images across ${totalSegments} segments`
  );
  return assignments;
}

// ✅ Build the query instruction block based on media type
function buildQueryInstructions(mediaType, celebNames) {
  const nameHint = celebNames.length > 0
    ? `CELEBRITIES IN THIS SCRIPT: ${celebNames.join(', ')}\n` +
      `Always include the specific celebrity name in every query.`
    : `No specific names detected. Use descriptive gossip-relevant queries.`;

  const imageQueryRules = `📸 IMAGE QUERY RULES:
- Write queries as if searching Google Images for a specific celebrity photo
- Include the celebrity's full name when known
- Be specific and visual ("Kim Kardashian SKIMS launch 2023" NOT "businesswoman launch")
- Prioritize: red carpet photos, paparazzi shots, event appearances, social media moments, magazine covers
- Ensure VISUAL DIVERSITY — no two consecutive queries should return the same image
- Never use generic queries like "celebrity photo" or "famous person"`;

  const videoQueryRules = `🎬 VIDEO QUERY RULES:
- Write queries as if searching a stock video library (Pexels) for celebrity footage
- Include the celebrity's full name when known
- Add action/motion context ("Beyoncé walking red carpet footage" NOT "Beyoncé photo")
- Prioritize: event arrival footage, interview clips, performance videos, paparazzi walking shots
- Use words like: "footage", "video", "walking", "interview", "performance", "arriving"
- Ensure VARIETY — different types of footage across segments`;

  if (mediaType === 'images') {
    return `${nameHint}\n\n${imageQueryRules}\n\nReturn each segment with an "imageQuery" field.`;
  }

  if (mediaType === 'videos') {
    return `${nameHint}\n\n${videoQueryRules}\n\nReturn each segment with a "videoQuery" field.`;
  }

  // mixed
  return `${nameHint}\n\n${imageQueryRules}\n\n${videoQueryRules}\n\n` +
    `For MIXED mode: each segment will be pre-assigned as "image" or "video".\n` +
    `Generate the matching query type based on the "mediaType" field you receive per segment.\n` +
    `- If mediaType is "image" → return "imageQuery"\n` +
    `- If mediaType is "video" → return "videoQuery"`;
}

// ✅ Build JSON format instruction based on media type
function buildJsonFormat(mediaType) {
  if (mediaType === 'images') {
    return `[
  {
    "segment": "Exact text from the script.",
    "imageQuery": "Celebrity Name specific photo context"
  }
]`;
  }

  if (mediaType === 'videos') {
    return `[
  {
    "segment": "Exact text from the script.",
    "videoQuery": "Celebrity Name specific video footage context"
  }
]`;
  }

  // mixed — mediaType field included per segment
  return `[
  {
    "segment": "Exact text from the script.",
    "mediaType": "image",
    "imageQuery": "Celebrity Name specific photo context"
  },
  {
    "segment": "Next beat from the script.",
    "mediaType": "video",
    "videoQuery": "Celebrity Name specific video footage context"
  }
]`;
}

// ✅ Main segmentation
async function generateSegmentsWithAI(scriptText, celebNames, mediaType, mixedAssignments) {
  const queryInstructions = buildQueryInstructions(mediaType, celebNames);
  const jsonFormat = buildJsonFormat(mediaType);

  // For mixed mode, tell the AI which segments get which type
  const mixedContext = mediaType === 'mixed' && mixedAssignments
    ? `\nSEGMENT MEDIA ASSIGNMENTS (follow exactly):\n` +
      mixedAssignments.map((type, i) => `Segment ${i + 1}: ${type}`).join('\n') +
      `\n\nMatch each segment to its assigned media type when generating queries.`
    : '';

  const systemPrompt = `You are an expert video editor and celebrity gossip producer splitting narration scripts into visual segments.

This is ALWAYS celebrity gossip content. Every query must reflect that.

${queryInstructions}

🎬 SEGMENTATION RULES (HIGHEST PRIORITY):
1. Split the script into short, punchy narration segments
2. Each segment = ONE clear beat, revelation, or emotional turn
3. Break at moments of drama, shock, shade, or a shift in tone
4. Think cinematically — each segment is a scene cut
5. Create suspense — end segments on a hook that pulls to the next
6. Natural narration pauses = segment breaks
7. DO NOT rewrite, rephrase, or modify any words from the original script
8. ONLY split the existing text at natural break points
${mixedContext}

Return ONLY a JSON array in this exact format (no markdown, no code blocks):
${jsonFormat}`;

  const userPrompt = `Split this celebrity gossip script into segments with ${mediaType === 'mixed' ? 'image and video' : mediaType === 'videos' ? 'video' : 'image'} queries.

Rules:
- Break at emotional beats, revelations, and dramatic turns
- Include celebrity names in every query where possible
- Each query should be visually distinct and relevant
- Do NOT change any words from the script
${mediaType === 'mixed' ? '- Follow the segment media assignments exactly' : ''}

SCRIPT:
${scriptText}`;

  const rawResult = await generateWithAI(systemPrompt, userPrompt);

  // Parse JSON
  let segmentsWithQueries;
  try {
    const cleaned = rawResult
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    segmentsWithQueries = JSON.parse(cleaned);
  } catch (parseError) {
    console.error('❌ Failed to parse JSON response:', parseError.message);
    console.error('Raw response preview:', rawResult.substring(0, 500));
    throw new Error('Invalid JSON response from AI');
  }

  if (!Array.isArray(segmentsWithQueries) || segmentsWithQueries.length === 0) {
    throw new Error('AI returned invalid segment structure');
  }

  // Map to standard format
  return segmentsWithQueries.map((item, index) => {
    const base = {
      text: item.segment || `Segment ${index + 1}`,
      duration: 0,
    };

    if (mediaType === 'images') {
      return {
        ...base,
        imageQuery: item.imageQuery || buildFallbackQuery(celebNames, index, 'image')
      };
    }

    if (mediaType === 'videos') {
      return {
        ...base,
        videoQuery: item.videoQuery || buildFallbackQuery(celebNames, index, 'video')
      };
    }

    // mixed
    const assignedType = item.mediaType || (mixedAssignments?.[index] || 'image');
    return {
      ...base,
      mediaType: assignedType,
      imageQuery: assignedType === 'image'
        ? (item.imageQuery || buildFallbackQuery(celebNames, index, 'image'))
        : null,
      videoQuery: assignedType === 'video'
        ? (item.videoQuery || buildFallbackQuery(celebNames, index, 'video'))
        : null,
    };
  });
}

// ✅ Fallback query builder
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

// ✅ Fallback segmentation
function generateSegmentsFallback(scriptText, celebNames, mediaType, mixedAssignments) {
  console.warn('⚠️ Using fallback segmentation...');

  const sentences = scriptText
    .split(/[.!?]+/)
    .filter(s => s.trim().length > 0);

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

  if (buffer) segments.push({ text: buffer.trim(), duration: 0 });

  return segments.map((seg, index) => {
    if (mediaType === 'images') {
      return { ...seg, imageQuery: buildFallbackQuery(celebNames, index, 'image') };
    }
    if (mediaType === 'videos') {
      return { ...seg, videoQuery: buildFallbackQuery(celebNames, index, 'video') };
    }
    // mixed
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
async function generateSegments(scriptText, mediaType = 'images') {
  console.log(`🚀 Starting celebrity gossip segment generation (media: ${mediaType})...`);

  const celebNames = extractCelebrityNames(scriptText);

  // Pre-assign mixed media types using Fisher-Yates
  // We estimate segment count from word count before AI runs
  let mixedAssignments = null;
  if (mediaType === 'mixed') {
    const estimatedSegments = Math.max(
      3,
      Math.ceil(scriptText.trim().split(/\s+/).length / 25)
    );
    mixedAssignments = assignMixedMediaTypes(estimatedSegments);
    console.log(`🎲 Pre-assigned ${mixedAssignments.length} mixed media slots`);
  }

  try {
    const segments = await generateSegmentsWithAI(
      scriptText, celebNames, mediaType, mixedAssignments
    );

    const validSegments = segments.filter(seg => {
      if (mediaType === 'images') return seg.text && seg.imageQuery;
      if (mediaType === 'videos') return seg.text && seg.videoQuery;
      return seg.text && (seg.imageQuery || seg.videoQuery);
    });

    if (validSegments.length < segments.length) {
      console.warn(`⚠️ ${segments.length - validSegments.length} segment(s) had invalid data, dropped`);
    }

    console.log(`✅ Generated ${validSegments.length} valid segments`);
    return validSegments;

  } catch (aiError) {
    console.error('❌ AI segmentation failed:', aiError.message);
    console.log('🔄 Falling back to basic segmentation...');

    try {
      const fallback = generateSegmentsFallback(
        scriptText, celebNames, mediaType, mixedAssignments
      );
      console.log(`✅ Fallback segmentation successful (${fallback.length} segments)`);
      return fallback;

    } catch (fallbackError) {
      console.error('❌ All segmentation approaches failed:', fallbackError.message);
      const assignedType = mixedAssignments?.[0] || 'image';
      return [{
        text: scriptText.slice(0, 200) + '...',
        duration: 0,
        mediaType: mediaType === 'mixed' ? assignedType : undefined,
        imageQuery: mediaType !== 'videos' ? buildFallbackQuery(celebNames, 0, 'image') : null,
        videoQuery: mediaType !== 'images' ? buildFallbackQuery(celebNames, 0, 'video') : null,
      }];
    }
  }
}

module.exports = { generateSegments };
