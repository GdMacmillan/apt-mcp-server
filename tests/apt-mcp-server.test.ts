import { describe, it, expect } from 'vitest';

// Import the formatToolResult utility from the server
// (Assume it is exported for testing; if not, we will update src/index.ts)
import { formatToolResult } from '../src/index';

describe('formatToolResult', () => {
  it('should format a successful result', () => {
    const result = formatToolResult({
      success: true,
      summary: 'Success!',
      stdout: 'output',
      stderr: '',
      logs: ['log1', 'log2']
    });
    expect(result).toHaveProperty('content');
    expect(result.content[0].text).toContain('SUCCESS');
    expect(result.content[0].text).toContain('Success!');
    expect(result.content[0].text).toContain('output');
    expect(result.content[0].text).toContain('log1');
  });

  it('should format an error result', () => {
    const result = formatToolResult({
      success: false,
      summary: 'Error!',
      stdout: '',
      stderr: 'something went wrong',
      logs: []
    });
    expect(result.content[0].text).toContain('ERROR');
    expect(result.content[0].text).toContain('Error!');
    expect(result.content[0].text).toContain('something went wrong');
  });
}); 