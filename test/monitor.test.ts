import { exec } from 'child_process';

describe('Monitor Script', () => {
  test('should run without errors', (done) => {
    exec('node dist/monitor.cjs --networks moonriver', (error, stdout, stderr) => {
      expect(error).toBeNull();
      expect(stderr).toBe('');
      expect(stdout).toContain('Monitoring');
      done();
    });
  });
});
