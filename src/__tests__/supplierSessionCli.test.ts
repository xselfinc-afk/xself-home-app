/**
 * Supplier-session CLI argument parsing tests (pure helpers; importing the CLI module does not
 * run main() — it is guarded by `require.main === module`). Covers flag extraction and the
 * 20-minute default login timeout plus overrides.
 * Run: npx tsx src/__tests__/supplierSessionCli.test.ts
 */
import assert from 'node:assert/strict';
import { parseFlag, parseTimeoutMin, resolveCommand, DEFAULT_LOGIN_TIMEOUT_MIN } from '../../scripts/supplierSession';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

function main() {
  it('parseFlag extracts --source, --probe-sku and --timeout-min from a session:login argv', () => {
    const argv = ['node', 'supplierSession.ts', 'session:login', '--source=pickup', '--probe-sku=W1445P360668', '--timeout-min=20'];
    assert.equal(parseFlag(argv, 'source'), 'pickup');
    assert.equal(parseFlag(argv, 'probe-sku'), 'W1445P360668');
    assert.equal(parseFlag(argv, 'timeout-min'), '20');
  });

  it('parseFlag returns undefined for absent flags and preserves values containing "="', () => {
    const argv = ['--source=pickup', '--weird=a=b=c'];
    assert.equal(parseFlag(argv, 'missing'), undefined);
    assert.equal(parseFlag(argv, 'weird'), 'a=b=c');
  });

  it('default login timeout is 20 minutes when --timeout-min is absent', () => {
    assert.equal(DEFAULT_LOGIN_TIMEOUT_MIN, 20);
    assert.equal(parseTimeoutMin(undefined), 20);
    assert.equal(parseTimeoutMin(parseFlag(['--source=pickup'], 'timeout-min')), 20);
  });

  it('timeout override: a valid positive --timeout-min is honored and converts minutes → ms', () => {
    assert.equal(parseTimeoutMin('35'), 35);
    assert.equal(parseTimeoutMin('5'), 5);
    assert.equal(parseTimeoutMin('20') * 60_000, 1_200_000);   // the launch value: 20 min
    assert.equal(parseTimeoutMin('35') * 60_000, 2_100_000);
  });

  it('invalid or non-positive --timeout-min falls back to the 20-minute default', () => {
    for (const bad of ['0', '-4', 'abc', '', 'NaN', 'Infinity']) {
      assert.equal(parseTimeoutMin(bad), 20, `expected default for bad input "${bad}"`);
    }
  });

  it('an explicit default argument is respected by parseTimeoutMin', () => {
    assert.equal(parseTimeoutMin(undefined, 10), 10);
    assert.equal(parseTimeoutMin('0', 10), 10);
  });

  it('resolveCommand routes "session:login" to the single-session login path, distinct from the old ones', () => {
    assert.equal(resolveCommand('session:login'), 'session:login');   // → manager.loginAndPromote
    assert.notEqual(resolveCommand('session:login'), 'profile:init'); // NOT the deprecated init path
    assert.notEqual(resolveCommand('session:login'), 'session:refresh'); // NOT the old refresh path
    assert.equal(resolveCommand('profile:init'), 'profile:init');
    assert.equal(resolveCommand('session:refresh'), 'session:refresh');
    assert.equal(resolveCommand('health'), 'health');
    assert.equal(resolveCommand('browser:open'), 'browser:open');
    assert.equal(resolveCommand(undefined), 'unknown');
    assert.equal(resolveCommand('bogus'), 'unknown');
  });

  console.log(`\n${passed} passed`);
}
main();
