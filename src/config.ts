import { config } from 'dotenv';

config();

export const CONFIG = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
    clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    adminRoleId: process.env.ADMIN_ROLE_ID!,
    guildId: process.env.GUILD_ID!,
  },
  database: {
    url: process.env.DATABASE_URL!,
  },
  server: {
    port: parseInt(process.env.PORT || '5000'),
    host: process.env.HOST || '0.0.0.0',
    baseUrl: process.env.BASE_URL || 'http://localhost:5000',
  },
  ipapi: {
    apiKey: process.env.IPAPI_API_KEY!,
  },
  nodeEnv: process.env.NODE_ENV || 'development',
  logTokens: process.env.TOKEN === 'true',
};

const requiredFields = [
  'discord.token',
  'discord.clientId', 
  'discord.clientSecret',
  'discord.adminRoleId',
  'discord.guildId',
  'database.url',
  'ipapi.apiKey',
];

for (const field of requiredFields) {
  const value = field.split('.').reduce((obj, key) => obj[key], CONFIG as any);
  if (!value) {
    throw new Error(`missing required config: ${field}`);
  }
}