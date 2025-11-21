import { Router } from 'express';
import { prisma } from '../database';
import { CONFIG } from '../config';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

export const adminRouter = Router();

interface AdminSession {
  discordId: string;
  discordUsername: string;
  discordAvatar?: string;
  guildId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    adminSession?: AdminSession;
  }
}

async function authMiddleware(req: any, res: any, next: any) {
  try {
    const sessionToken = req.cookies?.admin_session;
    if (!sessionToken) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const session = await prisma.adminSession.findUnique({
      where: { sessionToken },
    });

    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    req.adminSession = {
      discordId: session.discordId,
      discordUsername: session.discordUsername,
      discordAvatar: session.discordAvatar || undefined,
      guildId: session.guildId,
    };

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Server error' });
  }
}

adminRouter.get('/login', async (req, res) => {
  const state = uuidv4();
  const redirectUri = `${CONFIG.server.baseUrl}/api/admin/callback`;
  
  await prisma.adminSession.create({
    data: {
      sessionToken: state,
      discordId: 'pending',
      discordUsername: 'pending',
      guildId: CONFIG.discord.guildId,
      ipAddress: req.ip || 'unknown',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    },
  });
  
  const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${CONFIG.discord.clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify%20guilds.members.read&state=${state}`;
  
  res.redirect(authUrl);
});

adminRouter.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
    if (!state || !code) {
      return res.status(400).send('<h1>Error</h1><p>Missing state or code parameter</p>');
    }

    const stateSession = await prisma.adminSession.findUnique({
      where: { sessionToken: state as string },
    });

    if (!stateSession || stateSession.discordId !== 'pending') {
      return res.status(400).send('<h1>Error</h1><p>Invalid or expired state</p>');
    }

    if (stateSession.expiresAt < new Date()) {
      await prisma.adminSession.delete({ where: { sessionToken: state as string } });
      return res.status(400).send('<h1>Error</h1><p>State expired</p>');
    }

    await prisma.adminSession.delete({ where: { sessionToken: state as string } });
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CONFIG.discord.clientId,
        client_secret: CONFIG.discord.clientSecret,
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: `${CONFIG.server.baseUrl}/api/admin/callback`,
      }),
    });

    const tokenData = await tokenResponse.json() as any;

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userData = await userResponse.json() as any;

    const memberResponse = await fetch(
      `https://discord.com/api/users/@me/guilds/${CONFIG.discord.guildId}/member`,
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
    );

    const memberData = await memberResponse.json() as any;

    if (!memberData.roles || !memberData.roles.includes(CONFIG.discord.adminRoleId)) {
      return res.send('<h1>Access Denied</h1><p>You do not have permission to access the admin dashboard.</p>');
    }

    const sessionToken = uuidv4();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.adminSession.create({
      data: {
        sessionToken,
        discordId: userData.id,
        discordUsername: userData.username,
        discordAvatar: userData.avatar,
        guildId: CONFIG.discord.guildId,
        ipAddress: req.ip || 'unknown',
        expiresAt,
      },
    });

    res.cookie('admin_session', sessionToken, {
      httpOnly: true,
      secure: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'strict',
    });

    res.redirect('/');
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).send('<h1>Error</h1><p>Failed to authenticate</p>');
  }
});

adminRouter.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.adminSession });
});

adminRouter.post('/logout', authMiddleware, async (req, res) => {
  try {
    const sessionToken = req.cookies?.admin_session;
    if (sessionToken) {
      await prisma.adminSession.deleteMany({
        where: { sessionToken },
      });
    }
    res.clearCookie('admin_session');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to logout' });
  }
});

adminRouter.get('/stats', authMiddleware, async (req, res) => {
  try {
    const guildId = req.adminSession!.guildId;

    const totalUsers = await prisma.user.count({ where: { guildId } });
    const totalAttempts = await prisma.verificationAttempt.count({ where: { guildId } });
    const successfulVerifications = await prisma.verificationAttempt.count({
      where: { guildId, success: true },
    });
    const failedVerifications = totalAttempts - successfulVerifications;
    const whitelistedIPs = await prisma.whitelist.count({ where: { guildId } });
    const blacklistedIPs = await prisma.blacklist.count({ where: { guildId } });

    const recentAttempts = await prisma.verificationAttempt.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const recentActivity = recentAttempts.map((attempt) => ({
      id: attempt.id,
      type: attempt.success ? 'success' : 'failure',
      message: attempt.success
        ? `User ${attempt.discordId} verified successfully`
        : `Verification failed for ${attempt.discordId}: ${attempt.reason}`,
      timestamp: attempt.createdAt.toISOString(),
    }));

    res.json({
      totalUsers,
      totalAttempts,
      successfulVerifications,
      failedVerifications,
      whitelistedIPs,
      blacklistedIPs,
      recentActivity,
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

adminRouter.get('/users', authMiddleware, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { guildId: req.adminSession!.guildId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

adminRouter.delete('/users/:id', authMiddleware, async (req, res) => {
  try {
    await prisma.user.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

adminRouter.get('/whitelist', authMiddleware, async (req, res) => {
  try {
    const entries = await prisma.whitelist.findMany({
      where: { guildId: req.adminSession!.guildId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ entries });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch whitelist' });
  }
});

adminRouter.post('/whitelist', authMiddleware, async (req, res) => {
  try {
    const { ipAddress, discordId, reason } = req.body;
    const entry = await prisma.whitelist.create({
      data: {
        ipAddress: ipAddress || null,
        discordId: discordId || null,
        guildId: req.adminSession!.guildId,
        reason: reason || null,
        addedBy: req.adminSession!.discordId,
      },
    });
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add whitelist entry' });
  }
});

adminRouter.delete('/whitelist/:id', authMiddleware, async (req, res) => {
  try {
    await prisma.whitelist.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete whitelist entry' });
  }
});

adminRouter.get('/blacklist', authMiddleware, async (req, res) => {
  try {
    const entries = await prisma.blacklist.findMany({
      where: { guildId: req.adminSession!.guildId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ entries });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch blacklist' });
  }
});

adminRouter.post('/blacklist', authMiddleware, async (req, res) => {
  try {
    const { ipAddress, discordId, reason } = req.body;
    const entry = await prisma.blacklist.create({
      data: {
        ipAddress: ipAddress || null,
        discordId: discordId || null,
        guildId: req.adminSession!.guildId,
        reason: reason || null,
        addedBy: req.adminSession!.discordId,
      },
    });
    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add blacklist entry' });
  }
});

adminRouter.delete('/blacklist/:id', authMiddleware, async (req, res) => {
  try {
    await prisma.blacklist.delete({
      where: { id: req.params.id },
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete blacklist entry' });
  }
});

adminRouter.get('/logs', authMiddleware, async (req, res) => {
  try {
    const logs = await prisma.verificationAttempt.findMany({
      where: { guildId: req.adminSession!.guildId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});
