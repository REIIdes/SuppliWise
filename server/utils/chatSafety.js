const MAX_MESSAGE_LENGTH = 1000;
const MAX_CONTEXT_ITEMS = 5;
const MAX_HISTORY_ITEMS = 20;
const MAX_HISTORY_CONTENT_LENGTH = 500;
const MAX_REPLY_LENGTH = 20000;

class ChatInputError extends Error {
  constructor(publicMessage) {
    super(publicMessage);
    this.name = 'ChatInputError';
    this.status = 400;
    this.publicMessage = publicMessage;
  }
}

const isPlainObject = (value) => Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value);

const cleanSingleLine = (value, maxLength) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const cleanHistoryText = (value, maxLength) => String(value || '')
  .replace(/\u0000/g, '')
  .trim()
  .slice(0, maxLength);

function validateRecommendationContext(context) {
  if (context === undefined) return;
  if (!Array.isArray(context) || context.length > MAX_CONTEXT_ITEMS) {
    throw new ChatInputError(`Recommendation context must contain at most ${MAX_CONTEXT_ITEMS} items.`);
  }

  for (const item of context) {
    if (!isPlainObject(item)) {
      throw new ChatInputError('Recommendation context contains an invalid item.');
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      throw new ChatInputError('Recommendation names must be text.');
    }
    if (item.priority !== undefined && typeof item.priority !== 'string') {
      throw new ChatInputError('Recommendation priorities must be text.');
    }
    if (item.reason !== undefined && typeof item.reason !== 'string') {
      throw new ChatInputError('Recommendation reasons must be text.');
    }
    if (typeof item.name === 'string' && item.name.length > 240) {
      throw new ChatInputError('Recommendation names are too long.');
    }
    if (typeof item.priority === 'string' && item.priority.length > 80) {
      throw new ChatInputError('Recommendation priorities are too long.');
    }
    if (typeof item.reason === 'string' && item.reason.length > 600) {
      throw new ChatInputError('Recommendation reasons are too long.');
    }
    if (
      item.confidenceScore !== undefined
      && (!Number.isFinite(item.confidenceScore) || item.confidenceScore < 0 || item.confidenceScore > 100)
    ) {
      throw new ChatInputError('Recommendation confidence must be a number from 0 to 100.');
    }
  }
}

function normalizeHistory(history) {
  if (history === undefined) return [];
  if (!Array.isArray(history) || history.length > MAX_HISTORY_ITEMS) {
    throw new ChatInputError(`Chat history must contain at most ${MAX_HISTORY_ITEMS} messages.`);
  }

  return history.flatMap((item) => {
    if (!isPlainObject(item)) {
      throw new ChatInputError('Chat history contains an invalid message.');
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw new ChatInputError('Chat history contains an invalid role.');
    }

    const rawContent = item.text !== undefined ? item.text : item.content;
    if (typeof rawContent !== 'string') {
      throw new ChatInputError('Chat history message text must be text.');
    }

    const content = cleanHistoryText(rawContent, MAX_HISTORY_CONTENT_LENGTH);
    return content ? [{ role: item.role, content }] : [];
  }).slice(-8);
}

function normalizeChatRequest(body) {
  if (!isPlainObject(body)) {
    throw new ChatInputError('Invalid chat request.');
  }

  const { message } = body;
  if (typeof message !== 'string' || !message.trim()) {
    throw new ChatInputError('Please enter a message.');
  }
  const normalizedMessage = message.trim();
  if (normalizedMessage.length > MAX_MESSAGE_LENGTH) {
    throw new ChatInputError(`Please keep messages under ${MAX_MESSAGE_LENGTH} characters.`);
  }

  validateRecommendationContext(body.context);
  const history = normalizeHistory(body.history);

  return { message: normalizedMessage, history };
}

function recommendationDataFromAssessment(assessment) {
  const recommendations = assessment?.aiResults?.recommendations;
  if (!Array.isArray(recommendations)) return [];

  return recommendations.flatMap((item) => {
    if (!isPlainObject(item) || typeof item.name !== 'string') return [];
    const name = cleanSingleLine(item.name, 120);
    if (!name) return [];

    const priority = cleanSingleLine(item.priority || 'Unknown', 40) || 'Unknown';
    const rawConfidence = item.confidenceScore ?? item.confidence;
    const parsedConfidence = typeof rawConfidence === 'number'
      ? rawConfidence
      : (typeof rawConfidence === 'string' && /^\d{1,3}(?:\.\d+)?$/.test(rawConfidence.trim())
        ? Number(rawConfidence)
        : null);
    const confidenceScore = Number.isFinite(parsedConfidence)
      ? Math.min(100, Math.max(0, parsedConfidence))
      : null;
    const reason = typeof item.reason === 'string' ? cleanSingleLine(item.reason, 240) : '';

    return [{
      name,
      priority,
      ...(confidenceScore !== null ? { confidenceScore } : {}),
      ...(reason ? { reason } : {}),
    }];
  }).slice(0, MAX_CONTEXT_ITEMS);
}

function buildRecommendationContext(assessment) {
  const recommendations = recommendationDataFromAssessment(assessment);
  return recommendations.length ? JSON.stringify(recommendations) : null;
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!isPlainObject(part)) return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    return '';
  }).join('');
}

function extractAssistantReply(choice) {
  const contentReply = contentToText(choice?.content).trim();
  const reasoningReply = typeof choice?.reasoning === 'string' ? choice.reasoning.trim() : '';
  return (contentReply || reasoningReply).slice(0, MAX_REPLY_LENGTH);
}

module.exports = {
  ChatInputError,
  MAX_MESSAGE_LENGTH,
  MAX_CONTEXT_ITEMS,
  MAX_HISTORY_ITEMS,
  MAX_HISTORY_CONTENT_LENGTH,
  MAX_REPLY_LENGTH,
  normalizeChatRequest,
  recommendationDataFromAssessment,
  buildRecommendationContext,
  extractAssistantReply,
};
