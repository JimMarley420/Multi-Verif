# VeeriBot

## Overview

VeeriBot is a Discord verification bot designed to prevent alt accounts and VPN/proxy users from accessing Discord servers. It provides a web-based admin dashboard for managing verified users, IP whitelists/blacklists, and viewing verification statistics. The system uses Discord OAuth2 for both user verification and admin authentication, integrates with the ipapi.is service for IP validation, and maintains a comprehensive audit trail of all verification attempts.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Backend Architecture

**Framework**: Express.js with TypeScript
- Type-safe REST API server
- Cookie-based session management for admin authentication
- Rate limiting with Cloudflare proxy trust configuration
- Helmet for security headers and CORS for cross-origin requests

**Discord Integration**: Discord.js v14
- Bot client with gateway intents for guilds, messages, and members
- Slash command system for creating verification embeds
- Button interactions for user verification flow
- OAuth2 flow for both user verification and admin dashboard login

**Database**: Prisma ORM
- Abstracts database operations with type-safe queries
- Schema includes: verified users, admin sessions, blacklist/whitelist entries, verification logs
- PostgreSQL as the primary data store (though Prisma supports multiple databases)

**IP Validation**: ipapi.is API
- Real-time IP address checking during verification
- Detects VPNs, proxies, data centers, and Tor connections
- Provides company/ISP information for suspicious IPs

### Frontend Architecture

**Framework**: React 18 with TypeScript
- Single Page Application (SPA) using Vite as build tool
- React Router for client-side routing
- Component-based architecture with functional components and hooks

**Key Components**:
- `StatsOverview`: Real-time statistics dashboard
- `UserManagement`: CRUD operations for verified users
- `WhitelistManager` / `BlacklistManager`: IP and Discord ID allow/deny lists
- `VerificationLogs`: Audit trail of verification attempts

**Styling**: Custom CSS with CSS variables
- Discord-inspired dark theme
- Responsive grid layouts
- Consistent design system across components

### Authentication & Authorization

**User Verification Flow**:
1. Admin creates verification embed via `/sendverificationembed` command
2. User clicks verification button, initiating OAuth2 flow
3. System validates IP address against ipapi.is
4. System checks blacklist/whitelist entries
5. On success, grants role and logs verification
6. Optional webhook notification for verification events

**Admin Authentication**:
- Discord OAuth2 with guild membership validation
- Server-side session management with expiring tokens
- Cookie-based session storage
- Admin role requirement (configurable via ADMIN_ROLE_ID)

### Verification Logic

**Security Checks** (performed in order):
1. Whitelist bypass: Whitelisted IPs/Discord IDs skip all checks
2. Blacklist rejection: Blacklisted IPs/Discord IDs are immediately denied
3. IP validation: ipapi.is checks for VPN/proxy/datacenter/Tor
4. Duplicate prevention: Prevents same user from verifying multiple times for the same role

**Configurable Features**:
- Expiration time for verification panels (0 = never expires, default 30 minutes)
- Per-role verification tracking
- Optional webhook logging for successful/failed attempts
- Customizable embed titles and descriptions

### Data Models

**Core Entities**:
- `VerifiedUser`: Stores Discord ID, IP address, guild, role, and verification timestamp
- `AdminSession`: Manages admin dashboard sessions with expiration
- `Blacklist` / `Whitelist`: IP and Discord ID entries with reasons and audit trail
- `VerificationLog`: Complete audit log of all verification attempts
- `VerificationPanel`: Metadata for active verification embeds (title, description, role, webhook, expiration)

### Rate Limiting & Security

- Express rate limiter with IP-based throttling
- Separate, stricter rate limits for verification endpoints
- Cloudflare IP range trust proxy configuration
- Helmet security headers
- CORS configured for credentials
- Cookie-based session tokens with HTTP-only flags

## External Dependencies

### Third-Party Services

**Discord API**:
- Bot API for sending messages, managing roles, handling interactions
- OAuth2 for user authentication and admin login
- Webhook API for optional verification event logging

**ipapi.is**:
- IP geolocation and proxy/VPN detection service
- Requires API key (IPAPI_API_KEY environment variable)
- Rate limits apply based on subscription tier

### Database

**PostgreSQL** (via Prisma):
- Primary data store for all entities
- Connection via DATABASE_URL environment variable
- Prisma migrations for schema management

### Development & Deployment

**Build Tools**:
- TypeScript compiler for backend
- Vite for frontend bundling
- Prisma CLI for database migrations

**Runtime Dependencies**:
- Node.js for server execution
- npm for package management

**Environment Configuration**:
- `.env` file for sensitive credentials
- Required variables: Discord tokens, database URL, ipapi.is key, OAuth redirect URIs
- Optional: custom port, host, base URL

**Deployment Script**:
- `deploy.sh` handles environment setup and deployment
- Supports both production (`npm start`) and development (`npm run dev`) modes
- Includes database migration steps