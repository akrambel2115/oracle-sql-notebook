# Security Policy

## Supported Versions
- Current development branch is supported.

## Reporting a Vulnerability
1. Do not open a public issue for sensitive vulnerabilities.
2. Report security findings to the project maintainer privately.
3. Include reproduction steps, affected version, and impact.

## Security Controls in This Extension
- Passwords are stored in VS Code SecretStorage, not in settings or notebooks.
- Execution and credential operations are restricted in untrusted workspaces.
- Logged messages and surfaced errors are redacted for common secret patterns.
- SQL safety policy supports read-only mode and blocked statement prefixes.

## Operational Guidance
- Use least-privilege database users for notebook execution.
- Prefer non-production environments for exploratory queries.
- Keep dependencies and VS Code up to date.
