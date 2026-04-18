import {
  DISCOVERY_ENTRIES,
  type DiscoveryEntry,
  type DiscoveryKind,
  type RelatedItemRef,
  WORKFLOW_ENTRIES,
  type WorkflowEntry,
} from './public-contract.js';

const DISCOVERY_KIND_ORDER: Record<DiscoveryKind, number> = {
  tool: 0,
  prompt: 1,
  resource: 2,
};

function compareDiscoveryEntries(left: DiscoveryEntry, right: DiscoveryEntry): number {
  const kindOrder = DISCOVERY_KIND_ORDER[left.kind] - DISCOVERY_KIND_ORDER[right.kind];
  if (kindOrder !== 0) return kindOrder;
  return left.name.localeCompare(right.name);
}

export function listDiscoveryEntries(): DiscoveryEntry[] {
  return [...DISCOVERY_ENTRIES].sort(compareDiscoveryEntries);
}

export function listWorkflowEntries(): WorkflowEntry[] {
  return WORKFLOW_ENTRIES.map((workflow) => ({
    ...workflow,
    steps: [...workflow.steps],
    recommendedTools: [...workflow.recommendedTools],
    recommendedPrompts: [...workflow.recommendedPrompts],
    relatedResources: [...workflow.relatedResources],
  }));
}

export function findDiscoveryEntry(kind: DiscoveryKind, name: string): DiscoveryEntry | undefined {
  return DISCOVERY_ENTRIES.find((entry) => entry.kind === kind && entry.name === name);
}

export function findWorkflowEntry(name: string): WorkflowEntry | undefined {
  return WORKFLOW_ENTRIES.find((workflow) => workflow.name === name);
}

const DISCOVERY_KIND_HEADINGS: Record<DiscoveryKind, string> = {
  tool: 'Tools',
  prompt: 'Prompts',
  resource: 'Resources',
};

function renderBulletList(label: string, values: readonly string[]): string[] {
  if (values.length === 0) return [];
  return [`- **${label}**: ${values.join(', ')}`];
}

function renderRelatedList(related: readonly RelatedItemRef[]): string[] {
  if (related.length === 0) return [];
  const items = related.map((ref) => `${ref.kind}:${ref.name}`).join(', ');
  return [`- **Related**: ${items}`];
}

function renderDiscoveryEntryMarkdown(entry: DiscoveryEntry): string[] {
  const lines: string[] = [
    `### ${entry.name} — ${entry.title}`,
    '',
    `- **Best for**: ${entry.bestFor}`,
    `- **When to use**: ${entry.whenToUse}`,
    `- **Returns**: ${entry.returns}`,
    ...renderBulletList('Inputs', entry.inputs),
    ...renderBulletList('Limitations', entry.limitations ?? []),
    ...renderRelatedList(entry.related),
    '',
  ];
  return lines;
}

export function renderDiscoveryCatalogMarkdown(entries: readonly DiscoveryEntry[]): string {
  const grouped = new Map<DiscoveryKind, DiscoveryEntry[]>();
  for (const entry of entries) {
    const bucket = grouped.get(entry.kind) ?? [];
    bucket.push(entry);
    grouped.set(entry.kind, bucket);
  }

  const lines: string[] = ['# Discovery Catalog', ''];
  for (const kind of ['tool', 'prompt', 'resource'] as const) {
    const bucket = grouped.get(kind);
    if (!bucket || bucket.length === 0) continue;
    lines.push(`## ${DISCOVERY_KIND_HEADINGS[kind]}`, '');
    for (const entry of bucket) {
      lines.push(...renderDiscoveryEntryMarkdown(entry));
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

function renderWorkflowEntryMarkdown(entry: WorkflowEntry): string[] {
  const lines: string[] = [
    `### ${entry.name}`,
    '',
    `- **Goal**: ${entry.goal}`,
    `- **When to use**: ${entry.whenToUse}`,
  ];
  if (entry.steps.length > 0) {
    lines.push('', '**Steps:**', '');
    entry.steps.forEach((step, index) => {
      lines.push(`${String(index + 1)}. ${step}`);
    });
  }
  lines.push(
    ...renderBulletList('Recommended tools', entry.recommendedTools),
    ...renderBulletList('Recommended prompts', entry.recommendedPrompts),
    ...renderBulletList('Related resources', entry.relatedResources),
    '',
  );
  return lines;
}

export function renderWorkflowCatalogMarkdown(entries: readonly WorkflowEntry[]): string {
  const lines: string[] = ['# Workflow Catalog', ''];
  for (const entry of entries) {
    lines.push(...renderWorkflowEntryMarkdown(entry));
  }
  return lines.join('\n').trimEnd() + '\n';
}
