/**
 * Reply Categorization Service
 *
 * Categorizes prospect replies using AI as the primary method.
 * Keyword matching is used as a fast pre-filter for obvious OOO replies
 * (to save AI cost) and as a fallback when the AI service is unavailable.
 *
 * Categories:
 *   interested       — positive signal, wants to talk
 *   not_interested   — polite rejection
 *   ooo              — out-of-office auto-reply
 *   objection        — has a concern or barrier (budget, timing, competitor)
 *   question         — asking for more info without committing
 *   uncategorized    — cannot determine intent
 */

// Fast keyword pre-filter — only for OOO detection (very high confidence signals)
const OOO_SIGNALS = [
  'out of office', 'out-of-office', 'ooo', 'on vacation', 'on holiday',
  'sick leave', 'parental leave', 'sabbatical', 'auto-reply', 'automatic reply',
  'away from the office', 'away from my desk', 'not in the office',
  'will return', 'back on', 'back in the office', 'i\'m out until', 'out until'
];

/**
 * Quick keyword-based OOO detection to avoid unnecessary AI calls.
 * Returns true only when we're very confident this is an OOO auto-reply.
 */
function isObviousOOO(subject, body) {
  const text = `${subject || ''} ${body || ''}`.toLowerCase();
  let matches = 0;
  for (const signal of OOO_SIGNALS) {
    if (text.includes(signal)) matches++;
    if (matches >= 2) return true; // Two signals = very high confidence
  }
  return false;
}

/**
 * AI-powered reply categorization.
 * Uses Haiku (fast, cheap) — already mapped in TASK_MODEL_MAP.
 *
 * @param {object} ai - AIService instance
 * @param {string} subject - Reply subject line
 * @param {string} body - Reply body text
 * @param {object} context - { userId, prospectName, companyName }
 * @returns {object} { category, confidence, sentiment, return_date, key_concern, summary }
 */
async function categorizeWithAI(ai, subject, body, context = {}) {
  const result = await ai.callJSON('reply_categorization', {
    system: `You are a B2B sales reply analyst. Categorize the prospect's reply to a cold outreach email.

Categories:
- "interested": Positive signal — wants to learn more, schedule a call, or proceed
- "not_interested": Clear rejection — not interested, wrong person, not needed
- "ooo": Out-of-office auto-reply
- "objection": Has a specific concern (budget, timing, competitor, complexity)
- "question": Asking for more info without committing either way
- "uncategorized": Cannot determine intent from the text

Return JSON: {
  "category": "interested|not_interested|ooo|objection|question|uncategorized",
  "confidence": number 0.0-1.0,
  "sentiment": "positive|negative|neutral",
  "summary": "one-sentence summary of reply intent",
  "key_concern": "string or null (main objection/question if present)",
  "return_date": "YYYY-MM-DD or null (if OOO and return date mentioned)",
  "suggested_action": "book_call|follow_up_later|respond_to_objection|send_info|archive|schedule_on_return"
}`,
    messages: [{
      role: 'user',
      content: [
        context.companyName ? `Prospect company: ${context.companyName}` : '',
        context.prospectName ? `Prospect name: ${context.prospectName}` : '',
        `Subject: ${subject || '(no subject)'}`,
        `Reply body:\n${(body || '').slice(0, 2000)}`
      ].filter(Boolean).join('\n')
    }]
  }, { userId: context.userId, skipCache: false });

  return result.content;
}

/**
 * Keyword-based fallback categorization.
 * Used when AI service is unavailable.
 */
const KEYWORD_PATTERNS = {
  interested: {
    keywords: [
      'interested', 'let\'s talk', 'set up a call', 'love to learn more',
      'sounds good', 'tell me more', 'book a time', 'available next week',
      'intrigued', 'count me in', 'would love to connect', 'let\'s connect'
    ],
    confidence: 0.75
  },
  not_interested: {
    keywords: [
      'not interested', 'not right now', 'not a fit', 'no thanks',
      'we\'re good', 'already have a solution', 'not looking', 'not applicable',
      'please remove me', 'unsubscribe', 'stop emailing'
    ],
    confidence: 0.80
  },
  ooo: {
    keywords: OOO_SIGNALS,
    confidence: 0.95
  },
  objection: {
    keywords: [
      'budget', 'too expensive', 'price', 'already using', 'we use',
      'competitor', 'concern', 'worried', 'not the right time', 'timing'
    ],
    confidence: 0.70
  },
  question: {
    keywords: [
      'how does', 'can you explain', 'what is', 'do you support',
      'does it integrate', 'tell me more about', 'what\'s the pricing',
      'how much does'
    ],
    confidence: 0.65
  }
};

function keywordFallback(subject, body) {
  const text = `${subject || ''} ${body || ''}`.toLowerCase();
  const scores = {};

  for (const [category, { keywords }] of Object.entries(KEYWORD_PATTERNS)) {
    let matchCount = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) matchCount++;
    }
    scores[category] = matchCount;
  }

  let bestCategory = 'uncategorized';
  let bestScore = 0;

  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (bestScore === 0) {
    return { category: 'uncategorized', confidence: 0, sentiment: 'neutral', summary: null };
  }

  const baseConf = KEYWORD_PATTERNS[bestCategory]?.confidence || 0.5;
  return {
    category: bestCategory,
    confidence: Math.min(baseConf, Math.round((bestScore / 3) * baseConf * 100) / 100),
    sentiment: bestCategory === 'interested' ? 'positive' : bestCategory === 'not_interested' ? 'negative' : 'neutral',
    summary: null,
    key_concern: null,
    return_date: null,
    suggested_action: null
  };
}

/**
 * Main entry point.
 *
 * @param {string} subject - Reply subject
 * @param {string} body - Reply body
 * @param {object} options - { ai, userId, prospectName, companyName }
 * @returns {object} Categorization result
 */
async function categorizeReply(subject, body, options = {}) {
  // Fast path: OOO detection skips AI call entirely
  if (isObviousOOO(subject, body)) {
    return {
      category: 'ooo',
      confidence: 0.97,
      sentiment: 'neutral',
      summary: 'Out-of-office auto-reply',
      key_concern: null,
      return_date: extractReturnDate(body),
      suggested_action: 'schedule_on_return'
    };
  }

  // Primary path: AI categorization
  if (options.ai) {
    try {
      const result = await categorizeWithAI(options.ai, subject, body, {
        userId: options.userId,
        prospectName: options.prospectName,
        companyName: options.companyName
      });

      if (result && result.category) {
        return result;
      }
    } catch (err) {
      console.warn('[Categorization] AI categorization failed, using keyword fallback:', err.message);
    }
  }

  // Fallback: keyword matching
  return keywordFallback(subject, body);
}

/**
 * Extract a return date from OOO message body.
 * Returns ISO date string or null.
 */
function extractReturnDate(body) {
  if (!body) return null;
  // Match common patterns: "back on January 15", "return January 15, 2026", "back 01/15"
  const patterns = [
    /(?:back|return(?:ing)?|available|in the office)(?:\s+on)?\s+(\w+\s+\d{1,2}(?:,\s*\d{4})?)/i,
    /(?:out until|away until|returning)\s+(\w+\s+\d{1,2}(?:,\s*\d{4})?)/i,
    /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/
  ];

  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match) {
      try {
        const parsed = new Date(match[1]);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString().slice(0, 10);
        }
      } catch {
        // Continue to next pattern
      }
    }
  }
  return null;
}

module.exports = {
  categorizeReply,
  isObviousOOO,
  extractReturnDate,
  // Export for backward compatibility with any direct keyword callers
  categorizeReplyKeyword: (subject, body) => keywordFallback(subject, body)
};
