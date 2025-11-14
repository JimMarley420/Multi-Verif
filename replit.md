# VeeriBot - Discord Verification Bot

## Overview
VeeriBot is a Discord verification bot that prevents alt accounts and VPN/proxy users from joining servers. It provides role-based verification with IP checking via ipapi.is.

## Project Structure
```
├── src/
│   ├── commands/           # Discord slash commands
│   │   └── sendverificationembed.ts
│   ├── web/               # Express web server for OAuth callback
│   │   └── server.ts
│   ├── bot.ts             # Discord bot logic
│   ├── config.ts          # Configuration management
│   ├── database.ts        # Prisma database client
│   └── index.ts           # Main entry point
├── prisma/
│   └── schema.prisma      # Database schema
└── package.json
```

## Recent Changes
- **2024-11-14**: Initial Replit setup
  - Configured for Replit environment with PostgreSQL database
  - Set up port 5000 for frontend (OAuth callbacks)
  - Auto-configured BASE_URL from Replit environment variables
  - Generated Prisma client and initialized database schema

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Discord**: discord.js v14
- **Database**: PostgreSQL with Prisma ORM
- **Web Framework**: Express.js
- **IP Validation**: ipapi.is API

## Configuration

### Required Environment Secrets
The following secrets must be set in Replit Secrets:

1. **Discord Bot Configuration**:
   - `DISCORD_BOT_TOKEN` - Your Discord bot token from Discord Developer Portal
   - `DISCORD_CLIENT_ID` - Discord application client ID
   - `DISCORD_CLIENT_SECRET` - Discord application client secret
   - `ADMIN_ROLE_ID` - Discord role ID that can use admin commands
   - `GUILD_ID` - Your Discord server (guild) ID

2. **API Keys**:
   - `IPAPI_API_KEY` - API key from https://ipapi.is/ for IP validation

3. **Database**:
   - `DATABASE_URL` - Automatically configured by Replit PostgreSQL

### Optional Environment Variables
- `PORT` - Server port (default: 5000)
- `HOST` - Server host (default: 0.0.0.0)
- `BASE_URL` - Public URL for OAuth redirects (auto-detected from Replit domain)
- `LOG_TOKENS` - Set to 'true' to log Discord tokens (default: false)

### Base URL Configuration
The BASE_URL is automatically constructed from Replit environment:
- If `BASE_URL` secret exists, it will be used
- Otherwise, it's built from `REPL_SLUG` and `REPL_OWNER`
- Falls back to `http://localhost:5000` for local development

**Important**: For Discord OAuth to work, you must add the redirect URI to your Discord application:
- Format: `https://{REPL_SLUG}-{REPL_OWNER}.replit.app/verify`
- Add this in Discord Developer Portal → Your App → OAuth2 → Redirects

## Database Schema

### Models
1. **User** - Verified users with their IP addresses
2. **VerificationSession** - Temporary verification sessions
3. **VerificationAttempt** - Log of all verification attempts
4. **DiscordToken** - Optional token logging (when LOG_TOKENS=true)

### Database Commands
```bash
npm run db:generate    # Generate Prisma client
npx prisma db push    # Push schema changes to database
npx prisma studio     # Open database GUI
```

## How It Works

1. **Setup**: Admin uses `/sendverificationembed` command to create a verification panel
2. **User Clicks**: User clicks "Verify" button in the embed
3. **OAuth Flow**: 
   - Bot creates unique session and redirects to Discord OAuth
   - User authorizes the application
   - Discord redirects back to `/verify` endpoint with auth code
4. **Verification**:
   - Server exchanges code for user info
   - Checks IP address against ipapi.is for VPN/proxy
   - Checks for alt accounts (same IP, different Discord ID)
   - Grants role if all checks pass
5. **Logging**: Results logged to database and optional webhook

## Commands

### `/sendverificationembed`
Creates a verification embed with customizable settings.

**Parameters**:
- `title` - Title of the verification embed (required)
- `description` - Description text (required)
- `role` - Role to grant on successful verification (required)
- `webhookurl` - Discord webhook for logging attempts (optional)
- `expiration` - Minutes until panel expires, 0 for never (optional, default: 30)

**Example**:
```
/sendverificationembed 
  title:"Verify for Access" 
  description:"Click to verify your account" 
  role:@Members 
  webhookurl:https://discord.com/api/webhooks/...
  expiration:120
```

## Development

### Running the Bot
The bot runs automatically via the configured workflow. To restart:
- Use the "Run" button in Replit
- Or restart the workflow manually

### Checking Logs
- View workflow logs in the Replit console
- Check database with Prisma Studio: `npx prisma studio`

### Common Issues

**Bot not responding**:
- Verify all Discord secrets are set correctly
- Check that bot has proper permissions in Discord server
- Ensure bot's role is higher than roles it needs to grant

**Verification failing with "Invalid session"**:
- Check that BASE_URL matches your Replit domain
- Verify redirect URI is configured in Discord Developer Portal

**IP checks always failing**:
- Verify IPAPI_API_KEY is valid
- Check API quota at https://ipapi.is/

## Security Notes
- IP addresses and Discord tokens are stored in the database
- Set `LOG_TOKENS=true` only for debugging (logs OAuth tokens)
- Rate limiting is configured (100 requests/15min, 5 verifications/5min)
- Supports Cloudflare proxy for IP detection

## User Preferences
- Use TypeScript for all code
- Follow existing code style and patterns
- Keep security as top priority
- Database operations through Prisma only
