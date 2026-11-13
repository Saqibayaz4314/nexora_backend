const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['text', 'image', 'video', 'voice'],
      default: 'text',
    },
    ciphertext: {
      type: String,
      required: true,
    },
    nonce: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    replyTo: {
      messageId: mongoose.Schema.Types.ObjectId,
      senderName: String,
      type: {
        type: String,
        enum: ['text', 'image', 'video', 'voice'],
      },
      ciphertext: String,
      nonce: String,
      authTag: String,
    },
    mediaMeta: {
      duration: Number, // for voice notes, videos (in seconds)
      size: Number,     // file size in bytes
      encryptedThumbUrl: String,
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'seen'],
      default: 'sent',
    },
    edited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
    },
    reactions: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          required: true,
        },
        emoji: {
          type: String, // encrypted/plain emoji representation
          required: true,
        },
        ciphertext_optional: {
          type: String,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Message', MessageSchema);
