const mongoose = require('mongoose');

const assessmentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Step 1 - Basic Information
    age: { type: Number },
    gender: { type: String, enum: ['Male', 'Female'] },
    weight: { type: Number },
    height: { type: Number },
    activityLevel: { type: String },
    // Step 2 - Diet & Health Goals
    dietType: { type: String },
    healthGoals: [{ type: String }],
    // Step 3 - Current Symptoms
    symptoms: [{ type: String }],
    symptomSeverity: { type: mongoose.Schema.Types.Mixed },
    stressLevel: { type: String },
    sleepQuality: { type: String },
    waterIntake: { type: String },
    // Step 4 - Medical Information
    medicalConditions: [{ type: String }],
    currentMedications: { type: String },
    allergies: { type: String },
    feelingDescription: { type: String },
    lifestyleHabits: [{ type: String }],
    pregnancyStatus: { type: String },
    takingSupplements: { type: String },
    currentSupplements: { type: String },
    recentBloodTest: { type: String },
    // AI Results stored with assessment
    aiResults: { type: mongoose.Schema.Types.Mixed },
    // New fields
    sunExposure: { type: String },
    fitnessFocus: { type: String },
    proteinIntake: { type: String },
    bloodTestResults: { type: String },
    recreationalDrugTypes: { type: String },
    // User info snapshot (for easy identification in DB)
    userEmail: { type: String },
    userName: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Assessment', assessmentSchema);
