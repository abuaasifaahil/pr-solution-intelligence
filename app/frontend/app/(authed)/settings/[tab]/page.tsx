import { notFound } from 'next/navigation';
import { SettingsTabs } from '../../../../components/settings/SettingsTabs';
import { DataSourcesTab } from '../../../../components/settings/DataSourcesTab';
import { MCPTab } from '../../../../components/settings/MCPTab';
import { ModelTab } from '../../../../components/settings/ModelTab';
import { SkillsTab } from '../../../../components/settings/SkillsTab';
import { AgentsTab } from '../../../../components/settings/AgentsTab';
import { MyAgentsSkillsTab } from '../../../../components/settings/MyAgentsSkillsTab';

const KNOWN = [
  'data-sources',
  'mcp',
  'model',
  'skills',
  'agents',
  // M9.9 — ADR-0003 Decision 4 surface
  'my-agents-skills',
] as const;
type Tab = (typeof KNOWN)[number];

export default function SettingsTabPage({ params }: { params: { tab: string } }) {
  if (!(KNOWN as readonly string[]).includes(params.tab)) notFound();
  const tab = params.tab as Tab;
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <SettingsTabs />
      {tab === 'data-sources' && <DataSourcesTab />}
      {tab === 'mcp' && <MCPTab />}
      {tab === 'model' && <ModelTab />}
      {tab === 'skills' && <SkillsTab />}
      {tab === 'agents' && <AgentsTab />}
      {tab === 'my-agents-skills' && <MyAgentsSkillsTab />}
    </div>
  );
}
