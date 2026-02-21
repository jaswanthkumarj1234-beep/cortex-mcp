# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

**Email**: perlajaswanthkumar@gmail.com

**Do NOT** open a public GitHub issue for security vulnerabilities.

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 1 week
- **Fix**: Within 2 weeks for critical issues

## Security Model

Cortex MCP runs **locally** on your machine. All data stays on your device.

### What We Protect

- **Memory data**: Stored in local SQLite, never transmitted externally
- **API keys**: If using optional LLM enhancement, keys are only used for direct API calls
- **Git hooks**: Run locally, fail silently, never transmit data
- **MCP protocol**: Uses stdio transport, no network exposure

### Known Considerations

- The web dashboard runs on localhost only (default port 3456)
- `better-sqlite3` is a native module compiled locally
- Optional LLM calls go to the provider's API (OpenAI/Anthropic) if configured

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Active  |
