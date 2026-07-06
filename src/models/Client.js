const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    name: { type: String, default: 'Guest' },
    profileType: { type: String, enum: ['Salaried', 'Business Owner', 'Unassigned'], default: 'Unassigned' },
    isExistingClient: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('Client', clientSchema);