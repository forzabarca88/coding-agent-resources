# Codeberg API References

Reference documentation for the Codeberg Repository Management skill.

## Overview

This directory contains detailed reference materials for working with the Codeberg/Forgejo API, including guides, troubleshooting information, and API specifications.

## Available References

### [agent-workflow-rules.md](./agent-workflow-rules.md)
- **Purpose**: PR workflow conventions and rules for agent operations
- **Topics**:
  - No auto-merge policy
  - Testing proof requirements
  - Issue tracking conventions
  - Review workflows

### [codeberg-api-quirks.md](./codeberg-api-quirks.md)
- **Purpose**: API gotchas, error messages, and workarounds
- **Topics**:
  - Common API pitfalls
  - Error message interpretations
  - Workarounds for API limitations
  - Edge cases and special behaviors

### [codeberg-merge-verification.md](./codeberg-merge-verification.md)
- **Purpose**: Verifying PR merge success
- **Topics**:
  - Proper merge verification techniques
  - State vs. merged status
  - Common verification mistakes
  - Best practices for merge confirmation

### [codeberg-pr-branch-pitfalls.md](./codeberg-pr-branch-pitfalls.md)
- **Purpose**: PR merge and branch lifecycle pitfalls
- **Topics**:
  - Branch deletion and PR links
  - Merge strategies and their effects
  - Branch protection considerations
  - Recovery from branch-related issues

### [pr-merge-sync.md](./pr-merge-sync.md)
- **Purpose**: PR merge timing and state synchronization
- **Topics**:
  - Merge timing considerations
  - State synchronization between local and remote
  - Race conditions and how to avoid them
  - Synchronization best practices

### [swagger.v1.json](./swagger.v1.json)
- **Purpose**: Full Forgejo API schema
- **Format**: OpenAPI/Swagger JSON specification
- **Usage**: Complete reference for all API endpoints, parameters, and responses

## Using the References

### For Quick Lookups

- **API quirks**: Check `codeberg-api-quirks.md` for common issues
- **Merge problems**: See `codeberg-merge-verification.md` and `codeberg-pr-branch-pitfalls.md`
- **Workflow questions**: Refer to `agent-workflow-rules.md`

### For API Development

- Use `swagger.v1.json` as the source of truth for API specifications
- Cross-reference with the quirks documents for implementation details

### For Troubleshooting

1. Check the specific error in `codeberg-api-quirks.md`
2. Review the relevant workflow in `agent-workflow-rules.md`
3. Consult `swagger.v1.json` for endpoint details

## Reference Structure

Each reference document follows a consistent structure:

```markdown
# Title

## Overview
Brief description of the topic.

## Key Points
- Main point 1
- Main point 2
- Main point 3

## Details
### Subtopic 1
Detailed information.

### Subtopic 2
More detailed information.

## Examples
Practical examples where applicable.

## See Also
Links to related references.
```

## Contributing References

When adding new reference materials:

1. **Be specific**: Focus on a single topic or issue
2. **Include examples**: Provide code examples where applicable
3. **Cross-reference**: Link to related references
4. **Stay current**: Update references when API changes
5. **Use consistent format**: Follow the established structure

## See Also

- [Codeberg Skill README](../README.md) - Parent skill documentation
- [Skills README](../../README.md) - Skills directory documentation
- [Main README](../../../README.md) - Repository overview
