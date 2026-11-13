const mongoose = require('mongoose');

const PairingTokenSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // Auto delete document when expiresAt passes
  },
  used: {
    type: Boolean,
    default: false,
  },
});

module.exports = mongoose.model('PairingToken', PairingTokenSchema);
