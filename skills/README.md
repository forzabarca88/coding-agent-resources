# Skills

Specialized skill packages for pi coding agent.

## Overview

Skills provide domain-specific knowledge and capabilities that can be used by agents. Each skill is a self-contained package that includes documentation, tools, and reference materials for a specific domain.

## Available Skills

### [codeberg-repo-management/](./codeberg-repo-management/README.md)
- **Description**: Manage Codeberg repositories via the Forgejo REST API
- **Capabilities**:
  - Repository management (create, update, delete, fork)
  - File operations (read, write, update, delete, batch)
  - Branch management (list, create, delete)
  - Pull request management (list, create, merge, verify)
  - Issue management (list, create, label)
  - Release management
  - Webhook management
  - Collaborator management
  - Tag management
- **Requirements**: Python 3.6+, network access to codeberg.org, `$CODEBERG_TOKEN` environment variable

## Skill Structure

Each skill follows this structure:

```
skill-name/
├── README.md           # Skill overview and usage
├── SKILL.md           # Skill definition (for pi integration)
├── references/        # Reference documentation
│   ├── api-docs.md    # API documentation
│   ├── guides.md      # Usage guides
│   └── examples.md    # Practical examples
└── scripts/           # Helper scripts and tools
    ├── helper.py      # API helpers
    └── utils.js       # Utility functions
```

## Using Skills

Skills are automatically available when symlinked into pi's skills directory. Reference them by name in agent tasks:

```
Use the codeberg-repo-management skill to create a new repository.
```

Or invoke them programmatically:

```javascript
subagent({
  agent: "worker",
  task: "Use codeberg-repo-management skill to fork the repository"
})
```

## Creating Skills

To create a new skill:

1. Create a directory with the skill name (lowercase, hyphen-separated)
2. Add a `SKILL.md` file with the skill definition
3. Add a `README.md` file with usage documentation
4. Create `references/` directory for documentation
5. Create `scripts/` directory for helper tools

### SKILL.md Format

```markdown
---
name: skill-name
description: Brief description of the skill
license: MIT (or other)
compatibility: Requirements and compatibility notes
---

# Skill Name

[Detailed description]

## Setup

[Setup instructions]

## Usage

[Usage examples]

## API Reference

[API documentation or reference to reference files]

## Best Practices

[Best practices and tips]
```

## Skill Integration

Skills integrate with pi through:

- **Automatic discovery**: Skills in the skills directory are automatically loaded
- **Name-based lookup**: Skills are referenced by their directory name
- **Context injection**: Skill documentation and tools are made available to agents

## Best Practices

- **Focused scope**: Each skill should have a clear, focused purpose
- **Complete documentation**: Include comprehensive documentation and examples
- **Error handling**: Provide clear error messages and handling guidance
- **Testing**: Include examples that demonstrate the skill's capabilities
- **Versioning**: Consider version compatibility in skill definitions

## See Also

- [Codeberg Repo Management Skill](./codeberg-repo-management/README.md) - Detailed documentation for the Codeberg skill
- [Main README](../README.md) - Repository overview
