const mongoose = require('mongoose');

const supplementDetailSchema = new mongoose.Schema(
  {
    // Normalized lowercase key for fast lookup (e.g. "iron bisglycinate")
    nameKey: { type: String, required: true, unique: true, index: true },
    // Original name as returned by AI
    name: { type: String, required: true },
    // Full detail object from Groq
    detail: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SupplementDetail', supplementDetailSchema);
