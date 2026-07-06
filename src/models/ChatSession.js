const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    currentState: { type: String, default: 'NEW_USER_WELCOME' },
    lastInteraction: { type: Date, default: Date.now, expires: 86400 } // Auto-delete session after 24 hours (86400 seconds)
});

module.exports = mongoose.model('ChatSession', chatSessionSchema);