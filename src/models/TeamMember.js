const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true },
    phoneLast10: { type: String, required: true, index: true },
    role: { 
        type: String, 
        enum: ['owner', 'manager', 'agent', 'support', 'intern', 'ops', 'claims', 'sales'],
        default: 'agent' 
    },
    active: { type: Boolean, default: true },           // Tools Engine uses 'active', not 'isActive'
    email: { type: String, default: '' },
    specializations: [{ type: String }],               // e.g. ['health', 'life', 'motor']
    seedTag: { type: String, default: '' }
}, { collection: 'team_members' });

teamMemberSchema.index({ active: 1, role: 1 });

module.exports = mongoose.model('TeamMember', teamMemberSchema);

