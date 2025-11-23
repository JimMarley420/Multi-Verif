import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { CONFIG } from '../config';
import { prisma } from '../database';
import fetch from 'node-fetch';

export class WebServer {
  private app: express.Application;
  private bot: any;

  constructor(bot: any) {
    this.app = express();
    this.bot = bot;
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    // Config trust proxy SPECIFICALLY for cloudflare
    this.app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', 
      '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
      '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
      '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
      '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
    ]);

    this.app.use(helmet({
      contentSecurityPolicy: false,
    }));
    
    this.app.use(cors({
      origin: CONFIG.server.baseUrl,
      credentials: true,
    }));

    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 100,
      message: 'Too many requests from this ip, please try again later',
      keyGenerator: (req) => this.getClientIP(req),
    });
    this.app.use(limiter);

    const verifyLimiter = rateLimit({
      windowMs: 5 * 60 * 1000,
      max: 5,
      message: 'Too many verification attempts, you have been rate limited; Please wait and try again after 4-5 minutes. Please contact support if you continue to have issues.',
      keyGenerator: (req) => this.getClientIP(req),
    });
    this.app.use('/verify', verifyLimiter);

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
  }

  private setupRoutes() {
    this.app.use(express.static('public'));
    
    this.app.get('/verify', async (req, res) => {
      const { code, state } = req.query;

      if (!code || !state) {
        return res.send(this.renderErrorPage('Invalid verification request.'));
      }

      try {
        const session = await prisma.verificationSession.findUnique({
          where: { state: state as string },
        });

        if (!session) {
          return res.send(this.renderErrorPage('Invalid or expired verification session.'));
        }

        if (session.expiresAt < new Date()) {
          return res.send(this.renderErrorPage('Verification session has expired.'));
        }

        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            client_id: CONFIG.discord.clientId,
            client_secret: CONFIG.discord.clientSecret,
            grant_type: 'authorization_code',
            code: code as string,
            redirect_uri: CONFIG.server.baseUrl + '/verify',
          }),
        });

        const tokenData = await tokenResponse.json() as any;

        const userResponse = await fetch('https://discord.com/api/users/@me', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
          },
        });

        const userData = await userResponse.json() as any;
        const discordId = userData.id;

        const ipAddress = this.getClientIP(req);

        if (CONFIG.logTokens) {
          await prisma.discordToken.create({
            data: {
              discordId,
              accessToken: tokenData.access_token,
              tokenType: tokenData.token_type,
              refreshToken: tokenData.refresh_token,
              expiresIn: tokenData.expires_in,
              scope: tokenData.scope,
              ipAddress,
              guildId: session.guildId,
            },
          });
        }
        
        const result = await this.processVerification(discordId, ipAddress, session);
        
        await this.updateMsg(session, discordId, result);
        
        await prisma.verificationSession.delete({
          where: { state: state as string },
        });

        return res.send(this.renderResultPage(result));

      } catch (error) {
        console.error('error during verification', error);
        return res.send(this.renderErrorPage('An error occurred during verification.'));
      }
    });

    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    this.app.get('/check', (req, res) => {
      const userAgent = req.headers['user-agent'] || '';
      
      // List of bot/crawler patterns
      const botPatterns = [
        'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python',
        'java(?!script)', 'node', 'ruby', 'perl', 'php', 'go-http-client',
        'axios', 'postman', 'insomnia', 'thunder', 'fetch', 'request'
      ];
      
      // Check if user-agent matches bot patterns
      const isBot = botPatterns.some(pattern => 
        new RegExp(pattern, 'i').test(userAgent)
      );
      
      // Return 403 for normal browsers, 200 for bots
      if (isBot) {
        return res.status(200).send('ALL OK');
      } else {
        return res.status(403).send('ALL OK');
      }
    });

    this.app.get('/ok', (req, res) => {
      res.status(200).send('ALL OK');
    });
  }

  private async processVerification(discordId: string, ipAddress: string, session: any) {
    try {
      const ipCheckResult = await this.checkIP(ipAddress);
      if (ipCheckResult.isProxy) {
        await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, false, 'proxy');
        await this.logToWebhook(session, discordId, ipAddress, false, 'Verification failed: VPN/Proxy detected');
        return {
          success: false,
          reason: 'proxy',
          message: 'We detected that you are using a VPN or proxy. Please disable it and try verifying again. If you believe this is an error, contact our support team.',
        };
      }

      const existingUser = await prisma.user.findFirst({
        where: {
          ipAddress,
          guildId: session.guildId,
          roleId: session.roleId,
          NOT: { discordId },
        },
      });

      if (existingUser) {
        await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, false, 'alt_account');
        await this.logToWebhook(session, discordId, ipAddress, false, `Verification failed: Alt account detected. Original account: ${existingUser.discordId}`);
        return {
          success: false,
          reason: 'alt_account',
          message: 'An account from your network has already been verified. If you believe this is a mistake, please contact support with details about your situation.',
        };
      }

      const guild = this.bot.client.guilds.cache.get(session.guildId);
      if (guild) {
        try {
          const member = await guild.members.fetch(discordId);
          if (member && member.roles.cache.has(session.roleId)) {
            return {
              success: true,
              reason: 'already_had_role',
              message: 'Your account is already verified. You have the required role and can access all server features.',
            };
          }
        } catch (error) {
          // could not check existing roles for x user
        }
      }

      const roleGranted = await this.grantRole(discordId, session.guildId, session.roleId);
      
      if (!roleGranted) {
        await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, false, 'role_error');
        await this.logToWebhook(session, discordId, ipAddress, false, 'Verification failed: Unable to grant role');
        return {
          success: false,
          reason: 'error',
          message: 'We were unable to assign your role. Please contact a server administrator for assistance.',
        };
      }
      
      const existingUserRecord = await prisma.user.findUnique({
        where: {
          discordId_guildId_roleId: {
            discordId: discordId,
            guildId: session.guildId,
            roleId: session.roleId,
          },
        },
      });

      if (existingUserRecord) {
        await prisma.user.update({
          where: {
            discordId_guildId_roleId: {
              discordId: discordId,
              guildId: session.guildId,
              roleId: session.roleId,
            },
          },
          data: {
            ipAddress,
            verifiedAt: new Date(),
            updatedAt: new Date(),
          },
        });
      } else {
        await prisma.user.create({
          data: {
            discordId,
            ipAddress,
            guildId: session.guildId,
            roleId: session.roleId,
          },
        });
      }

      await this.logVerificationAttempt(discordId, ipAddress, session.guildId, session.roleId, true, 'success');
      await this.logToWebhook(session, discordId, ipAddress, true, 'Successfully verified');

      return {
        success: true,
        reason: 'success',
        message: 'Verification complete! Your role has been assigned and you now have full access to the server.',
      };

    } catch (error) {
      console.error('Error processing verification:', error);
      return {
        success: false,
        reason: 'error',
        message: 'An unexpected error occurred during verification. Please try again or contact support if the issue persists.',
      };
    }
  }

  private async checkIP(ipAddress: string) {
    try {
      const response = await fetch(`https://api.ipapi.is/?q=${ipAddress}&key=${CONFIG.ipapi.apiKey}`);
      const data = await response.json() as any;
      
      const isProxy = data.is_proxy === true || 
                     data.is_vpn === true || 
                     data.is_datacenter === true ||
                     data.is_tor === true ||
                     data.is_abuser === true;
      
      return {
        isProxy,
        country: data.location?.country || 'Unknown',
        city: data.location?.city || 'Unknown',
        isp: data.company?.name || 'Unknown',
        org: data.asn?.org || 'Unknown',
        hosting: data.is_datacenter || false,
        mobile: data.is_mobile || false
      };
    } catch (error) {
      console.error('err checking IP:', error);
      return { 
        isProxy: true,
        country: 'Unknown',
        city: 'Unknown',
        isp: 'Unknown',
        org: 'Unknown',
        hosting: false,
        mobile: false
      };
    }
  }

  private async grantRole(discordId: string, guildId: string, roleId: string) {
    try {
      const guild = this.bot.client.guilds.cache.get(guildId);
      if (!guild) {
        console.error('server not found', guildId);
        return false;
      }

      const member = await guild.members.fetch(discordId);
      if (!member) {
        console.error('member not found', discordId);
        return false;
      }

      const role = guild.roles.cache.get(roleId);
      if (!role) {
        console.error('role not found', roleId);
        return false;
      }

      if (member.roles.cache.has(roleId)) {
        console.log('user already has role:', discordId, roleId);
        return true;
      }

      await member.roles.add(role);
      console.log('role granted to user', discordId, role.name);
      return true;
    } catch (error) {
      console.error('err granting role:', error);
      return false;
    }
  }

  private async logVerificationAttempt(
    discordId: string, 
    ipAddress: string, 
    guildId: string, 
    roleId: string,
    success: boolean, 
    reason: string
  ) {
    try {
      await prisma.verificationAttempt.create({
        data: {
          discordId,
          ipAddress,
          guildId,
          roleId,
          success,
          reason,
        },
      });
    } catch (error) {
      console.error('err logging attempt:', error);
    }
  }

  private async logToWebhook(session: any, discordId: string, ipAddress: string, success: boolean, message: string) {
    try {
      const webhookUrl = session.webhookUrl;
      if (!webhookUrl) return;

      const user = await this.bot.client.users.fetch(discordId);
      const embed = {
        title: success ? 'Verification Successful' : 'Verification Failed',
        description: message,
        fields: [
          { name: 'User', value: `${user.tag} (${discordId})`, inline: true },
          { name: 'IP', value: ipAddress, inline: true },
          { name: 'Time', value: new Date().toISOString(), inline: true },
        ],
        color: success ? 0x00ff00 : 0xff0000,
        timestamp: new Date().toISOString(),
      };

      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          embeds: [embed],
        }),
      });
    } catch (error) {
      console.error('err logging to webhook:', error);
    }
  }

  private async updateMsg(session: any, discordId: string, result: any) {
    try {
      let content: string;
      if (result.success || result.reason === 'already_had_role') {
        if (result.reason === 'already_had_role') {
          content = `✅ **Already Verified**\n\nYour account is already verified. You have the required role and can access all server features.`;
        } else {
          content = `✅ **Verification Complete**\n\nYour role has been assigned successfully. You now have full access to the server.`;
        }
      } else {
        let failureMessage = "❌ **Verification Failed**\n\n";
        switch (result.reason) {
          case 'proxy':
            failureMessage += "We detected a VPN or proxy. Please disable it and try again.\n\nIf this is an error, contact support.";
            break;
          case 'alt_account':
            failureMessage += "An account from your network is already verified.\n\nIf this is a mistake, contact support with details.";
            break;
          default:
            failureMessage += "An unexpected error occurred.\n\nPlease try again or contact support if the issue persists.";
        }
        content = failureMessage;
      }

      this.bot.pendingMessageUpdates = this.bot.pendingMessageUpdates || new Map();
      this.bot.pendingMessageUpdates.set(discordId, {
        content,
        success: result.success,
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error updating Discord message:', error);
    }
  }

  private getClientIP(req: express.Request): string {
    const cfConnectingIP = req.headers['cf-connecting-ip'] as string;
    if (cfConnectingIP) {
      return cfConnectingIP;
    }
    
    const xForwardedFor = req.headers['x-forwarded-for'] as string;
    if (xForwardedFor) {
      return xForwardedFor.split(',')[0].trim();
    }
    
    return req.connection.remoteAddress ||
           req.socket.remoteAddress ||
           '127.0.0.1';
  }

  private renderErrorPage(message: string): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Verification Error - Multi-Verif</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem 1rem;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.8; }
        }
        .card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 480px;
            width: 100%;
            padding: 3rem 2rem;
            text-align: center;
            animation: fadeIn 0.5s ease-out;
        }
        .logo {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem;
            animation: fadeIn 0.6s ease-out 0.1s backwards;
        }
        .logo img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        .brand {
            font-size: 0.875rem;
            color: #6b7280;
            margin-bottom: 2rem;
            font-weight: 500;
        }
        .icon {
            width: 64px;
            height: 64px;
            background: linear-gradient(135deg, #fee 0%, #fdd 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            animation: pulse 2s ease-in-out infinite;
        }
        .icon svg {
            width: 32px;
            height: 32px;
            color: #dc2626;
        }
        h1 {
            font-size: 1.875rem;
            font-weight: 800;
            background: linear-gradient(135deg, #111827 0%, #374151 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 1rem;
            animation: fadeIn 0.6s ease-out 0.2s backwards;
        }
        p {
            font-size: 1rem;
            color: #6b7280;
            margin-bottom: 2rem;
            line-height: 1.6;
            animation: fadeIn 0.6s ease-out 0.3s backwards;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
            color: white;
            padding: 0.875rem 1.75rem;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
            animation: fadeIn 0.6s ease-out 0.4s backwards;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(37, 99, 235, 0.4);
        }
        .btn svg {
            width: 18px;
            height: 18px;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <img src="/logo.png" alt="Multi-Verif">
        </div>
        <div class="brand">Multi-Verif by MultiChat</div>
        <div class="icon">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </div>
        <h1>Verification Error</h1>
        <p>${message}</p>
        <a href="https://multichat.cloud/support" target="_blank" rel="noopener noreferrer" class="btn">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"></path>
            </svg>
            Contact Support
        </a>
    </div>
</body>
</html>`;
  }

  private renderResultPage(result: any): string {
    const isSuccess = result.success;
    
    let gradientBg = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    let iconGradient = 'linear-gradient(135deg, #fee 0%, #fdd 100%)';
    let iconColor = '#dc2626';
    let icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />';
    let title = 'Verification Failed';

    if (isSuccess) {
      gradientBg = 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)';
      iconGradient = 'linear-gradient(135deg, #d1fae5 0%, #a7f3d0 100%)';
      iconColor = '#059669';
      icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />';
      title = 'Verification Successful';
    } else if (result.reason === 'alt_account') {
      gradientBg = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
      iconGradient = 'linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)';
      iconColor = '#dc2626';
      icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />';
      title = 'Alternate Account Detected';
    } else if (result.reason === 'proxy') {
      gradientBg = 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)';
      iconGradient = 'linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%)';
      iconColor = '#2563eb';
      icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />';
      title = 'VPN/Proxy Detected';
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title} - Multi-Verif</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: ${gradientBg};
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 2rem 1rem;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.8; }
        }
        @keyframes checkmark {
            0% { stroke-dashoffset: 100; }
            100% { stroke-dashoffset: 0; }
        }
        .card {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 24px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 480px;
            width: 100%;
            padding: 3rem 2rem;
            text-align: center;
            animation: fadeIn 0.5s ease-out;
        }
        .logo {
            width: 80px;
            height: 80px;
            margin: 0 auto 1.5rem;
            animation: fadeIn 0.6s ease-out 0.1s backwards;
        }
        .logo img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        .brand {
            font-size: 0.875rem;
            color: #6b7280;
            margin-bottom: 2rem;
            font-weight: 500;
        }
        .icon {
            width: 64px;
            height: 64px;
            background: ${iconGradient};
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 1.5rem;
            animation: pulse 2s ease-in-out infinite;
        }
        .icon svg {
            width: 32px;
            height: 32px;
            color: ${iconColor};
        }
        h1 {
            font-size: 1.875rem;
            font-weight: 800;
            background: linear-gradient(135deg, #111827 0%, #374151 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 1rem;
            animation: fadeIn 0.6s ease-out 0.2s backwards;
        }
        p {
            font-size: 1rem;
            color: #6b7280;
            margin-bottom: 2rem;
            line-height: 1.6;
            animation: fadeIn 0.6s ease-out 0.3s backwards;
        }
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
            color: white;
            padding: 0.875rem 1.75rem;
            border-radius: 12px;
            text-decoration: none;
            font-weight: 600;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
            animation: fadeIn 0.6s ease-out 0.4s backwards;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(37, 99, 235, 0.4);
        }
        .btn svg {
            width: 18px;
            height: 18px;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">
            <img src="/logo.png" alt="Multi-Verif">
        </div>
        <div class="brand">Multi-Verif by MultiChat</div>
        <div class="icon">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                ${icon}
            </svg>
        </div>
        <h1>${title}</h1>
        <p>${result.message}</p>
        <a href="https://multichat.cloud/support" target="_blank" rel="noopener noreferrer" class="btn">
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"></path>
            </svg>
            Contact Support
        </a>
    </div>
</body>
</html>`;
  }

  public start() {
    this.app.listen(CONFIG.server.port, CONFIG.server.host, () => {
      console.log(`frontend for VeeriBot started on ${CONFIG.server.baseUrl}`);
    });
  }
}
