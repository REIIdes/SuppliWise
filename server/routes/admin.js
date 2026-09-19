const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Assessment = require('../models/Assessment');
const AdminAccount = require('../models/AdminAccount');
const AdminEvent = require('../models/AdminEvent');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');
const { protect, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(protect, adminOnly);

const safeUserProjection = {
  password: 0,
  twoFactorSecret: 0,
  lastLoginIp: 0,
  lastLoginUserAgent: 0,
};
const adminUserFields = 'firstName lastName email createdAt subscriptionActive subscriptionPlan twoFactorEnabled lastLoginAt lastLoginLocation lastLoginUserAgent accountRole accountStatus';

function securityChecks() {
  const checks = [
    { key: 'jwt', label: 'Strong JWT signing secret', status: Boolean(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32), fix: 'Set a random JWT_SECRET with at least 32 characters.' },
    { key: 'adminMfa', label: 'Admin MFA configured', status: Boolean(process.env.ADMIN_TOTP_SECRET || process.env.ADMIN_ACCOUNTS), fix: 'Configure an authenticator secret for every admin account.' },
    { key: 'adminHash', label: 'Admin password stored as bcrypt hash', status: /^\$2[aby]?\$\d{2}\$/.test(process.env.ADMIN_PASSWORD_HASH || '') || String(process.env.ADMIN_ACCOUNTS || '').includes('|$2'), fix: 'Store every admin password as a bcrypt hash, never plaintext.' },
    { key: 'email', label: 'Email OTP delivery configured', status: Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD), fix: 'Configure EMAIL_USER and EMAIL_PASSWORD for login OTP delivery.' },
    { key: 'production', label: 'Production environment safeguards', status: process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_OTP_RESPONSE !== 'true', fix: 'Use NODE_ENV=production and keep ALLOW_DEV_OTP_RESPONSE disabled.' },
  ];
  return checks.map(check => ({ ...check, status: check.status ? 'healthy' : 'attention' }));
}

async function measureApi(url) {
  if (!url) return { configured: false, status: 'not-configured' };
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: 'HEAD', signal: controller.signal });
    return { configured: true, status: response.ok ? 'healthy' : 'attention', statusCode: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { configured: true, status: 'attention', latencyMs: Date.now() - started, error: error.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}

router.get('/overview', async (req, res) => {
  try {
    const [users, assessments, activeSubscriptions, recentUsers, assessmentTrend] = await Promise.all([
      User.countDocuments(),
      Assessment.countDocuments(),
      User.countDocuments({ subscriptionActive: true }),
      User.find().select(adminUserFields).sort({ createdAt: -1 }).limit(8).lean(),
      Assessment.aggregate([
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: -1 } },
        { $limit: 14 },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const [groq, openai, anthropic] = await Promise.all([
      measureApi(process.env.GROQ_HEALTH_URL),
      measureApi(process.env.OPENAI_HEALTH_URL),
      measureApi(process.env.ANTHROPIC_HEALTH_URL),
    ]);
    const security = securityChecks();
    res.json({
      metrics: { users, assessments, activeSubscriptions, inactiveSubscriptions: users - activeSubscriptions },
      recentUsers,
      assessmentTrend,
      ai: { providers: { groq, openai, anthropic }, configuredCount: [process.env.GROQ_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY].filter(Boolean).length },
      security,
      notifications: security.filter(check => check.status === 'attention').map(check => ({ type: 'security', title: check.label, detail: check.fix })),
    });
  } catch (error) {
    console.error('[admin/overview]', error.message);
    res.status(500).json({ message: 'Unable to load the admin overview.' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const filter = search ? { $or: [
      { email: { $regex: search, $options: 'i' } },
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } },
    ] } : {};
    const users = await User.find(filter).select(adminUserFields).sort({ createdAt: -1 }).limit(100).lean();
    const normalizedUsers = users.map(user => { const device = user.lastLoginUserAgent ? user.lastLoginUserAgent.split(' ').slice(0, 3).join(' ') : 'Unknown device'; delete user.lastLoginUserAgent; return { ...user, device }; });
    res.json({ users: normalizedUsers });
  } catch (error) {
    console.error('[admin/users]', error.message);
    res.status(500).json({ message: 'Unable to load users.' });
  }
});

router.patch('/users/:id/account', async (req, res) => {
  const { role, status } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user account.' });
  if (role && !['user', 'moderator'].includes(role)) return res.status(400).json({ message: 'Invalid account role.' });
  if (status && !['active', 'banned'].includes(status)) return res.status(400).json({ message: 'Invalid account status.' });
  try {
    const update = {};
    if (role) update.accountRole = role;
    if (status) { update.accountStatus = status; update.bannedAt = status === 'banned' ? new Date() : null; }
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select(adminUserFields).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    await AdminEvent.create({ type: 'account', title: 'Account updated', detail: `${user.email} is now ${user.accountStatus} with ${user.accountRole} role.`, user: user._id });
    res.json({ user });
  } catch (error) {
    console.error('[admin/account]', error.message);
    res.status(500).json({ message: 'Unable to update the account.' });
  }
});

router.delete('/users/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid user account.' });
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { accountStatus: 'deleted', bannedAt: new Date() }, { new: true }).select('email').lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    await AdminEvent.create({ type: 'account', title: 'Account deleted', detail: `${user.email} was disabled and marked deleted.`, user: user._id });
    res.json({ message: 'Account deleted and access disabled.' });
  } catch (error) {
    console.error('[admin/delete-user]', error.message);
    res.status(500).json({ message: 'Unable to delete the account.' });
  }
});

router.patch('/users/:id/subscription', async (req, res) => {
  const { active, plan } = req.body || {};
  if (!mongoose.isValidObjectId(req.params.id) || typeof active !== 'boolean') return res.status(400).json({ message: 'A valid user and subscription state are required.' });
  if (plan && !['free', 'monthly', 'annual', 'custom'].includes(plan)) return res.status(400).json({ message: 'Invalid subscription plan.' });
  try {
    const user = await User.findByIdAndUpdate(req.params.id, { subscriptionActive: active, subscriptionPlan: plan || (active ? 'custom' : 'free'), subscriptionUpdatedAt: new Date() }, { new: true }).select(safeUserProjection).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json({ user });
  } catch (error) {
    console.error('[admin/subscription]', error.message);
    res.status(500).json({ message: 'Unable to update the subscription.' });
  }
});

router.get('/security', (req, res) => {
  const checks = securityChecks();
  res.json({ checks, notifications: checks.filter(check => check.status === 'attention') });
});

router.get('/ai', (req, res) => {
  res.json({ providers: [
    { key: 'groq', label: 'Groq', configured: Boolean(process.env.GROQ_API_KEY), model: process.env.GROQ_MODEL || 'configured by server' },
    { key: 'openai', label: 'OpenAI', configured: Boolean(process.env.OPENAI_API_KEY), model: process.env.OPENAI_MODEL || 'not configured' },
    { key: 'anthropic', label: 'Anthropic', configured: Boolean(process.env.ANTHROPIC_API_KEY), model: process.env.ANTHROPIC_MODEL || 'not configured' },
  ] });
});

router.get('/profile', async (req, res) => {
  if (!mongoose.isValidObjectId(req.user._id)) return res.json({ alias: req.user.alias, createdAt: null, lastLoginAt: null });
  const account = await AdminAccount.findById(req.user._id).select('alias createdAt lastLoginAt').lean();
  res.json({ alias: account?.alias || req.user.alias, createdAt: account?.createdAt || null, lastLoginAt: account?.lastLoginAt || null });
});

router.patch('/profile/password', async (req, res) => {
  const { currentPassword, newPassword, otp } = req.body || {};
  if (!currentPassword || !newPassword || !/^\d{6}$/.test(String(otp || ''))) return res.status(400).json({ message: 'Current password, new password, and authenticator code are required.' });
  if (newPassword.length < 8 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return res.status(400).json({ message: 'New password must be at least 8 characters with a capital letter and number.' });
  if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before changing the admin password.' });
  const account = await AdminAccount.findById(req.user._id).select('+passwordHash +totpSecret');
  if (!account) return res.status(404).json({ message: 'Admin account not found.' });
  if (!await bcrypt.compare(currentPassword, account.passwordHash)) return res.status(401).json({ message: 'Current password is incorrect.' });
  const verified = speakeasy.totp.verify({ secret: account.totpSecret, encoding: 'base32', token: String(otp), window: 1 });
  if (!verified) return res.status(401).json({ message: 'Invalid authenticator code.' });
  account.passwordHash = await bcrypt.hash(newPassword, 12);
  await account.save();
  res.json({ message: 'Admin password changed successfully.' });
});

router.post('/profile/authenticator/rotate', async (req, res) => {
  const { otp } = req.body || {};
  if (!mongoose.isValidObjectId(req.user._id)) return res.status(409).json({ message: 'Please sign in again before rotating your authenticator key.' });
  const account = await AdminAccount.findById(req.user._id).select('+totpSecret');
  if (!account) return res.status(404).json({ message: 'Admin account not found.' });
  if (!/^\d{6}$/.test(String(otp || '')) || !speakeasy.totp.verify({ secret: account.totpSecret, encoding: 'base32', token: String(otp), window: 1 })) return res.status(401).json({ message: 'Invalid current authenticator code.' });
  const secret = speakeasy.generateSecret({ name: `SuppliWise Admin (${account.alias})`, issuer: 'SuppliWise' });
  account.totpSecret = secret.base32;
  await account.save();
  res.json({ qrCode: await require('qrcode').toDataURL(secret.otpauth_url), secret: secret.base32, message: 'New authenticator key generated. Add it before signing out.' });
});

router.get('/notifications', async (req, res) => {
  const security = securityChecks().filter(check => check.status === 'attention').map(check => ({ type: 'security', title: check.label, detail: check.fix, createdAt: new Date() }));
  const events = await AdminEvent.find().sort({ createdAt: -1 }).limit(30).lean();
  res.json({ unreadCount: events.filter(event => !event.readBy.some(id => String(id) === String(req.user._id))).length + security.length, notifications: [...security, ...events] });
});

module.exports = router;
