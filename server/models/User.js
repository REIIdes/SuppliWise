const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      minlength: [2, 'First name must be at least 2 characters'],
      maxlength: [50, 'First name must be 50 characters or fewer'],
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      minlength: [2, 'Last name must be at least 2 characters'],
      maxlength: [50, 'Last name must be 50 characters or fewer'],
    },
    name: {
      type: String,
      trim: true,
      // Virtual field computed from firstName + lastName, but keep for backward compatibility
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,6}$/, 'Please enter a valid email address.'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters.'],
    },
    dateOfBirth: {
      type: Date,
      required: [true, 'Date of birth is required'],
      validate: {
        validator: function(value) {
          const today = new Date();
          const birthDate = new Date(value);
          const age = today.getFullYear() - birthDate.getFullYear();
          const monthDiff = today.getMonth() - birthDate.getMonth();
          const adjustedAge = monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate()) ? age - 1 : age;
          return adjustedAge >= 1 && adjustedAge <= 120;
        },
        message: 'Please enter a valid date of birth (age must be between 1 and 120).',
      },
    },
    gender: {
      type: String,
      required: [true, 'Gender is required'],
      enum: ['Male', 'Female'],
    },
    profilePicture: {
      type: String,
      default: '',
    },
    bannerPicture: {
      type: String,
      default: '',
    },
  },
  { timestamps: true }
);

// Virtual for full name
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Virtual for age calculated from dateOfBirth
userSchema.virtual('age').get(function() {
  if (!this.dateOfBirth) return null;
  const today = new Date();
  const birthDate = new Date(this.dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
});

// Ensure virtuals are included in JSON
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

// Pre-save hook to set name field from firstName + lastName for backward compatibility
userSchema.pre('save', async function (next) {
  // Set name from firstName + lastName
  if (this.firstName && this.lastName) {
    this.name = `${this.firstName} ${this.lastName}`;
  }
  
  // Hash password
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password method
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Cascade delete — remove all assessments when a user is deleted
userSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    const Assessment = require('./Assessment');
    await Assessment.deleteMany({ user: doc._id });
    console.log(`Cascade deleted assessments for user ${doc._id}`);
  }
});

userSchema.post('deleteOne', { document: true, query: false }, async function () {
  const Assessment = require('./Assessment');
  await Assessment.deleteMany({ user: this._id });
  console.log(`Cascade deleted assessments for user ${this._id}`);
});

module.exports = mongoose.model('User', userSchema);
