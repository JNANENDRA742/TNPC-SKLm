const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema({
    email: { 
        type: String, 
        required: true,
        index: true // Add index for faster queries
    },
    otp: { 
        type: String, 
        required: true 
    },
    attempts: {
        type: Number,
        default: 0
    },
    expiry: { 
        type: Date, 
        required: true 
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 300 // Auto-delete after 5 minutes (300 seconds)
    }
});

// Add compound index for email + OTP queries
otpSchema.index({ email: 1, otp: 1 });

module.exports = mongoose.model("OTP", otpSchema);