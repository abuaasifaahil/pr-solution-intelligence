import { PrismaClient } from '@prisma/client';

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
}

main()
  .catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
