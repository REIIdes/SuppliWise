const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AdminAccount = require('../models/AdminAccount');

const ADMIN_IDLE_TIMEOUT_MS = (3 * 60 + 30) * 1000;

const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role === 'admin') {
      const adminId = decoded.adminId || decoded.id;
      if (!adminId || adminId === 'admin') return res.status(401).json({ message: 'Please sign in again.' });
      const admin = await AdminAccount.findById(adminId).select('alias enabled lastActivityAt');
      if (!admin || !admin.enabled) return res.status(401).json({ message: 'Admin account is unavailable.' });
      if (admin.lastActivityAt && Date.now() - admin.lastActivityAt.getTime() > ADMIN_IDLE_TIMEOUT_MS) {
        return res.status(401).json({ message: 'Admin session expired after inactivity.' });
      }
      if (req.get('x-admin-background') !== 'true') {
        admin.lastActivityAt = new Date();
        await admin.save();
      }
      req.user = { _id: admin._id, role: 'admin', alias: admin.alias };
      return next();
    }
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized, user not found' });
    }
    if (req.user.accountStatus && req.user.accountStatus !== 'active') {
      return res.status(403).json({ message: 'This account is not active.' });
    }
    next();
  } catch (error) {
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required.' });
  next();
};

module.exports = { protect, adminOnly };
