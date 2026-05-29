import { notFound } from 'next/navigation';
import { SettingsTabs } from '../../../../components/settings/SettingsTabs';
import { DataSourcesTab } from '../../../../components/settings/DataSourcesTab';
import { MCPTab } from '../../../../components/settings/MCPTab';

const KNOWN = ['data-sources', 'mcp', 'model', 'skills', 'agents'] as const;
type Tab = (typeof KNOWN)[number];

export default function SettingsTabPage({ params }: { params: { tab: string } }) {
  if (!(KNOWN as readonly string[]).includes(params.tab)) notFound();
  const tab = params.tab as Tab;
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <SettingsTabs />
      {tab === 'data-sources' && <DataSourcesTab />}
      {tab === 'mcp' && <MCPTab />}
      {/* Other tabs filled in by M5.12 */}
    </div>
  );
}
