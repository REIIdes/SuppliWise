const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
    },
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre('save', async function (next) {
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
