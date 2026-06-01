import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const defaultSkills = [
  { name: 'sentiment_analysis',   description: 'Classifies content as positive / neutral / negative',          type: 'analysis',    isDefault: true },
  { name: 'theme_classification', description: 'Tags content with a controlled set of topical themes',         type: 'analysis',    isDefault: true },
  { name: 'emotion_detection',    description: 'Detects discrete emotions (joy, anger, fear, sadness, surprise)', type: 'analysis', isDefault: true },
  { name: 'entity_extraction',    description: 'Extracts people, organizations, locations, products from text', type: 'extraction', isDefault: true },
  { name: 'signal_detection',     description: 'Flags crisis / virality / regulatory signals from a stream',   type: 'detection',  isDefault: true },
  { name: 'reach_analysis',       description: 'Computes audience reach and engagement metrics per content piece', type: 'measurement', isDefault: true },
] as const;

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

// Phase 3.5 (M9.6c) — first-party `analysis_skill` rows on the new
// `composable_skills` table. These mirror the four legacy Phase 1 agent
// classes so the M9.7+ composer can refer to them by `(scope, name)`
// without needing to special-case the legacy agent dropdown. The
// manifest stays minimal — M10.5's JSONSchema work will expand it.
// Idempotent: upsert keyed on the unique (scope, user_id, workspace_id,
// name, version) index from migration 20260601100000.
const firstPartyAnalysisSkills = [
  {
    name: 'pr-impact',
    description: 'Sentiment + reach + themes for a brand over a date range',
  },
  {
    name: 'brand-sentinel',
    description: 'Continuous monitoring of brand mentions across channels',
  },
  {
    name: 'crisis-watch',
    description: 'Real-time alerting on negative-coverage spikes',
  },
  {
    name: 'competitor-tracker',
    description: 'Comparative media coverage across a brand and its peers',
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

  console.log(`Seeding ${defaultSkills.length} default skills...`);
  for (const skill of defaultSkills) {
    await prisma.skill.upsert({
      where: { name: skill.name },
      update: { description: skill.description, type: skill.type, isDefault: skill.isDefault },
      create: { ...skill, handlerConfig: {}, isActive: true },
    });
  }
  console.log(`✓ Seeded ${defaultSkills.length} default skills`);

  // ── Phase 3.5 (M9.6c) — first-party composable_skills rows ───────────
  // These power the M9.7 / Phase 5.5 SkillComposer fallback chain. The
  // seed runs as the prisma superuser so it bypasses RLS — production
  // user paths (createSkill in composable-skill.service) reject
  // first_party writes at the service layer.
  //
  // Idempotent: the unique (scope, user_id, workspace_id, name, version)
  // index has nullable columns so Prisma's `where: { … }` compound
  // can't hit it directly. We hand-roll find-then-create.
  console.log(`Seeding ${firstPartyAnalysisSkills.length} first-party composable_skills...`);
  for (const s of firstPartyAnalysisSkills) {
    const existing = await prisma.composableSkill.findFirst({
      where: { scope: 'first_party', name: s.name, version: '1.0.0' },
    });
    if (!existing) {
      await prisma.composableSkill.create({
        data: {
          name: s.name,
          version: '1.0.0',
          kind: 'analysis_skill',
          manifest: {
            description: s.description,
            model_family: 'gpt-4-tier',
          },
          scope: 'first_party',
          userId: null,
          workspaceId: null,
          trustLevel: 'first_party',
          enabled: true,
        },
      });
    }
  }
  console.log(`✓ Seeded ${firstPartyAnalysisSkills.length} first-party composable_skills`);

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
