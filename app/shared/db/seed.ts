import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const defaultAgents = [
  {
    type: 'pr_impact',
    name: 'PR Impact Agent',
    description: 'Analyzes brand sentiment and PR impact across media coverage',
    icon: 'trending-up',
    color: '#0078D4',
    capabilities: ['sentiment_analysis', 'theme_classification', 'entity_extraction'],
    isDefault: true,
  },
  {
    type: 'media_monitoring',
    name: 'Media Monitoring Agent',
    description: 'Tracks brand mentions across news, social, and broadcast channels',
    icon: 'eye',
    color: '#00B7C3',
    capabilities: ['mention_tracking', 'source_aggregation'],
    isDefault: true,
  },
  {
    type: 'media_measurement',
    name: 'Media Measurement Agent',
    description: 'Measures reach, engagement, and AVE across all media touchpoints',
    icon: 'bar-chart',
    color: '#107C10',
    capabilities: ['reach_measurement', 'engagement_metrics'],
    isDefault: true,
  },
  {
    type: 'reputation_index',
    name: 'Reputation Index Agent',
    description: 'Calculates and tracks brand reputation index over time',
    icon: 'shield',
    color: '#7B2F8A',
    capabilities: ['reputation_scoring', 'trend_analysis'],
    isDefault: true,
  },
  {
    type: 'crisis_management',
    name: 'Crisis Management Agent',
    description: 'Detects emerging crises and recommends response strategies',
    icon: 'alert',
    color: '#D13438',
    capabilities: ['anomaly_detection', 'crisis_classification', 'response_recommendation'],
    isDefault: true,
  },
] as const;

// Each user gets its own password — admin/prod users must not share the shared
// test password. Hashing happens per-user inside the seed loop.
const seedUsers = [
  { email: 'user-a@test.local',           password: 'Password123!', displayName: 'Alice (test)', role: 'analyst' as const },
  { email: 'user-b@test.local',           password: 'Password123!', displayName: 'Bob (test)',   role: 'analyst' as const },
  { email: 'khadar.syed@infovision.com',  password: 'Admin@123123', displayName: 'Khadar Syed',  role: 'admin'   as const },
] as const;

async function main(): Promise<void> {
  console.log(`Seeding ${defaultAgents.length} default agents...`);
  for (const agent of defaultAgents) {
    await prisma.agent.upsert({
      where: { type: agent.type },
      update: agent,
      create: agent,
    });
  }
  console.log(`✓ Seeded ${defaultAgents.length} default agents`);

  // Seed users — `users` has FORCE ROW LEVEL SECURITY (set in the add_rls
  // migration) and no INSERT policy. Even the table owner cannot insert under
  // FORCE. Temporarily lift FORCE on `users` for the duration of the seed,
  // run the upserts, then restore FORCE. The seed connection user must be the
  // table owner (it is — Prisma migrate ran as this user).
  // The `users` table is set to NO FORCE ROW LEVEL SECURITY by the
  // users_no_force_rls migration (M6) so pre-auth login lookup can read it as
  // the table owner. Re-assert NO FORCE here in case a prior seed run (or
  // anything else) left FORCE on — without this, login silently 401s on every
  // existing user. Idempotent.
  await prisma.$executeRawUnsafe('ALTER TABLE users NO FORCE ROW LEVEL SECURITY');
  console.log(`Seeding ${seedUsers.length} users...`);
  for (const user of seedUsers) {
    const hash = await bcrypt.hash(user.password, 12);
    const upserted = await prisma.user.upsert({
      where: { email: user.email },
      update: { displayName: user.displayName, passwordHash: hash, role: user.role, isActive: true },
      create: { email: user.email, passwordHash: hash, displayName: user.displayName, role: user.role },
    });
    console.log(`  ✓ ${user.email} (${user.role}) → id=${upserted.id}`);
  }
  console.log(`✓ Seeded ${seedUsers.length} users`);
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
