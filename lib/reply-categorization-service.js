/**
 * Reply Categorization Service
 *
 * Auto-categorizes prospect replies using keyword matching and patterns.
 * Categories: interested, not_interested, ooo, objection, uncategorized
 */

const REPLY_PATTERNS = {
  interested: {
    keywords: [
      'interested',
      'let\'s talk',
      'set up a call',
      'when can we discuss',
      'love to learn more',
      'looks great',
      'this could work',
      'let\'s connect',
      'would love to',
      'definitely interested',
      'count me in',
      'sounds good',
      'impressive',
      'intrigued',
      'tell me more',
      'call me',
      'book a time',
      'available',
      'next week',
      'tomorrow',
      'this week'
    ],
    confidence: 0.95
  },
  not_interested: {
    keywords: [
      'not interested',
      'not right now',
      'not a fit',
      'not looking',
      'no thanks',
      'not applicable',
      'not relevant',
      'pass',
      'we\'re good',
      'already have',
      'different approach',
      'not at this time',
      'wrong timing',
      'not suitable',
      'not a priority',
      'can\'t help'
    ],
    confidence: 0.90
  },
  ooo: {
    keywords: [
      'out of office',
      'ooo',
      'on vacation',
      'away',
      'return',
      'back on',
      'out until',
      'auto-reply',
      'out of the office',
      'vacation',
      'sick leave',
      'parental leave',
      'sabbatical'
    ],
    confidence: 0.98
  },
  objection: {
    keywords: [
      'budget',
      'cost',
      'too expensive',
      'price too high',
      'we use',
      'already using',
      'competitor',
      'we have something',
      'concern',
      'worried about',
      'how does it compare',
      'integration',
      'doesn\'t integrate',
      'complexity',
      'learning curve',
      'support needed'
    ],
    confidence: 0.80
  }
};

function categorizeReply(replySubject, replyBody) {
  if (!replySubject && !replyBody) {
    return { category: 'uncategorized', confidence: 0 };
  }

  const text = `${replySubject || ''} ${replyBody || ''}`.toLowerCase();
  const scores = {};

  // Score each category based on keyword matches
  for (const [category, { keywords }] of Object.entries(REPLY_PATTERNS)) {
    let matchCount = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        matchCount++;
      }
    }
    scores[category] = matchCount;
  }

  // Find highest scoring category
  let bestCategory = 'uncategorized';
  let bestScore = 0;
  let confidence = 0;

  for (const [category, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
      confidence = Math.min(REPLY_PATTERNS[category].confidence, (score / 5) * 0.95);
    }
  }

  // If no matches found, return uncategorized
  if (bestScore === 0) {
    return { category: 'uncategorized', confidence: 0 };
  }

  return {
    category: bestCategory,
    confidence: Math.round(confidence * 100) / 100
  };
}

module.exports = {
  categorizeReply
};