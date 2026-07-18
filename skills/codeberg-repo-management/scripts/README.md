# Scripts

Helper scripts for the Codeberg Repository Management skill.

## Overview

This directory contains utility scripts that simplify interactions with the Codeberg/Forgejo API. These scripts handle authentication, request formatting, error handling, and other common tasks.

## Available Scripts

### [cb.py](./cb.py)

The primary helper script for Codeberg API interactions.

#### Features

- **Automatic Authentication**: Reads `CODEBERG_TOKEN` from environment variables
- **Request Formatting**: Properly formats requests with headers and JSON bodies
- **Response Handling**: Parses JSON responses automatically
- **Raw Mode**: Supports non-JSON responses (e.g., raw file content)
- **Error Handling**: Provides clear error messages for API failures
- **CLI and Import Modes**: Can be used from command line or imported as a module

#### Usage

##### CLI Mode

```bash
# Basic usage: METHOD PATH [BODY]
python3 cb.py GET /user

# With JSON body
python3 cb.py POST /user/repos '{"name":"my-repo","private":false}'

# With query parameters
python3 cb.py GET /user/repos?page=2
```

##### Import Mode

```python
import sys
sys.path.insert(0, '/path/to/scripts')
from cb import cb

# Simple GET request
user = cb('GET', '/user')

# POST with JSON body
repo = cb('POST', '/user/repos', {"name": "my-repo"})

# GET with raw response (for file content)
content = cb('GET', '/repos/owner/repo/raw/file.txt', raw=True)
```

#### Function Signature

```python
def cb(method: str, path: str, body: dict = None, raw: bool = False) -> dict | str:
    """
    Make a request to the Codeberg API.
    
    Args:
        method: HTTP method (GET, POST, PUT, PATCH, DELETE)
        path: API path (e.g., '/user', '/repos/owner/repo')
        body: Request body as dict (will be JSON-encoded)
        raw: If True, return raw response text instead of parsing JSON
    
    Returns:
        Parsed JSON as dict, or raw text if raw=True
    
    Raises:
        Exception: On API errors with descriptive message
    """
```

#### Environment Variables

- `CODEBERG_TOKEN`: Your Codeberg personal access token (required)
- `CODEBERG_API_URL`: Custom API base URL (optional, defaults to `https://codeberg.org/api/v1`)

#### Error Handling

The script provides detailed error messages:

```python
try:
    result = cb('GET', '/repos/owner/nonexistent')
except Exception as e:
    print(f"Error: {e}")  # e.g., "404: Not Found - Repository not found"
```

## Script Development

### Creating New Scripts

When adding new scripts:

1. **Focus on a single purpose**: Each script should do one thing well
2. **Handle errors gracefully**: Provide clear error messages
3. **Support both CLI and import**: Make scripts usable in multiple contexts
4. **Document usage**: Include docstrings and examples
5. **Follow conventions**: Use consistent naming and structure

### Script Template

```python
#!/usr/bin/env python3
"""
Script Name

Brief description of what the script does.

Usage:
    python3 script.py [arguments]

Environment Variables:
    VAR_NAME: Description
"""

import os
import sys
import json

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cb import cb  # Import the main helper

def main():
    """Main function for CLI usage."""
    # Parse arguments
    # Call API functions
    # Output results
    pass

if __name__ == "__main__":
    main()

# Export functions for import usage
def exported_function():
    """Function that can be imported and used."""
    pass
```

## Best Practices

### Security

- **Never hardcode tokens**: Always use environment variables
- **Validate inputs**: Sanitize all user inputs
- **Handle sensitive data**: Be careful with repository content

### Performance

- **Batch operations**: Use batch endpoints when possible
- **Cache results**: Cache frequently accessed data
- **Rate limiting**: Respect API rate limits

### Reliability

- **Retry on failure**: Implement retry logic for transient failures
- **Validate responses**: Check response status and content
- **Timeout handling**: Set appropriate timeouts

## Examples

### Common Script Patterns

#### Repository Management Script

```python
#!/usr/bin/env python3
"""Create multiple repositories from a configuration file."""

import json
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cb import cb

def create_repos_from_config(config_file):
    with open(config_file) as f:
        repos = json.load(f)
    
    for repo_config in repos:
        cb('POST', '/user/repos', repo_config)
        print(f"Created: {repo_config['name']}")

if __name__ == "__main__":
    create_repos_from_config(sys.argv[1])
```

#### File Batch Upload Script

```python
#!/usr/bin/env python3
"""Upload multiple files to a repository."""

import os
import base64
import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cb import cb

def upload_files(owner, repo, branch, files_dir):
    files = []
    for filename in os.listdir(files_dir):
        filepath = os.path.join(files_dir, filename)
        with open(filepath, 'rb') as f:
            content = base64.b64encode(f.read()).decode()
        files.append({
            'operation': 'create',
            'path': filename,
            'content': content
        })
    
    cb('POST', f'/repos/{owner}/{repo}/contents', {
        'branch': branch,
        'message': 'Batch upload files',
        'files': files
    })

if __name__ == "__main__":
    upload_files(*sys.argv[1:5])
```

## See Also

- [Codeberg Skill README](../README.md) - Parent skill documentation
- [API References](../references/README.md) - API documentation and guides
- [Main README](../../../README.md) - Repository overview
