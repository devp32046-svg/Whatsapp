const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
    taskId: { type: String, required: true, unique: true },
    type: { type: String, enum: ['task', 'meeting'], default: 'task' },
    title: { type: String, required: true },
    details: { type: String, default: '' },
    assigneeName: { type: String, default: '' },       // Team member name
    assigneePhone: { type: String, default: '' },      // Team member phone
    ticketId: { type: String, default: '' },           // Linked ticket if any
    clientName: { type: String, default: '' },         // Related client if any
    clientPhone: { type: String, default: '' },
    dueAt: { type: String, default: '' },              // ISO date string
    priority: { 
        type: String, 
        enum: ['P1', 'P2', 'P3', 'P4'], 
        default: 'P3' 
    },
    status: { 
        type: String, 
        enum: ['open', 'in_progress', 'done', 'cancelled'], 
        default: 'open' 
    },
    createdBy: { type: String, default: 'admin' },
    createdAt: { type: String, default: () => new Date().toISOString() },
    updatedAt: { type: String, default: () => new Date().toISOString() }
}, { collection: 'team_tasks' });

// Index for querying today's tasks
taskSchema.index({ dueAt: 1, status: 1 });
taskSchema.index({ assigneeName: 1, status: 1 });

module.exports = mongoose.model('Task', taskSchema);
