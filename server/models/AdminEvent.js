const mongoose = require('mongoose');

const adminEventSchema = new mongoose.Schema({
  type: { type: String, enum: ['new-device-login', 'security', 'account'], required: true },
  title: { type: String, required: true },
  detail: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  readBy: { type: [mongoose.Schema.Types.ObjectId], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('AdminEvent', adminEventSchema);
