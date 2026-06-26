// CommentAI — Background Service Worker
// Handles OpenAI API calls (avoids CORS issues from content scripts)
// and manages usage statistics.

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'generateComments') {
    handleGenerateComments(request)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Keep message channel open for async response
  }

  if (request.action === 'incrementStats') {
    incrementStats().then(() => sendResponse({ success: true }));
    return true;
  }

  if (request.action === 'getStats') {
    getStats().then(stats => sendResponse({ success: true, data: stats }));
    return true;
  }
});

// ─── OpenAI API Call ──────────────────────────────────────────────────────────

async function handleGenerateComments({ postText, tone, length, apiKey, model, count }) {
  const numComments = count || 3;

  // ── Micro mode: 3-5 words only, direct insert ──────────────────────────────
  if (length === 'micro') {
    const postSnippet = postText ? postText.slice(0, 1500) : '';

    const microPrompt = postSnippet
      ? `You're a real person scrolling LinkedIn and you want to leave a quick, genuine 3-5 word reaction on this post. It should sound exactly like something a human would casually type — not corporate, not formal, not generic.

Rules:
- Exactly 3 to 5 words. No more.
- No punctuation at the end
- No quotes around the phrase
- Must feel specific to what this post is actually about
- Sounds like a real person typed it fast
- AVOID overused phrases like "This is so true", "Couldn't agree more", "Great post", "Well said"

Good examples (vary your style like these):
"Finally someone said this"
"Been thinking this exactly"
"This hit different today"
"Needed to see this"
"So relevant right now"
"This is pure gold"
"Low key life changing"
"Wow this cuts deep"
"Saving this forever honestly"
"Cannot stop thinking about it"
"Real talk right here"
"This one stings a bit"
"Took the words out"

Post:
---
${postSnippet}
---

Reply with ONLY the 3-5 word phrase. Nothing else.`
      : `You're scrolling LinkedIn and leaving a quick human reaction. Write exactly 3-5 words. Casual, genuine, specific-sounding. No punctuation at end. No quotes. Avoid clichés like "Couldn't agree more". Examples: "Finally someone said this", "This hit different today", "Real talk right here". Reply with ONLY the phrase.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: microPrompt }],
        temperature: 1.05,  // higher = more creative & varied
        max_tokens: 20       // hard cap — 3-5 words max
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `OpenAI API error (${response.status})`);
    }

    const data   = await response.json();
    const phrase = data.choices?.[0]?.message?.content
      ?.trim()
      .replace(/^["'"']|["'"']$/g, '')  // strip surrounding quotes
      .replace(/[.!?,;:]+$/, '');        // strip trailing punctuation
    if (!phrase) throw new Error('Empty response from OpenAI');
    return [phrase];
  }

  // ── Standard mode: 1-3 full comments ──────────────────────────────────────
  const toneDescriptions = {
    professional: 'formal, insightful, and demonstrating industry expertise',
    enthusiastic: 'energetic, positive, and encouraging — genuine excitement',
    thoughtful:   'reflective, nuanced, and analytically deep',
    curious:      'inquisitive, ending with a relevant follow-up question',
    supportive:   'empathetic, warm, and genuinely encouraging',
    concise:      'brief, punchy, and to-the-point — maximum impact with few words'
  };

  const lengthDescriptions = {
    short:  '1 concise sentence (15–30 words)',
    medium: '2–3 sentences (40–80 words)',
    long:   '3–5 sentences (80–130 words)'
  };

  const systemPrompt = `You are a professional LinkedIn engagement specialist. You write authentic, valuable comments that genuinely contribute to discussions. Your comments always sound like they were written by a real, thoughtful professional — never generic, robotic, or AI-generated.`;

  const hasPost = postText && postText.trim().length > 15;
  const userPrompt = `LinkedIn post to comment on:
---
${hasPost ? postText.slice(0, 2500) : '[No post text found — write a general engaging comment]'}
---

Generate exactly ${numComments} distinct comment options.

Requirements:
- Tone: ${toneDescriptions[tone] || toneDescriptions.professional}
- Length: ${lengthDescriptions[length] || lengthDescriptions.medium}
- Each comment must be unique in approach and wording
- Sound genuinely human and natural
- Be SPECIFIC to the post content — reference what was actually said
- No opening phrases like "Great post!", "Interesting read!", or "Absolutely!"
- No hashtags unless highly relevant
- Add real value — insight, experience, perspective, or a thoughtful question

Respond ONLY with valid JSON — no markdown, no explanation:
{"comments": ["comment 1", "comment 2", "comment 3"]}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
      temperature: 0.82,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const msg = errorData?.error?.message || `OpenAI API error (${response.status})`;
    throw new Error(msg);
  }

  const data     = await response.json();
  const content  = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('Empty response from OpenAI');

  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.comments) || parsed.comments.length === 0) {
    throw new Error('Unexpected response format from OpenAI');
  }

  return parsed.comments.slice(0, numComments);
}

// ─── Stats Tracking ───────────────────────────────────────────────────────────

async function incrementStats() {
  const today  = new Date().toDateString();
  const result = await chrome.storage.local.get(['totalComments', 'todayComments', 'lastDate']);
  const isNew  = result.lastDate !== today;

  await chrome.storage.local.set({
    totalComments: (result.totalComments || 0) + 1,
    todayComments: isNew ? 1 : (result.todayComments || 0) + 1,
    lastDate: today
  });
}

async function getStats() {
  const today  = new Date().toDateString();
  const result = await chrome.storage.local.get(['totalComments', 'todayComments', 'lastDate']);
  const isNew  = result.lastDate !== today;

  return {
    total: result.totalComments || 0,
    today: isNew ? 0 : (result.todayComments || 0)
  };
}
