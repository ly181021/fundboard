import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../../lib/cache.js';

test('cache：TTL 内命中，过期失效', () => {
  let t = 1000;
  const cache = createCache({ now: () => t });
  cache.set('quote:110020', { nav: 1.05 }, 60_000);
  t += 59_999;
  assert.deepEqual(cache.get('quote:110020'), { nav: 1.05 });
  t += 1;
  assert.equal(cache.get('quote:110020'), undefined);
});

test('cache：不同 key 互不影响，覆盖写生效', () => {
  const cache = createCache({ now: () => 0 });
  cache.set('a', 1, 1000);
  cache.set('b', 2, 1000);
  cache.set('a', 3, 1000);
  assert.equal(cache.get('a'), 3);
  assert.equal(cache.get('b'), 2);
});
