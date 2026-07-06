const mongoose = require('mongoose');

const policyScanSchema = new mongoose.Schema({
    policyNo: { type: String, required: true },
    clientName: { type: String, required: true },
    phoneLast10: { type: String, required: true, index: true },
    scanUrl: { type: String, required: true },          // URL to the scan/document
    scanType: { 
        type: String, 
        enum: ['policy_bond', 'premium_receipt', 'claim_form', 'id_proof', 'other'],
        default: 'policy_bond' 
    },
    fileType: { type: String, default: 'pdf' },         // pdf, jpg, png
    fileSize: { type: Number, default: 0 },             // in bytes
    uploadedBy: { type: String, default: '' },          // admin name or 'client'
    notes: { type: String, default: '' },
    isVerified: { type: Boolean, default: false },
    verifiedBy: { type: String, default: '' }
}, { collection: 'policy_documents', timestamps: true });

// Compound index for quick lookups
policyScanSchema.index({ policyNo: 1, scanType: 1 });
policyScanSchema.index({ phoneLast10: 1 });

module.exports = mongoose.model('PolicyScan', policyScanSchema);
