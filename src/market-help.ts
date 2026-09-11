import type { Context } from 'hono'

import { MCP_TOOLS } from './mcp-tool-catalog.ts'

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export const CONNECTOR_TOOL_HELP = Object.freeze(MCP_TOOLS.map(tool =>
  Object.freeze({
    name: tool.name,
    description: tool.description,
    read_only: tool.annotations.readOnlyHint,
    requires_sign_in: tool.access !== 'public',
    maintainer_only: tool.access === 'maintainer',
    endpoints: tool.routeTemplates,
  })))

export const CONNECTOR_TOOL_HELP_HTML = CONNECTOR_TOOL_HELP.map(tool =>
  `<article class="plain-card"><h3><code>${escapeHtml(tool.name)}</code></h3><p>${tool.endpoints.map(route => `<code>${route.method} ${escapeHtml(route.path)}</code>`).join(' · ')}</p><p>${escapeHtml(tool.description)}</p></article>`,
).join('\n')

export function agentHelp(c: Context): Response {
  return c.json({
    starter: ['front_door', 'official_facts', 'help'],
    tool_count: CONNECTOR_TOOL_HELP.length,
    tools: CONNECTOR_TOOL_HELP,
    front_door: '/',
    human_help: '/help',
  })
}
