---
name: {{name}}
title: {{title}}
description: {{description}}
{{lists}}# permissions:
#   deny: []                 # tools (names, name_*, toolset:<name>, effect:<effect>) this agent may not use
#   ask: []                  # tools that always ask first
# context: [app, page, screen, view]   # the context layers it receives (default: all)
# memory: on                 # on | read | off
# maxToolSteps: 8
# welcome: …
# suggestions: [ … ]
---

<!-- The agent's instructions: who it is and how it works in this application. It composes what the application
     already has (the tools, toolsets and skills named above); it never defines tools of its own. -->

You are the {{title}} of this application. …
