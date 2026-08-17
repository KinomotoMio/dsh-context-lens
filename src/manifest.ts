/** One exact first-party contribution map, enabled only for the declared package version. */
export interface BuiltinManifestEntry {
  readonly plugin: string
  readonly version: string
  readonly label: string
  readonly sections?: readonly string[]
  readonly contexts?: readonly string[]
  readonly tools?: readonly string[]
}

const RC7 = '0.1.0-rc.7'

/** First-party DSH v0.1.0-rc.7 names. Configured/dynamic names intentionally remain unattributed. */
export const DSH_RC7_MANIFEST: readonly BuiltinManifestEntry[] = [
  {
    plugin: '@deepseek-ai/dsh-system-prompt',
    version: RC7,
    label: 'System Prompt',
    sections: ['harness:identity'],
  },
  {
    plugin: '@deepseek-ai/dsh-tools',
    version: RC7,
    label: 'Tool Registry',
    sections: ['tools:code-only', 'tools:sdk'],
    tools: ['run_code'],
  },
  {
    plugin: '@deepseek-ai/dsh-app-boot',
    version: RC7,
    label: 'App Boot',
    sections: ['harness:source'],
  },
  {
    plugin: '@deepseek-ai/dsh-web-app',
    version: RC7,
    label: 'Web App',
    sections: ['app:web-surface'],
  },
  {
    plugin: '@deepseek-ai/dsh-client-ui-deliverables',
    version: RC7,
    label: 'Deliverables UI',
    sections: ['ui:deliverable-file-references'],
  },
  {
    plugin: '@deepseek-ai/dsh-plan-mode',
    version: RC7,
    label: 'Plan Mode',
    sections: ['plan:policy'],
    tools: ['exit_plan_mode'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-ask-user',
    version: RC7,
    label: 'Ask User',
    tools: ['ask_user_question'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-bash',
    version: RC7,
    label: 'Bash',
    sections: ['tool:bash'],
    tools: ['bash'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-pwsh',
    version: RC7,
    label: 'PowerShell',
    sections: ['tool:pwsh'],
    tools: ['pwsh'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-bash-persistent',
    version: RC7,
    label: 'Persistent Bash',
    tools: ['bash'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-cordis',
    version: RC7,
    label: 'Cordis',
    sections: ['tool:cordis'],
    tools: [
      'cordis_define',
      'cordis_inspect_list',
      'cordis_inspect_query',
      'cordis_inspect_self',
      'cordis_run',
      'cordis_stop',
      'cordis_undefine',
    ],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-str-replace-editor',
    version: RC7,
    label: 'String Replace Editor',
    tools: ['str_replace_editor'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-fs',
    version: RC7,
    label: 'Filesystem',
    sections: ['tool:edit', 'tool:read', 'tool:write'],
    tools: ['edit', 'read', 'read_image', 'write'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-fs-search',
    version: RC7,
    label: 'Filesystem Search',
    sections: ['tool:glob', 'tool:grep'],
    tools: ['glob', 'grep'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-terminal',
    version: RC7,
    label: 'Terminal',
    sections: ['tool:pty'],
    tools: [
      'terminal_close',
      'terminal_list',
      'terminal_open',
      'terminal_read',
      'terminal_send',
      'terminal_signal',
    ],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-goal',
    version: RC7,
    label: 'Goals',
    sections: ['tool:goal'],
    tools: ['create_goal', 'get_goal', 'update_goal'],
  },
  {
    plugin: '@deepseek-ai/dsh-schedule',
    version: RC7,
    label: 'Schedule',
    tools: ['schedule_create', 'schedule_delete', 'schedule_list'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-lsp',
    version: RC7,
    label: 'Language Server',
    sections: ['tool:lsp'],
    tools: ['lsp'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-ralph',
    version: RC7,
    label: 'Ralph',
    sections: ['tool:ralph'],
    tools: ['ralph'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-skill',
    version: RC7,
    label: 'Skills',
    tools: ['skill'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-session-query',
    version: RC7,
    label: 'Session Query',
    sections: ['tool:session-query'],
    tools: [
      'session_event_read',
      'session_event_search',
      'session_event_trace',
      'session_search',
      'session_trace',
    ],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-subagent',
    version: RC7,
    label: 'Subagent',
    sections: ['tool:subagent', 'tool:subagent_fork'],
    tools: ['subagent', 'subagent_fork'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-subagent-control',
    version: RC7,
    label: 'Subagent Control',
    tools: ['interrupt_agent', 'list_agents', 'send_message'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-subagent-report',
    version: RC7,
    label: 'Subagent Report',
    sections: ['tool:report'],
    tools: ['report'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-jobs',
    version: RC7,
    label: 'Background Jobs',
    sections: ['tool:jobs'],
    tools: ['job_kill', 'job_list', 'job_output'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-todo',
    version: RC7,
    label: 'Todo',
    tools: ['todo_write'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-workflow',
    version: RC7,
    label: 'Workflow',
    sections: ['tool:workflow'],
    tools: ['workflow'],
  },
  {
    plugin: '@deepseek-ai/dsh-tool-web',
    version: RC7,
    label: 'Web',
    sections: ['tool:web_fetch', 'tool:web_search'],
    tools: ['web_fetch', 'web_search'],
  },
  {
    plugin: '@deepseek-ai/dsh-user-approval',
    version: RC7,
    label: 'Approval Policy',
    contexts: ['approval:policy'],
  },
  {
    plugin: '@deepseek-ai/dsh-sandbox-policy',
    version: RC7,
    label: 'Sandbox Policy',
    contexts: ['sandbox:policy'],
  },
  {
    plugin: '@deepseek-ai/dsh-subagent',
    version: RC7,
    label: 'Subagent Runtime',
    contexts: ['subagent:delegation'],
  },
]
