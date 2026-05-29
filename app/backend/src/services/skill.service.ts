import { prisma } from '@prsi/shared/db';
import type { Prisma } from '@prsi/shared/db';
import { withUser } from '../lib/prisma-rls.js';

function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

export interface SkillView {
  skillId: string;
  name: string;
  description: string;
  type: string;
  isDefault: boolean;
  isEnabled: boolean;
}

export interface CreateCustomSkillInput {
  name: string;
  description: string;
  type: string;
  handlerConfig?: Record<string, unknown>;
}

export async function listSkillsForUser(userId: string): Promise<SkillView[]> {
  // Skills are global → fetch all active ones via prisma directly. `user_skills`
  // is scoped → fetch via withUser so RLS applies.
  const allSkills = await prisma.skill.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
  });
  const userRows = await withUser(userId, async (tx) =>
    tx.userSkill.findMany({ where: {}, select: { skillId: true, isEnabled: true } }),
  );
  const enabledMap = new Map(userRows.map((r) => [r.skillId, r.isEnabled]));
  return allSkills.map((s) => ({
    skillId: s.id,
    name: s.name,
    description: s.description,
    type: s.type,
    isDefault: s.isDefault,
    // Defaults are always enabled (locked on). Custom skills reflect the join row.
    isEnabled: s.isDefault ? true : (enabledMap.get(s.id) ?? false),
  }));
}

export async function createCustomSkill(
  userId: string, input: CreateCustomSkillInput,
): Promise<SkillView> {
  // Skill row is global — create directly via prisma.
  const skill = await prisma.skill.create({
    data: {
      name: input.name,
      description: input.description,
      type: input.type,
      handlerConfig: toJson(input.handlerConfig ?? {}),
      isDefault: false,
      isActive: true,
    },
  });
  await withUser(userId, async (tx) => {
    await tx.userSkill.create({
      data: { userId, skillId: skill.id, isEnabled: true },
    });
  });
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    type: skill.type,
    isDefault: false,
    isEnabled: true,
  };
}

export async function toggleUserSkill(
  userId: string, skillId: string, isEnabled: boolean,
): Promise<SkillView> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId } });
  if (!skill) throw new Error('Skill not found');
  if (skill.isDefault) {
    throw new Error('Default skills cannot be toggled');
  }
  const updated = await withUser(userId, async (tx) =>
    tx.userSkill.upsert({
      where: { userId_skillId: { userId, skillId } },
      update: { isEnabled },
      create: { userId, skillId, isEnabled },
    }),
  );
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    type: skill.type,
    isDefault: false,
    isEnabled: updated.isEnabled,
  };
}
