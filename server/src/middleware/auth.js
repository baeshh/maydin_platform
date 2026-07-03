const jwt = require('jsonwebtoken');
const { getOne } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      pharmacy_id: user.pharmacy_id || null
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getOne(
      `SELECT id, email, name, phone, role, pharmacy_id, status
       FROM users
       WHERE id = @id AND status = 'ACTIVE'`,
      { id: payload.id }
    );

    if (!user) {
      return res.status(401).json({ message: '유효하지 않은 사용자입니다.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ message: '유효하지 않은 토큰입니다.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: '접근 권한이 없습니다.' });
    }
    return next();
  };
}

module.exports = {
  authenticate,
  requireRole,
  signToken
};
